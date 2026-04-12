#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

export VAULT_ADDR="${VAULT_ADDR:-http://localhost:8200}"
export VAULT_TOKEN="${VAULT_TOKEN:-root}"
export INTEGRATION_SCRIPT_ALLOWLIST="${INTEGRATION_SCRIPT_ALLOWLIST:-.*}"

echo "Starting Vault container..."
docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d vault >/dev/null

echo "Seeding Vault smoke secret..."
"${REPO_ROOT}/infra/vault/seed-smoke-secret.sh"

echo "Starting integration-service for smoke run..."
pnpm --dir "${REPO_ROOT}" --filter integration-service dev >/tmp/integration-smoke.log 2>&1 &
svc_pid=$!
trap 'kill ${svc_pid} >/dev/null 2>&1 || true' EXIT

echo "Waiting for integration-service health..."
for i in {1..30}; do
  if curl -sS http://localhost:4004/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "${i}" == "30" ]]; then
    echo "Smoke failed: integration-service did not become healthy in time"
    exit 1
  fi
done

echo "Running vault-backed adapter call..."
resp="$(curl -sS -X POST http://localhost:4004/integrations/execute \
  -H 'content-type: application/json' \
  -d '{"executionType":"SCRIPT","commandRef":"cat","input":{"token":"vault:secret/data/integration/smoke#token"}}')"

status="$(printf '%s' "${resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.status||"UNKNOWN");});')"
stdout_val="$(printf '%s' "${resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.output?.stdout||""));});')"

if [[ "${status}" != "SUCCESS" ]]; then
  echo "Smoke failed: ${resp}"
  exit 1
fi

if [[ "${stdout_val}" != *"***"* ]]; then
  echo "Smoke failed: expected masked output but got: ${stdout_val}"
  exit 1
fi

echo "Vault integration smoke passed."
