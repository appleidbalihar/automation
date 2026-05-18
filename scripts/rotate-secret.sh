#!/usr/bin/env bash
# scripts/rotate-secret.sh
#
# Rotates one or all secrets in Vault for a given environment.
# Uses 'vault kv patch' to update a single field without touching other fields.
# Vault KV v2 retains version history (default: 10 versions) — you can roll back
# with: vault kv rollback -version=N secret/platform/<env>/<path>
#
# Usage — rotate a single field:
#   ENVIRONMENT=prod \
#   SECRET_PATH=infra/postgres/config \
#   SECRET_FIELD=password \
#   bash scripts/rotate-secret.sh
#
# Usage — rotate all fields in a path:
#   ENVIRONMENT=prod \
#   SECRET_PATH=infra/redis/config \
#   bash scripts/rotate-secret.sh
#
# Usage — rotate ALL secrets across ALL paths (full rotation):
#   ENVIRONMENT=prod ROTATE_ALL=true bash scripts/rotate-secret.sh
#
# After rotating, re-run generate-runtime-env.sh and restart affected services:
#   ENVIRONMENT=prod bash scripts/generate-runtime-env.sh
#   docker compose ... up -d --force-recreate <affected-service>
#
# NOTE: Rotating database passwords (postgres, dify-db, n8n-db) also requires
# updating the password inside the database itself. The script will print the
# exact SQL/command to run for each database credential rotated.

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:?ENVIRONMENT is required (dev or prod)}"
if [[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "ERROR: ENVIRONMENT must be 'dev' or 'prod'" >&2; exit 1
fi

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
APPROLE_DIR="${APPROLE_DIR:-}"
SECRET_PATH="${SECRET_PATH:-}"
SECRET_FIELD="${SECRET_FIELD:-}"
ROTATE_ALL="${ROTATE_ALL:-false}"

if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl is required" >&2; exit 1; fi
if ! command -v jq >/dev/null 2>&1; then echo "ERROR: jq is required" >&2; exit 1; fi
if ! command -v openssl >/dev/null 2>&1; then echo "ERROR: openssl is required" >&2; exit 1; fi

if [[ "${ROTATE_ALL}" == "false" && -z "${SECRET_PATH}" ]]; then
  echo "ERROR: Set SECRET_PATH=<path> or ROTATE_ALL=true" >&2
  echo "  Example: SECRET_PATH=infra/postgres/config SECRET_FIELD=password" >&2
  exit 1
fi

# Locate approle credentials
if [[ -z "${APPROLE_DIR}" ]]; then
  for vol_name in "rapidrag_vault_data" "09_rapidrag_vault_data" "09_automationplatform_vault_data" "$(basename "$(pwd)")_vault_data"; do
    mp="$(docker volume inspect "${vol_name}" --format '{{.Mountpoint}}' 2>/dev/null || true)"
    [[ -n "${mp}" && -f "${mp}/approle/deploy-${ENVIRONMENT}/role_id" ]] && \
      APPROLE_DIR="${mp}/approle" && break
  done
fi

if [[ -z "${APPROLE_DIR}" ]]; then
  for candidate in \
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
  exit 1
fi

ROLE_ID="$(cat "${APPROLE_DIR}/deploy-${ENVIRONMENT}/role_id")"
SECRET_ID="$(cat "${APPROLE_DIR}/deploy-${ENVIRONMENT}/secret_id")"

VAULT_TOKEN="$(curl -sS -X POST \
  -H "Content-Type: application/json" \
  --data "{\"role_id\": \"${ROLE_ID}\", \"secret_id\": \"${SECRET_ID}\"}" \
  "${VAULT_ADDR}/v1/auth/approle/login" | jq -r '.auth.client_token')"

if [[ -z "${VAULT_TOKEN}" || "${VAULT_TOKEN}" == "null" ]]; then
  echo "ERROR: Vault AppRole login failed" >&2; exit 1
fi

# vault_patch: update one or more fields in a KV v2 path without overwriting others
vault_patch() {
  local path="$1"
  local data="$2"
  local http_code
  http_code="$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/merge-patch+json" \
    --data "{\"data\": ${data}}" \
    "${VAULT_ADDR}/v1/secret/data/platform/${ENVIRONMENT}/${path}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" ]]; then
    echo "ERROR: Failed to patch secret at platform/${ENVIRONMENT}/${path} (HTTP ${http_code})" >&2
    return 1
  fi
}

