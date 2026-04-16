#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATABASE_URL="${DATABASE_URL:-postgresql://platform:platform@localhost:5432/automation?schema=public}"

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

cleanup() {
  if [[ -n "${workflow_pid}" ]]; then kill "${workflow_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${order_pid}" ]]; then kill "${order_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${logging_pid}" ]]; then kill "${logging_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${gateway_pid}" ]]; then kill "${gateway_pid}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "Starting required infrastructure..."
docker compose -f "${REPO_ROOT}/docker-compose.yml" up -d postgres rabbitmq >/dev/null

echo "Applying latest prisma migrations..."
DATABASE_URL="${DATABASE_URL}" pnpm --dir "${REPO_ROOT}" --filter @platform/db exec prisma migrate deploy >/dev/null

echo "Starting services for RBAC/resume e2e smoke..."
start_if_needed "workflow-service" "http://localhost:4001/health" "/tmp/rbac-smoke-workflow.log" \
  pnpm --dir "${REPO_ROOT}" --filter workflow-service dev
start_if_needed "order-service" "http://localhost:4002/health" "/tmp/rbac-smoke-order.log" \
  pnpm --dir "${REPO_ROOT}" --filter order-service dev
start_if_needed "logging-service" "http://localhost:4005/health" "/tmp/rbac-smoke-logging.log" \
  pnpm --dir "${REPO_ROOT}" --filter logging-service dev
start_if_needed "api-gateway" "http://localhost:4000/health" "/tmp/rbac-smoke-gateway.log" \
  pnpm --dir "${REPO_ROOT}" --filter api-gateway dev

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

echo "Creating a workflow as admin..."
create_resp="$(curl -sS -X POST http://localhost:4000/workflows \
  -H 'authorization: Bearer smoke-admin:admin' \
  -H 'content-type: application/json' \
  -d '{"name":"RBAC Resume Smoke Workflow","description":"RBAC + resume e2e validation","flowDefinition":{"schemaVersion":"v2","nodes":[{"id":"node-1","type":"task","label":"Node 1","position":{"x":120,"y":120},"config":{"configType":"SIMPLE","approvalRequired":false,"failurePolicy":"RETRY","steps":[{"id":"step-1","name":"Step 1","executionType":"SCRIPT","commandRef":"echo ok","inputVariables":{},"successCriteria":"ok","retryPolicy":{"maxRetries":1,"backoffMs":50}},{"id":"step-2","name":"Step 2","executionType":"SCRIPT","commandRef":"fail-command","inputVariables":{},"successCriteria":"ok","retryPolicy":{"maxRetries":1,"backoffMs":50}}]}}],"edges":[]}}')"

workflow_id="$(printf '%s' "${create_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.workflow?.id||"");});')"
if [[ -z "${workflow_id}" ]]; then
  echo "Smoke failed: invalid workflow create response: ${create_resp}"
  exit 1
fi

echo "Checking RBAC denies publish for viewer..."
publish_viewer_code="$(curl -sS -o /tmp/rbac-publish-viewer.json -w "%{http_code}" -X POST "http://localhost:4000/workflows/${workflow_id}/publish" \
  -H 'authorization: Bearer smoke-viewer:viewer')"
if [[ "${publish_viewer_code}" != "403" ]]; then
  echo "Smoke failed: viewer should not publish workflow, got HTTP ${publish_viewer_code}"
  cat /tmp/rbac-publish-viewer.json
  exit 1
fi

echo "Publishing workflow as admin..."
publish_resp="$(curl -sS -X POST "http://localhost:4000/workflows/${workflow_id}/publish" \
  -H 'authorization: Bearer smoke-admin:admin')"
workflow_version_id="$(printf '%s' "${publish_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.version?.id||"");});')"
if [[ -z "${workflow_version_id}" ]]; then
  echo "Smoke failed: invalid publish response: ${publish_resp}"
  exit 1
fi

echo "Checking RBAC denies order execute for viewer..."
execute_viewer_code="$(curl -sS -o /tmp/rbac-execute-viewer.json -w "%{http_code}" -X POST http://localhost:4000/orders/execute \
  -H 'authorization: Bearer smoke-viewer:viewer' \
  -H 'content-type: application/json' \
  -d "{\"workflowVersionId\":\"${workflow_version_id}\",\"input\":{\"device\":\"edge-1\"},\"initiatedBy\":\"smoke-viewer\"}")"
if [[ "${execute_viewer_code}" != "403" ]]; then
  echo "Smoke failed: viewer should not execute order, got HTTP ${execute_viewer_code}"
  cat /tmp/rbac-execute-viewer.json
  exit 1
fi

echo "Executing order as operator..."
execute_resp="$(curl -sS -X POST http://localhost:4000/orders/execute \
  -H 'authorization: Bearer smoke-operator:operator' \
  -H 'content-type: application/json' \
  -d "{\"workflowVersionId\":\"${workflow_version_id}\",\"input\":{\"device\":\"edge-1\"},\"initiatedBy\":\"smoke-operator\"}")"

order_id="$(printf '%s' "${execute_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.orderId||"");});')"
order_status="$(printf '%s' "${execute_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.result?.status||"");});')"
if [[ -z "${order_id}" || "${order_status}" != "FAILED" ]]; then
  echo "Smoke failed: expected FAILED order execution with valid id: ${execute_resp}"
  exit 1
fi

echo "Fetching failed order details as viewer..."
order_resp="$(curl -sS "http://localhost:4000/orders/${order_id}" \
  -H 'authorization: Bearer smoke-viewer:viewer')"
