#!/usr/bin/env bash
# scripts/generate-runtime-env.sh
#
# Reads ALL platform secrets from Vault for the given environment and writes
# them to a secure, ephemeral .env.runtime file for docker-compose.
#
# The runtime file is deleted immediately after 'docker compose up' starts.
# Credentials never live on disk longer than the deploy window.
#
# Usage:
#   ENVIRONMENT=dev  bash scripts/generate-runtime-env.sh
#   ENVIRONMENT=prod bash scripts/generate-runtime-env.sh
#
# Options (environment variables):
#   ENVIRONMENT      dev | prod  (required)
#   VAULT_ADDR       Vault address (default: http://localhost:8200)
#   APPROLE_DIR      Path to approle credentials directory
#                    (default: /vault/file/approle  — inside vault_data volume)
#   OUTPUT_FILE      Where to write the env file (default: .env.runtime)
#                    Recommended: use a tmpfs path, e.g. /run/platform-secrets/.env.runtime
#
# Full deploy workflow:
#   ENVIRONMENT=dev bash scripts/generate-runtime-env.sh
#   docker compose -f docker-compose.yml -f docker-compose.dev.yml \
#     --env-file .env --env-file .env.runtime up -d
#   shred -u .env.runtime

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:?ENVIRONMENT is required (dev or prod)}"
if [[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "ERROR: ENVIRONMENT must be 'dev' or 'prod'" >&2; exit 1
fi

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
APPROLE_DIR="${APPROLE_DIR:-}"
OUTPUT_FILE="${OUTPUT_FILE:-.env.runtime}"

if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl is required" >&2; exit 1; fi
if ! command -v jq >/dev/null 2>&1; then echo "ERROR: jq is required" >&2; exit 1; fi

# Locate the approle credentials directory
if [[ -z "${APPROLE_DIR}" ]]; then
  # Try common paths: docker volume mount or host path
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
  echo "Example: APPROLE_DIR=/var/lib/docker/volumes/09_automationplatform_vault_data/_data/approle" >&2
  exit 1
fi

ROLE_ID="$(cat "${APPROLE_DIR}/deploy-${ENVIRONMENT}/role_id")"
SECRET_ID="$(cat "${APPROLE_DIR}/deploy-${ENVIRONMENT}/secret_id")"

# Authenticate with Vault via AppRole
echo "Authenticating with Vault (deploy-${ENVIRONMENT} AppRole)..."
VAULT_TOKEN="$(curl -sS -X POST \
  -H "Content-Type: application/json" \
  --data "{\"role_id\": \"${ROLE_ID}\", \"secret_id\": \"${SECRET_ID}\"}" \
  "${VAULT_ADDR}/v1/auth/approle/login" | jq -r '.auth.client_token')"

if [[ -z "${VAULT_TOKEN}" || "${VAULT_TOKEN}" == "null" ]]; then
  echo "ERROR: Vault AppRole login failed for deploy-${ENVIRONMENT}" >&2
  exit 1
fi

# Read a field from a Vault KV v2 path
vault_field() {
  local path="$1" field="$2"
  local value
  value="$(curl -sS \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    "${VAULT_ADDR}/v1/secret/data/platform/${ENVIRONMENT}/${path}" \
    | jq -r ".data.data.${field}")"
  if [[ -z "${value}" || "${value}" == "null" ]]; then
    echo "ERROR: Missing field '${field}' at platform/${ENVIRONMENT}/${path}" >&2
    echo "Run: VAULT_TOKEN=<root-token> bash infra/vault/seed-secrets.${ENVIRONMENT}.sh" >&2
    curl -sS -X POST -H "X-Vault-Token: ${VAULT_TOKEN}" "${VAULT_ADDR}/v1/auth/token/revoke-self" >/dev/null 2>&1 || true
    exit 1
  fi
  echo "${value}"
}

echo "Reading secrets from Vault (platform/${ENVIRONMENT}/)..."

PG_USER="$(vault_field "infra/postgres/config" "user")"
PG_PASS="$(vault_field "infra/postgres/config" "password")"
PG_DB="$(vault_field "infra/postgres/config" "db")"

REDIS_PASS="$(vault_field "infra/redis/config" "password")"

RMQ_USER="$(vault_field "infra/rabbitmq/config" "username")"
RMQ_PASS="$(vault_field "infra/rabbitmq/config" "password")"

OS_PASS="$(vault_field "infra/opensearch/config" "admin_password")"

MINIO_AK="$(vault_field "infra/minio/config" "access_key")"
MINIO_SK="$(vault_field "infra/minio/config" "secret_key")"

KC_ADMIN="$(vault_field "infra/keycloak/config" "admin_password")"
KC_SECRET="$(vault_field "infra/keycloak/config" "client_secret")"
KC_PLATFORM_ADMIN="$(vault_field "infra/keycloak/config" "platform_admin_password")"
OAUTH_SECRET="$(vault_field "infra/keycloak/config" "platform_oauth_secret")"

DIFY_SK="$(vault_field "app/dify/config" "secret_key")"
DIFY_DB_PASS="$(vault_field "app/dify/config" "db_password")"
DIFY_REDIS_PASS="$(vault_field "app/dify/config" "redis_password")"

N8N_ENC="$(vault_field "app/n8n/config" "encryption_key")"
N8N_DB_PASS="$(vault_field "app/n8n/config" "db_password")"
N8N_WEBHOOK="$(vault_field "app/n8n/config" "webhook_token")"

# Revoke the short-lived token immediately — credentials are already in memory
curl -sS -X POST -H "X-Vault-Token: ${VAULT_TOKEN}" \
  "${VAULT_ADDR}/v1/auth/token/revoke-self" >/dev/null 2>&1 || true

# Write runtime env file with chmod 600 (umask 077 prevents world-readable creation)
umask 077
cat > "${OUTPUT_FILE}" <<EOF
# Auto-generated from Vault at $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Environment: ${ENVIRONMENT}
# DO NOT COMMIT — delete immediately after 'docker compose up'

# ── PostgreSQL ─────────────────────────────────────────────────────────────────
POSTGRES_USER=${PG_USER}
POSTGRES_PASSWORD=${PG_PASS}
POSTGRES_DB=${PG_DB}
DATABASE_URL=postgresql://${PG_USER}:${PG_PASS}@postgres:5432/${PG_DB}?schema=public&sslmode=verify-full&sslrootcert=/tls/ca.pem

# ── Redis ──────────────────────────────────────────────────────────────────────
REDIS_PASSWORD=${REDIS_PASS}
REDIS_URL=rediss://:${REDIS_PASS}@redis:6379

# ── RabbitMQ ───────────────────────────────────────────────────────────────────
RABBITMQ_DEFAULT_USER=${RMQ_USER}
RABBITMQ_DEFAULT_PASS=${RMQ_PASS}
RABBITMQ_URL=amqps://${RMQ_USER}:${RMQ_PASS}@rabbitmq:5671

# ── OpenSearch ─────────────────────────────────────────────────────────────────
OPENSEARCH_INITIAL_ADMIN_PASSWORD=${OS_PASS}
OPENSEARCH_URL=https://admin:${OS_PASS}@opensearch:9200

# ── MinIO ──────────────────────────────────────────────────────────────────────
MINIO_ACCESS_KEY=${MINIO_AK}
MINIO_SECRET_KEY=${MINIO_SK}

# ── Keycloak ───────────────────────────────────────────────────────────────────
KEYCLOAK_ADMIN_PASSWORD=${KC_ADMIN}
KEYCLOAK_ADMIN_USERNAME=admin
KEYCLOAK_CLIENT_SECRET=${KC_SECRET}
KEYCLOAK_PLATFORM_ADMIN_USERNAME=platform-admin
KEYCLOAK_PLATFORM_ADMIN_PASSWORD=${KC_PLATFORM_ADMIN}
PLATFORM_OAUTH_SECRET=${OAUTH_SECRET}

# ── Dify ───────────────────────────────────────────────────────────────────────
DIFY_SECRET_KEY=${DIFY_SK}
DIFY_DB_PASSWORD=${DIFY_DB_PASS}
DIFY_REDIS_PASSWORD=${DIFY_REDIS_PASS}

# ── n8n ────────────────────────────────────────────────────────────────────────
N8N_ENCRYPTION_KEY=${N8N_ENC}
N8N_DB_PASSWORD=${N8N_DB_PASS}
N8N_WEBHOOK_TOKEN=${N8N_WEBHOOK}
EOF
chmod 600 "${OUTPUT_FILE}"

echo "Runtime env written to: ${OUTPUT_FILE} (chmod 600, Vault token revoked)"
echo ""
echo "Start services:"
if [[ "${ENVIRONMENT}" == "prod" ]]; then
  echo "  docker compose -f docker-compose.yml -f docker-compose.prod.yml \\"
  echo "    --env-file .env.production --env-file ${OUTPUT_FILE} up -d"
else
  echo "  docker compose -f docker-compose.yml -f docker-compose.dev.yml \\"
  echo "    --env-file .env --env-file ${OUTPUT_FILE} up -d"
fi
echo ""
echo "Then delete the runtime env file:"
echo "  shred -u ${OUTPUT_FILE}"
