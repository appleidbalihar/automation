#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_URL="${DATABASE_URL:-postgresql://platform:platform@localhost:5432/automation?schema=public}"
export AUTH_ALLOW_LEGACY_BEARER="${AUTH_ALLOW_LEGACY_BEARER:-true}"

echo "Starting required infrastructure..."
docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d postgres rabbitmq >/dev/null

echo "Applying latest prisma migrations..."
DATABASE_URL="${DATABASE_URL}" pnpm --dir "${REPO_ROOT}" --filter @platform/db exec prisma migrate deploy >/dev/null

workflow_pid=""
order_pid=""
logging_pid=""
gateway_pid=""

start_if_needed() {
  local name="$1"
  local health_url="$2"
  local logfile="$3"
  shift 3
  if curl -sS "${health_url}" >/dev/null 2>&1; then
    echo "Reusing already-running ${name}..."
    return 0
  fi
  echo "Starting ${name}..."
  "$@" >"${logfile}" 2>&1 &
  local pid=$!
  case "${name}" in
    workflow-service) workflow_pid="${pid}" ;;
    order-service) order_pid="${pid}" ;;
    logging-service) logging_pid="${pid}" ;;
    api-gateway) gateway_pid="${pid}" ;;
  esac
}

echo "Starting services for recovery smoke..."
start_if_needed "workflow-service" "http://localhost:4001/health" "/tmp/recovery-smoke-workflow.log" \
  pnpm --dir "${REPO_ROOT}" --filter workflow-service dev
start_if_needed "order-service" "http://localhost:4002/health" "/tmp/recovery-smoke-order.log" \
  pnpm --dir "${REPO_ROOT}" --filter order-service dev
start_if_needed "logging-service" "http://localhost:4005/health" "/tmp/recovery-smoke-logging.log" \
  pnpm --dir "${REPO_ROOT}" --filter logging-service dev
start_if_needed "api-gateway" "http://localhost:4000/health" "/tmp/recovery-smoke-gateway.log" \
  pnpm --dir "${REPO_ROOT}" --filter api-gateway dev

cleanup() {
  if [[ -n "${workflow_pid}" ]]; then kill "${workflow_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${order_pid}" ]]; then kill "${order_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${logging_pid}" ]]; then kill "${logging_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${gateway_pid}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "Waiting for service health..."
for i in {1..50}; do
  wf_ok=0
  ord_ok=0
  log_ok=0
  gw_ok=0
  if curl -sS http://localhost:4001/health >/dev/null 2>&1; then wf_ok=1; fi
  if curl -sS http://localhost:4002/health >/dev/null 2>&1; then ord_ok=1; fi
  if curl -sS http://localhost:4005/health >/dev/null 2>&1; then log_ok=1; fi
  if curl -sS http://localhost:4000/health >/dev/null 2>&1; then gw_ok=1; fi
  if [[ "${wf_ok}" == "1" && "${ord_ok}" == "1" && "${log_ok}" == "1" && "${gw_ok}" == "1" ]]; then
    break
  fi
  sleep 1
  if [[ "${i}" == "50" ]]; then
    echo "Smoke failed: services were not healthy in time"
    exit 1
  fi
done

echo "Creating workflow..."
workflow_resp="$(curl -sS -X POST http://localhost:4000/workflows \
  -H 'authorization: Bearer smoke-admin:admin' \
  -H 'content-type: application/json' \
  -d '{"name":"Recovery Smoke Workflow","description":"Gateway recovery smoke","nodes":[{"id":"node-1","name":"Node 1","order":0,"configType":"SIMPLE","approvalRequired":false,"failurePolicy":"RETRY","steps":[{"id":"step-1","name":"Step 1","executionType":"SCRIPT","commandRef":"echo smoke","inputVariables":{},"successCriteria":"ok","retryPolicy":{"maxRetries":1,"backoffMs":50}}]}]}')"

workflow_id="$(printf '%s' "${workflow_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.workflow?.id||"");});')"
if [[ -z "${workflow_id}" ]]; then
  echo "Smoke failed: workflow creation response invalid: ${workflow_resp}"
  exit 1
fi

echo "Publishing workflow..."
publish_resp="$(curl -sS -X POST "http://localhost:4000/workflows/${workflow_id}/publish" \
  -H 'authorization: Bearer smoke-admin:admin')"
workflow_version_id="$(printf '%s' "${publish_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.version?.id||"");});')"
if [[ -z "${workflow_version_id}" ]]; then
  echo "Smoke failed: workflow publish response invalid: ${publish_resp}"
  exit 1
fi

echo "Executing order..."
execute_resp="$(curl -sS -X POST http://localhost:4000/orders/execute \
  -H 'authorization: Bearer smoke-admin:admin' \
  -H 'content-type: application/json' \
  -d "{\"workflowVersionId\":\"${workflow_version_id}\",\"input\":{\"device\":\"edge-1\"},\"initiatedBy\":\"smoke-admin\"}")"
order_id="$(printf '%s' "${execute_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.orderId||"");});')"
if [[ -z "${order_id}" ]]; then
  echo "Smoke failed: order execute response invalid: ${execute_resp}"
  exit 1
fi

echo "Rolling back order..."
rollback_resp="$(curl -sS -X POST "http://localhost:4000/orders/${order_id}/rollback" \
  -H 'authorization: Bearer smoke-admin:admin')"
rollback_status="$(printf '%s' "${rollback_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.status||"");});')"
if [[ "${rollback_status}" != "ROLLED_BACK" ]]; then
  echo "Smoke failed: rollback response invalid: ${rollback_resp}"
  exit 1
fi

echo "Retrying order..."
retry_resp="$(curl -sS -X POST "http://localhost:4000/orders/${order_id}/retry" \
  -H 'authorization: Bearer smoke-admin:admin')"
retry_status="$(printf '%s' "${retry_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.status||"");});')"
if [[ "${retry_status}" != "RETRY_COMPLETED" ]]; then
  echo "Smoke failed: retry response invalid: ${retry_resp}"
  exit 1
fi

echo "Checking timeline transitions..."
timeline_resp="$(curl -sS "http://localhost:4000/logs/timeline?orderId=${order_id}" \
  -H 'authorization: Bearer smoke-viewer:viewer')"

transition_summary="$(printf '%s' "${timeline_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const toStates=(j.events||[]).filter((e)=>e.type==="STATUS_TRANSITION").map((e)=>e.data?.to||"");process.stdout.write(toStates.join(","));});')"

if [[ "${transition_summary}" != *"RUNNING"* || "${transition_summary}" != *"ROLLING_BACK"* || "${transition_summary}" != *"ROLLED_BACK"* ]]; then
  echo "Smoke failed: expected transitions missing. got: ${transition_summary}"
  exit 1
fi

echo "Order recovery timeline smoke passed."
