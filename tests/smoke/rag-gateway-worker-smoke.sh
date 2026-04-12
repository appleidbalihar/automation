#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_URL="${DATABASE_URL:-postgresql://platform:platform@localhost:5432/automation?schema=public}"
export AUTH_ALLOW_LEGACY_BEARER="${AUTH_ALLOW_LEGACY_BEARER:-true}"

echo "Starting postgres and rabbitmq for rag smoke..."
docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d postgres rabbitmq >/dev/null

echo "Applying latest prisma migrations..."
DATABASE_URL="${DATABASE_URL}" pnpm --dir "${REPO_ROOT}" --filter @platform/db exec prisma migrate deploy >/dev/null

echo "Starting rag-service..."
pnpm --dir "${REPO_ROOT}" --filter rag-service dev >/tmp/rag-smoke-rag.log 2>&1 &
rag_pid=$!

echo "Starting api-gateway..."
pnpm --dir "${REPO_ROOT}" --filter api-gateway dev >/tmp/rag-smoke-gateway.log 2>&1 &
gateway_pid=$!

cleanup() {
  kill "${rag_pid}" >/dev/null 2>&1 || true
  kill "${gateway_pid}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Waiting for rag-service and api-gateway health..."
for i in {1..40}; do
  rag_ok=0
  gw_ok=0
  if curl -sS http://localhost:4006/health >/dev/null 2>&1; then
    rag_ok=1
  fi
  if curl -sS http://localhost:4000/health >/dev/null 2>&1; then
    gw_ok=1
  fi
  if [[ "${rag_ok}" == "1" && "${gw_ok}" == "1" ]]; then
    break
  fi
  sleep 1
  if [[ "${i}" == "40" ]]; then
    echo "Smoke failed: rag-service/api-gateway not healthy in time"
    exit 1
  fi
done

echo "Requesting rag index through gateway..."
index_resp="$(curl -sS -X POST http://localhost:4000/rag/index \
  -H 'authorization: Bearer smoke-admin:admin' \
  -H 'content-type: application/json' \
  -d '{"source":"incident-ops","documents":2}')"

queued="$(printf '%s' "${index_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(Boolean(j.queued)));});')"
correlation_id="$(printf '%s' "${index_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.correlationId||""));});')"

if [[ "${queued}" != "true" || -z "${correlation_id}" ]]; then
  echo "Smoke failed: unexpected /rag/index response: ${index_resp}"
  exit 1
fi

echo "Waiting for worker job completion..."
job_status=""
for i in {1..40}; do
  jobs_resp="$(curl -sS http://localhost:4000/rag/jobs -H 'authorization: Bearer smoke-viewer:viewer')"
  job_status="$(printf '%s' "${jobs_resp}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const arr=JSON.parse(d);const job=arr.find((x)=>x.correlationId==='${correlation_id}');process.stdout.write(job?.status||'');});")"
  if [[ "${job_status}" == "COMPLETED" ]]; then
    break
  fi
  sleep 1
done

if [[ "${job_status}" != "COMPLETED" ]]; then
  echo "Smoke failed: worker did not complete job for correlation ${correlation_id}"
  exit 1
fi

echo "Running rag search through gateway..."
search_resp="$(curl -sS -X POST http://localhost:4000/rag/search \
  -H 'authorization: Bearer smoke-viewer:viewer' \
  -H 'content-type: application/json' \
  -d '{"query":"retry","source":"incident-ops","limit":3}')"

result_count="$(printf '%s' "${search_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(Array.isArray(j.results)?j.results.length:0));});')"

if [[ "${result_count}" == "0" ]]; then
  echo "Smoke failed: expected indexed search results but got: ${search_resp}"
  exit 1
fi

echo "RAG gateway worker smoke passed."
