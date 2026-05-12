#!/usr/bin/env bash
# infra/vault/seed-secrets.prod.sh
#
# Seeds ALL platform infrastructure and application secrets into Vault
# under the prod environment namespace (platform/prod/*).
#
# Run ONCE on the production host after Vault bootstrap.
# Re-running is safe — Vault KV v2 creates a new version and retains history.
# To rotate an individual secret later: use scripts/rotate-secret.sh
#
# Usage:
#   VAULT_ADDR=http://localhost:8200 \
#   VAULT_TOKEN=<root-token-from-vault-init.json> \
#   bash infra/vault/seed-secrets.prod.sh
#
# SECURITY: This script does NOT print generated values. All values are
# accessible only via Vault (use scripts/list-secrets.sh SHOW_VALUES=true).
# Revoke the root token after this script completes.

set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
VAULT_TOKEN="${VAULT_TOKEN:?VAULT_TOKEN is required — use the root token from vault-init.json}"
ENV="prod"

if ! command -v curl >/dev/null 2>&1; then echo "ERROR: curl is required" >&2; exit 1; fi
if ! command -v openssl >/dev/null 2>&1; then echo "ERROR: openssl is required" >&2; exit 1; fi

wait_for_vault() {
  local attempts=30
  for ((i = 1; i <= attempts; i++)); do
    local code
    code="$(curl -sS -o /dev/null -w "%{http_code}" "${VAULT_ADDR}/v1/sys/health" 2>/dev/null || true)"
    if [[ "${code}" == "200" || "${code}" == "429" ]]; then return 0; fi
    echo "Waiting for Vault... attempt ${i}/${attempts}"
    sleep 2
  done
  echo "ERROR: Vault not reachable at ${VAULT_ADDR}" >&2
  exit 1
}

vault_write() {
  local path="$1"
  local data="$2"
  local http_code
  http_code="$(curl -sS -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "X-Vault-Token: ${VAULT_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"data\": ${data}}" \
    "${VAULT_ADDR}/v1/secret/data/platform/${ENV}/${path}")"
  if [[ "${http_code}" != "200" && "${http_code}" != "204" ]]; then
    echo "ERROR: Failed to write secret at platform/${ENV}/${path} (HTTP ${http_code})" >&2
    exit 1
  fi
}

wait_for_vault
echo "Generating production secrets and seeding Vault at ${VAULT_ADDR} ..."

# ── Infra: PostgreSQL (platform DB) ──────────────────────────────────────────
POSTGRES_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=')"
vault_write "infra/postgres/config" \
  "{\"user\": \"platform\", \"password\": \"${POSTGRES_PASSWORD}\", \"db\": \"automation\"}"

# ── Infra: Redis ──────────────────────────────────────────────────────────────
REDIS_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=')"
vault_write "infra/redis/config" \
  "{\"password\": \"${REDIS_PASSWORD}\"}"

# ── Infra: RabbitMQ ───────────────────────────────────────────────────────────
RABBITMQ_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=')"
vault_write "infra/rabbitmq/config" \
  "{\"username\": \"platform\", \"password\": \"${RABBITMQ_PASSWORD}\"}"

# ── Infra: OpenSearch ─────────────────────────────────────────────────────────
# OpenSearch 2.x password policy: min 8 chars, uppercase, lowercase, digit, special
OPENSEARCH_ADMIN_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')Aa1!"
vault_write "infra/opensearch/config" \
  "{\"admin_password\": \"${OPENSEARCH_ADMIN_PASSWORD}\"}"

# ── Infra: MinIO ──────────────────────────────────────────────────────────────
MINIO_ACCESS_KEY="$(openssl rand -hex 16)"
MINIO_SECRET_KEY="$(openssl rand -base64 32 | tr -d '/+=')"
vault_write "infra/minio/config" \
  "{\"access_key\": \"${MINIO_ACCESS_KEY}\", \"secret_key\": \"${MINIO_SECRET_KEY}\"}"

# ── Infra: Keycloak ───────────────────────────────────────────────────────────
KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=')"
KEYCLOAK_CLIENT_SECRET="$(openssl rand -hex 40)"
KEYCLOAK_PLATFORM_ADMIN_PASSWORD="$(openssl rand -base64 32 | tr -d '/+=')"
PLATFORM_OAUTH_SECRET="$(openssl rand -hex 40)"
vault_write "infra/keycloak/config" \
  "{\"admin_password\": \"${KEYCLOAK_ADMIN_PASSWORD}\", \"client_secret\": \"${KEYCLOAK_CLIENT_SECRET}\", \"platform_admin_password\": \"${KEYCLOAK_PLATFORM_ADMIN_PASSWORD}\", \"platform_oauth_secret\": \"${PLATFORM_OAUTH_SECRET}\"}"

# ── App: Dify ─────────────────────────────────────────────────────────────────
DIFY_SECRET_KEY="$(openssl rand -hex 40)"
DIFY_DB_PASSWORD="$(openssl rand -base64 28 | tr -d '/+=')"
DIFY_REDIS_PASSWORD="$(openssl rand -base64 28 | tr -d '/+=')"
vault_write "app/dify/config" \
  "{\"secret_key\": \"${DIFY_SECRET_KEY}\", \"db_password\": \"${DIFY_DB_PASSWORD}\", \"redis_password\": \"${DIFY_REDIS_PASSWORD}\"}"

# ── App: n8n ──────────────────────────────────────────────────────────────────
N8N_ENCRYPTION_KEY="$(openssl rand -hex 40)"
N8N_DB_PASSWORD="$(openssl rand -base64 28 | tr -d '/+=')"
N8N_WEBHOOK_TOKEN="$(openssl rand -hex 40)"
vault_write "app/n8n/config" \
  "{\"encryption_key\": \"${N8N_ENCRYPTION_KEY}\", \"db_password\": \"${N8N_DB_PASSWORD}\", \"webhook_token\": \"${N8N_WEBHOOK_TOKEN}\"}"

echo ""
echo "All production secrets seeded to Vault (8 paths under platform/prod/)."
echo ""
echo "NEXT STEPS:"
echo "  1. Verify:  bash scripts/list-secrets.sh  (ENVIRONMENT=prod)"
echo "  2. Revoke root token: vault token revoke \${VAULT_TOKEN}"
echo "  3. Generate runtime env: ENVIRONMENT=prod bash scripts/generate-runtime-env.sh"
