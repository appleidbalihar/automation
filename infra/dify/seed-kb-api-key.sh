#!/usr/bin/env bash
# infra/dify/seed-kb-api-key.sh
#
# Writes a Dify App API key and optional n8n workflow ID into Vault for a
# specific knowledge base. The workflow-service reads this at runtime via
# readVaultKv() — the key never touches an env var or a database column.
#
# Usage:
#   VAULT_ADDR=http://localhost:8200 VAULT_TOKEN=<root-token> \
#     bash infra/dify/seed-kb-api-key.sh <knowledge-base-id> <dify-app-api-key> [n8n-workflow-id]
#
# Example:
#   bash infra/dify/seed-kb-api-key.sh clxyz123 app-abc123def456 n8n-wf-789
set -euo pipefail

KB_ID="${1:?Usage: $0 <knowledge-base-id> <dify-api-key> [n8n-workflow-id]}"
DIFY_API_KEY="${2:?Usage: $0 <knowledge-base-id> <dify-api-key> [n8n-workflow-id]}"
N8N_WORKFLOW_ID="${3:-}"

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
VAULT_TOKEN="${VAULT_TOKEN:?VAULT_TOKEN is required}"

VAULT_PATH="secret/data/platform/global/dify/${KB_ID}"

curl -sS -X POST \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "{
    \"data\": {
      \"api_key\": \"${DIFY_API_KEY}\",
      \"n8n_workflow_id\": \"${N8N_WORKFLOW_ID}\"
    }
  }" \
  "${VAULT_ADDR}/v1/${VAULT_PATH}" > /dev/null

echo "✅ API key seeded for knowledge base '${KB_ID}' at ${VAULT_PATH}"
echo "   api_key: ${DIFY_API_KEY:0:8}... (truncated)"
if [[ -n "${N8N_WORKFLOW_ID}" ]]; then
  echo "   n8n_workflow_id: ${N8N_WORKFLOW_ID}"
fi
