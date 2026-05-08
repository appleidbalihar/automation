#!/usr/bin/env bash
# scripts/list-secrets.sh
#
# Shows what secrets are seeded in Vault for a given environment.
# By default only shows path names and field names — no values printed.
# Use SHOW_VALUES=true to reveal values (requires terminal access to Vault).
#
# Usage:
#   ENVIRONMENT=dev  bash scripts/list-secrets.sh
#   ENVIRONMENT=prod bash scripts/list-secrets.sh
#
#   # Show values for a specific path:
#   ENVIRONMENT=dev SHOW_VALUES=true PATH_FILTER=infra/postgres bash scripts/list-secrets.sh
#
#   # Show all values (careful in prod):
#   ENVIRONMENT=prod SHOW_VALUES=true bash scripts/list-secrets.sh
#
# Options:
#   ENVIRONMENT    dev | prod  (required)
#   VAULT_ADDR     Vault address (default: http://localhost:8200)
#   APPROLE_DIR    Path to approle credentials directory
#   SHOW_VALUES    true | false  (default: false)
#   PATH_FILTER    Filter to a specific sub-path (e.g. infra/postgres)

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:?ENVIRONMENT is required (dev or prod)}"
VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
APPROLE_DIR="${APPROLE_DIR:-}"
SHOW_VALUES="${SHOW_VALUES:-false}"
PATH_FILTER="${PATH_FILTER:-}"

if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl is required" >&2; exit 1; fi
if ! command -v jq >/dev/null 2>&1; then echo "ERROR: jq is required" >&2; exit 1; fi

# Locate approle credentials
if [[ -z "${APPROLE_DIR}" ]]; then
  for candidate in \
    "$(docker volume inspect "$(basename "$(pwd)")_vault_data" --format '{{.Mountpoint}}' 2>/dev/null || true)/approle" \
    "/var/lib/docker/volumes/$(basename "$(pwd)")_vault_data/_data/approle" \
    "./vault_data/approle"; do
    if [[ -f "${candidate}/deploy-${ENVIRONMENT}/role_id" ]]; then
      APPROLE_DIR="${candidate}"
      break
    fi
  done
fi

if [[ -z "${APPROLE_DIR}" || ! -f "${APPROLE_DIR}/deploy-${ENVIRONMENT}/role_id" ]]; then
  echo "ERROR: Could not find deploy-${ENVIRONMENT} AppRole credentials." >&2
  echo "Set APPROLE_DIR to the path containing deploy-${ENVIRONMENT}/role_id and secret_id." >&2
  exit 1
fi

ROLE_ID="$(cat "${APPROLE_DIR}/deploy-${ENVIRONMENT}/role_id")"
SECRET_ID="$(cat "${APPROLE_DIR}/deploy-${ENVIRONMENT}/secret_id")"

VAULT_TOKEN="$(curl -sS -X POST \
  -H "Content-Type: application/json" \
  --data "{\"role_id\": \"${ROLE_ID}\", \"secret_id\": \"${SECRET_ID}\"}" \
  "${VAULT_ADDR}/v1/auth/approle/login" | jq -r '.auth.client_token')"

if [[ -z "${VAULT_TOKEN}" || "${VAULT_TOKEN}" == "null" ]]; then
  echo "ERROR: Vault AppRole login failed for deploy-${ENVIRONMENT}" >&2
  exit 1
fi

# Known paths in the platform namespace
PATHS=(
  "infra/postgres/config"
  "infra/redis/config"
  "infra/rabbitmq/config"
  "infra/opensearch/config"
  "infra/minio/config"
  "infra/keycloak/config"
  "app/dify/config"
  "app/n8n/config"
)

echo ""
echo "=== Vault Secrets Inventory (env: ${ENVIRONMENT}) ==="
echo ""

ALL_OK=true

for path in "${PATHS[@]}"; do
  # Apply path filter if set
  if [[ -n "${PATH_FILTER}" && "${path}" != *"${PATH_FILTER}"* ]]; then
    continue
  fi

  full_path="platform/${ENVIRONMENT}/${path}"

  # Read metadata (doesn't return values — just checks existence and lists keys)
  meta_response="$(curl -sS \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    "${VAULT_ADDR}/v1/secret/metadata/${full_path}" 2>/dev/null)"

  http_code="$(curl -sS -o /dev/null -w "%{http_code}" \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    "${VAULT_ADDR}/v1/secret/metadata/${full_path}" 2>/dev/null)"

  if [[ "${http_code}" == "200" ]]; then
    if [[ "${SHOW_VALUES}" == "true" ]]; then
      data_response="$(curl -sS \
        -H "X-Vault-Token: ${VAULT_TOKEN}" \
        "${VAULT_ADDR}/v1/secret/data/${full_path}" 2>/dev/null)"
      fields="$(echo "${data_response}" | jq -r '.data.data | keys[]' | tr '\n' ', ' | sed 's/,$//')"
      echo "[OK]  ${full_path}"
      echo "${data_response}" | jq -r '.data.data | to_entries[] | "       \(.key) = \(.value)"'
    else
      data_response="$(curl -sS \
        -H "X-Vault-Token: ${VAULT_TOKEN}" \
        "${VAULT_ADDR}/v1/secret/data/${full_path}" 2>/dev/null)"
      fields="$(echo "${data_response}" | jq -r '.data.data | keys[]' | tr '\n' ', ' | sed 's/,$//')"
      echo "[OK]  ${full_path}  —  fields: ${fields}"
    fi
  else
    echo "[MISSING]  ${full_path}  (HTTP ${http_code})"
    ALL_OK=false
  fi
done

# Revoke token
curl -sS -X POST -H "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/auth/token/revoke-self" >/dev/null 2>&1 || true

echo ""
if [[ "${ALL_OK}" == "true" ]]; then
  echo "All secrets present. Ready to run: ENVIRONMENT=${ENVIRONMENT} bash scripts/generate-runtime-env.sh"
else
  echo "WARNING: Some secrets are missing. Run the seed script first:"
  echo "  VAULT_TOKEN=<root-token> bash infra/vault/seed-secrets.${ENVIRONMENT}.sh"
fi
echo ""
