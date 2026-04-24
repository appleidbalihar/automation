#!/usr/bin/env bash
# infra/n8n/seed-vault-secrets.sh
#
# Seeds n8n platform secrets into Vault KV.
# Run this ONCE after Vault bootstrap before starting n8n containers.
#
# Usage:
#   VAULT_ADDR=http://localhost:8200 VAULT_TOKEN=<root-token> bash infra/n8n/seed-vault-secrets.sh
#
# After running, copy the printed values to your .env file:
#   N8N_ENCRYPTION_KEY=<value>
#   N8N_DB_PASSWORD=<value>
#   N8N_WEBHOOK_TOKEN=<value>
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
N8N_ENCRYPTION_KEY="$(openssl rand -hex 32)"
N8N_DB_PASSWORD="n8n-$(openssl rand -hex 16)"
N8N_WEBHOOK_TOKEN="n8n-wh-$(openssl rand -hex 24)"

# Write platform-level n8n config to Vault
# Path: secret/data/platform/global/n8n/config
curl -sS -X POST \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{
    \"data\": {
      \"encryption_key\": \"${N8N_ENCRYPTION_KEY}\",
      \"db_password\": \"${N8N_DB_PASSWORD}\",
      \"webhook_token\": \"${N8N_WEBHOOK_TOKEN}\"
    }
  }" \
  "${VAULT_ADDR}/v1/secret/data/platform/global/n8n/config" > /dev/null

echo ""
echo "✅ n8n platform secrets seeded to Vault at secret/data/platform/global/n8n/config"
echo ""
echo "Add the following to your .env file (these come from Vault — do not commit them):"
echo ""
echo "N8N_ENCRYPTION_KEY=${N8N_ENCRYPTION_KEY}"
echo "N8N_DB_PASSWORD=${N8N_DB_PASSWORD}"
echo "N8N_WEBHOOK_TOKEN=${N8N_WEBHOOK_TOKEN}"
echo ""
echo "After starting n8n, open http://localhost:5679 to import workflow templates."
echo "See infra/n8n/README.md for template import instructions."
