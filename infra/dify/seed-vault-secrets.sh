#!/usr/bin/env bash
# infra/dify/seed-vault-secrets.sh
#
# Seeds Dify platform secrets into Vault KV.
# Run this ONCE after Vault bootstrap before starting Dify containers.
#
# Usage:
#   VAULT_ADDR=http://localhost:8200 VAULT_TOKEN=<root-token> bash infra/dify/seed-vault-secrets.sh
#
# After running, copy the printed values to your .env file:
#   DIFY_SECRET_KEY=<value>
#   DIFY_DB_PASSWORD=<value>
#   DIFY_REDIS_PASSWORD=<value>
#
# The workflow-service reads per-KB API keys from Vault at runtime via readVaultKv().
# This script only seeds the platform-level Dify service secrets.
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
VAULT_TOKEN="${VAULT_TOKEN:?VAULT_TOKEN is required — use root token from vault-init.json}"

wait_for_vault() {
  local attempts=30
  for ((i = 1; i <= attempts; i++)); do
    status_code="$(curl -sS -o /dev/null -w "%{http_code}" "${VAULT_ADDR}/v1/sys/health" || true)"
    if [[ "${status_code}" == "200" || "${status_code}" == "429" ]]; then
      return 0
    fi
    echo "Waiting for Vault... attempt ${i}/${attempts}"
    sleep 2
  done
  echo "ERROR: Vault not reachable at ${VAULT_ADDR}" >&2
  exit 1
}

wait_for_vault

# Generate strong random secrets
DIFY_SECRET_KEY="$(openssl rand -hex 32)"
DIFY_DB_PASSWORD="dify-$(openssl rand -hex 16)"
DIFY_REDIS_PASSWORD="dify-redis-$(openssl rand -hex 16)"

# Write platform-level Dify config to Vault
# Path: secret/data/platform/global/dify/config
curl -sS -X POST \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{
    \"data\": {
      \"secret_key\": \"${DIFY_SECRET_KEY}\",
      \"db_password\": \"${DIFY_DB_PASSWORD}\",
      \"redis_password\": \"${DIFY_REDIS_PASSWORD}\"
    }
  }" \
  "${VAULT_ADDR}/v1/secret/data/platform/global/dify/config" > /dev/null

echo ""
echo "✅ Dify platform secrets seeded to Vault at secret/data/platform/global/dify/config"
echo ""
echo "Add the following to your .env file (these come from Vault — do not commit them):"
echo ""
echo "DIFY_SECRET_KEY=${DIFY_SECRET_KEY}"
echo "DIFY_DB_PASSWORD=${DIFY_DB_PASSWORD}"
echo "DIFY_REDIS_PASSWORD=${DIFY_REDIS_PASSWORD}"
echo ""
echo "To seed a per-KB Dify API key after creating a Dify app, run:"
echo "  bash infra/dify/seed-kb-api-key.sh <knowledge-base-id> <dify-app-api-key>"