current_node="$(printf '%s' "${order_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.currentNodeOrder ?? ""));});')"
current_step="$(printf '%s' "${order_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.currentStepIndex ?? ""));});')"
stored_status="$(printf '%s' "${order_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.status||"");});')"
if [[ "${stored_status}" != "FAILED" ]]; then
  echo "Smoke failed: expected stored FAILED status, got ${stored_status}"
  exit 1
fi

echo "Checking list APIs as viewer..."
orders_list_resp="$(curl -sS "http://localhost:4000/orders?limit=10" \
  -H 'authorization: Bearer smoke-viewer:viewer')"
orders_contains_created="$(printf '%s' "${orders_list_resp}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const arr=JSON.parse(d);const found=Array.isArray(arr)&&arr.some((x)=>x.id==='${order_id}');process.stdout.write(String(found));});")"
if [[ "${orders_contains_created}" != "true" ]]; then
  echo "Smoke failed: /orders did not include created order for viewer"
  exit 1
fi

approvals_resp="$(curl -sS "http://localhost:4000/orders/approvals?limit=10" \
  -H 'authorization: Bearer smoke-viewer:viewer')"
approvals_is_array="$(printf '%s' "${approvals_resp}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const arr=JSON.parse(d);process.stdout.write(String(Array.isArray(arr)));});")"
if [[ "${approvals_is_array}" != "true" ]]; then
  echo "Smoke failed: /orders/approvals did not return an array"
  exit 1
fi

echo "Requesting approval as operator..."
request_approval_resp="$(curl -sS -X POST "http://localhost:4000/orders/${order_id}/request-approval" \
  -H 'authorization: Bearer smoke-operator:operator' \
  -H 'content-type: application/json' \
  -d '{"requestedBy":"smoke-operator","comment":"please approve"}')"
request_approval_status="$(printf '%s' "${request_approval_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.status||"");});')"
if [[ "${request_approval_status}" != "PENDING_APPROVAL" ]]; then
  echo "Smoke failed: expected PENDING_APPROVAL after request, got: ${request_approval_resp}"
  exit 1
fi

echo "Checking RBAC denies approval decision for viewer..."
approve_viewer_code="$(curl -sS -o /tmp/rbac-approve-viewer.json -w "%{http_code}" -X POST "http://localhost:4000/orders/${order_id}/approve" \
  -H 'authorization: Bearer smoke-viewer:viewer' \
  -H 'content-type: application/json' \
  -d '{"decidedBy":"smoke-viewer","comment":"approve"}')"
if [[ "${approve_viewer_code}" != "403" ]]; then
  echo "Smoke failed: viewer should not approve order, got HTTP ${approve_viewer_code}"
  cat /tmp/rbac-approve-viewer.json
  exit 1
fi

echo "Rejecting approval as approver..."
reject_resp="$(curl -sS -X POST "http://localhost:4000/orders/${order_id}/reject" \
  -H 'authorization: Bearer smoke-approver:approver' \
  -H 'content-type: application/json' \
  -d '{"decidedBy":"smoke-approver","comment":"not approved"}')"
reject_status="$(printf '%s' "${reject_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.status||"");});')"
if [[ "${reject_status}" != "APPROVAL_REJECTED" ]]; then
  echo "Smoke failed: expected approval rejection, got: ${reject_resp}"
  exit 1
fi

echo "Checking RBAC denies retry for viewer..."
retry_viewer_code="$(curl -sS -o /tmp/rbac-retry-viewer.json -w "%{http_code}" -X POST "http://localhost:4000/orders/${order_id}/retry" \
  -H 'authorization: Bearer smoke-viewer:viewer')"
if [[ "${retry_viewer_code}" != "403" ]]; then
  echo "Smoke failed: viewer should not retry order, got HTTP ${retry_viewer_code}"
  cat /tmp/rbac-retry-viewer.json
  exit 1
fi

echo "Retrying order as operator..."
retry_resp="$(curl -sS -X POST "http://localhost:4000/orders/${order_id}/retry" \
  -H 'authorization: Bearer smoke-operator:operator')"
retry_node="$(printf '%s' "${retry_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.resumeFrom?.node ?? ""));});')"
retry_step="$(printf '%s' "${retry_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.resumeFrom?.step ?? ""));});')"
if [[ "${retry_node}" != "${current_node}" || "${retry_step}" != "${current_step}" ]]; then
  echo "Smoke failed: retry resumeFrom mismatch; expected ${current_node}/${current_step}, got ${retry_node}/${retry_step}"
  exit 1
fi

echo "Checking timeline contains FAILED and RUNNING transitions..."
timeline_resp="$(curl -sS "http://localhost:4000/logs/timeline?orderId=${order_id}" \
  -H 'authorization: Bearer smoke-viewer:viewer')"
transition_summary="$(printf '%s' "${timeline_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);const toStates=(j.events||[]).filter((e)=>e.type==="STATUS_TRANSITION").map((e)=>e.data?.to||"");process.stdout.write(toStates.join(","));});')"
if [[ "${transition_summary}" != *"PENDING_APPROVAL"* || "${transition_summary}" != *"FAILED"* || "${transition_summary}" != *"RUNNING"* ]]; then
  echo "Smoke failed: expected PENDING_APPROVAL, FAILED and RUNNING transitions, got: ${transition_summary}"
  exit 1
fi

echo "RBAC + resume e2e smoke passed."