# Generate a new value for a known field type
new_value_for() {
  local field="$1"
  case "${field}" in
    password|secret_key|encryption_key|webhook_token|platform_oauth_secret|client_secret)
      echo "$(openssl rand -hex 32)" ;;
    access_key)
      echo "$(openssl rand -hex 16)" ;;
    secret_key)
      echo "$(openssl rand -base64 32 | tr -d '/+=')" ;;
    admin_password)
      # OpenSearch requires complexity; prod always uses max entropy
      if [[ "${ENVIRONMENT}" == "prod" ]]; then
        echo "$(openssl rand -base64 24 | tr -d '/+=')Aa1!"
      else
        echo "Dev$(openssl rand -base64 14 | tr -d '/+=')Aa1!"
      fi
      ;;
    *)
      echo "$(openssl rand -hex 24)" ;;
  esac
}

ROTATED=()
DB_CHANGES=()

rotate_path() {
  local path="$1"
  local field_filter="$2"  # empty = rotate all fields in this path

  # Read current data
  local current
  current="$(curl -sS \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    "${VAULT_ADDR}/v1/secret/data/platform/${ENVIRONMENT}/${path}" \
    | jq -r '.data.data')"

  if [[ -z "${current}" || "${current}" == "null" ]]; then
    echo "  [SKIP] platform/${ENVIRONMENT}/${path} — not found (seed first)" >&2
    return
  fi

  local fields
  if [[ -n "${field_filter}" ]]; then
    fields=("${field_filter}")
  else
    mapfile -t fields < <(echo "${current}" | jq -r 'keys[]')
  fi

  for field in "${fields[@]}"; do
    # Skip non-secret fields (usernames, db names are not rotated)
    case "${field}" in
      user|username|db|host|port) continue ;;
    esac

    local new_val
    new_val="$(new_value_for "${field}")"
    vault_patch "${path}" "{\"${field}\": \"${new_val}\"}"
    echo "  [ROTATED] platform/${ENVIRONMENT}/${path}.${field}"
    ROTATED+=("${path}.${field}")

    # Record which database changes need manual follow-up
    case "${path}.${field}" in
      infra/postgres/config.password)
        local pg_user
        pg_user="$(echo "${current}" | jq -r '.user')"
        DB_CHANGES+=("PostgreSQL: ALTER USER ${pg_user} WITH PASSWORD '<new-value-from-Vault>';")
        ;;
      infra/redis/config.password)
        DB_CHANGES+=("Redis: docker exec redis redis-cli -a '<old-pass>' CONFIG SET requirepass '<new-value-from-Vault>'")
        ;;
      app/dify/config.db_password)
        DB_CHANGES+=("Dify DB: ALTER USER dify WITH PASSWORD '<new-value-from-Vault>';  (run inside dify-db container)")
        ;;
      app/n8n/config.db_password)
        DB_CHANGES+=("n8n DB: ALTER USER n8n WITH PASSWORD '<new-value-from-Vault>';  (run inside n8n-db container)")
        ;;
    esac
  done
}

echo ""
echo "=== Secret Rotation (env: ${ENVIRONMENT}) ==="
echo ""

if [[ "${ROTATE_ALL}" == "true" ]]; then
  ALL_PATHS=(
    "infra/postgres/config"
    "infra/redis/config"
    "infra/rabbitmq/config"
    "infra/opensearch/config"
    "infra/minio/config"
    "infra/keycloak/config"
    "app/dify/config"
    "app/n8n/config"
  )
  for p in "${ALL_PATHS[@]}"; do
    rotate_path "${p}" ""
  done
else
  rotate_path "${SECRET_PATH}" "${SECRET_FIELD}"
fi

# Revoke token
curl -sS -X POST -H "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/auth/token/revoke-self" >/dev/null 2>&1 || true

echo ""
echo "Rotated ${#ROTATED[@]} field(s). Vault token revoked."
echo ""

if [[ ${#DB_CHANGES[@]} -gt 0 ]]; then
  echo "IMPORTANT — Manual steps required to update the databases themselves:"
  echo "(Read the new value first: SHOW_VALUES=true PATH_FILTER=<path> bash scripts/list-secrets.sh)"
  echo ""
  for change in "${DB_CHANGES[@]}"; do
    echo "  * ${change}"
  done
  echo ""
fi

echo "NEXT STEPS:"
echo "  1. Re-generate the runtime env:"
echo "     ENVIRONMENT=${ENVIRONMENT} bash scripts/generate-runtime-env.sh"
echo "  2. Restart the affected services:"
echo "     docker compose ... up -d --force-recreate <service-name>"
echo ""
echo "To roll back to the previous secret version:"
echo "  vault kv rollback -version=<N> secret/platform/${ENVIRONMENT}/<path>"
