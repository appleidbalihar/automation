#!/usr/bin/env bash
set -euo pipefail

VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
VAULT_TOKEN="${VAULT_TOKEN:-root}"

payload='{"data":{"token":"vault-smoke-token-123","username":"vault-user"}}'

wait_for_vault() {
  local attempts=30
  local delay_seconds=1
  local health_url="${VAULT_ADDR}/v1/sys/health"

  for ((i = 1; i <= attempts; i++)); do
    # Vault health can return 200/429/472/473 depending on state.
    status_code="$(curl -sS -o /dev/null -w "%{http_code}" "${health_url}" || true)"
    if [[ "${status_code}" == "200" || "${status_code}" == "429" || "${status_code}" == "472" || "${status_code}" == "473" ]]; then
      return 0
    fi
    sleep "${delay_seconds}"
  done

  echo "Vault was not ready at ${health_url} after ${attempts} attempts"
  return 1
}

wait_for_vault

curl -sS -X POST \
  -H "X-Vault-Token: ${VAULT_TOKEN}" \
  -H "Content-Type: application/json" \
  --data "${payload}" \
  "${VAULT_ADDR}/v1/secret/data/integration/smoke" >/dev/null

echo "Seeded Vault secret at secret/data/integration/smoke"
