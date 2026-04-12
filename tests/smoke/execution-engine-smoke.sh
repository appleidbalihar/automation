#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

engine_pid=""
integration_pid=""

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
    execution-engine) engine_pid="${pid}" ;;
    integration-service) integration_pid="${pid}" ;;
  esac
}

cleanup() {
  if [[ -n "${engine_pid}" ]]; then kill "${engine_pid}" >/dev/null 2>&1 || true; fi
  if [[ -n "${integration_pid}" ]]; then kill "${integration_pid}" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

echo "Starting execution-engine smoke dependencies..."
start_if_needed "integration-service" "http://localhost:4004/health" "/tmp/integration-smoke.log" \
  pnpm --dir "${REPO_ROOT}" --filter integration-service dev
start_if_needed "execution-engine" "http://localhost:4003/health" "/tmp/engine-smoke.log" \
  pnpm --dir "${REPO_ROOT}" --filter execution-engine dev

echo "Waiting for execution-engine health..."
for i in {1..30}; do
  if curl -sS http://localhost:4003/health >/dev/null 2>&1 && curl -sS http://localhost:4004/health >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "${i}" == "30" ]]; then
    echo "Smoke failed: execution-engine not healthy in time"
    exit 1
  fi
done

echo "Validating invalid workflow model..."
invalid_resp_code="$(curl -sS -o /tmp/engine-invalid.json -w "%{http_code}" -X POST http://localhost:4003/engine/validate-workflow \
  -H 'content-type: application/json' \
  -d '{"workflowNodes":[{"id":"node-1","name":"Node 1","order":0,"configType":"SIMPLE","approvalRequired":false,"failurePolicy":"RETRY","steps":[]}]}' )"
if [[ "${invalid_resp_code}" != "400" ]]; then
  echo "Smoke failed: expected validation failure HTTP 400, got ${invalid_resp_code}"
  cat /tmp/engine-invalid.json
  exit 1
fi

echo "Validating valid workflow model..."
valid_resp="$(curl -sS -X POST http://localhost:4003/engine/validate-workflow \
  -H 'content-type: application/json' \
  -d '{"workflowNodes":[{"id":"node-1","name":"Node 1","order":0,"configType":"SIMPLE","approvalRequired":false,"failurePolicy":"RETRY","steps":[{"id":"step-1","name":"Step 1","executionType":"SCRIPT","commandRef":"echo ok","inputVariables":{},"successCriteria":"ok","retryPolicy":{"maxRetries":1,"backoffMs":10}}]}]}' )"
valid_flag="$(printf '%s' "${valid_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(Boolean(j.valid)));});')"
if [[ "${valid_flag}" != "true" ]]; then
  echo "Smoke failed: expected valid workflow response, got: ${valid_resp}"
  exit 1
fi

echo "Running workflow to success..."
run_success_resp="$(curl -sS -X POST http://localhost:4003/engine/run \
  -H 'content-type: application/json' \
  -d '{"order":{"id":"engine-order-1","currentNodeOrder":0,"currentStepIndex":0,"failurePolicy":"RETRY"},"workflowNodes":[{"id":"node-1","name":"Node 1","order":0,"configType":"SIMPLE","approvalRequired":false,"failurePolicy":"RETRY","steps":[{"id":"step-1","name":"Step 1","executionType":"SCRIPT","commandRef":"echo ok","inputVariables":{},"successCriteria":"ok","retryPolicy":{"maxRetries":1,"backoffMs":10}}]}],"input":{"target":"device-1"}}' )"
run_success_status="$(printf '%s' "${run_success_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.result?.status||""));});')"
if [[ "${run_success_status}" != "SUCCESS" ]]; then
  echo "Smoke failed: expected SUCCESS run result, got: ${run_success_resp}"
  exit 1
fi

echo "Running workflow requiring approval..."
run_approval_resp="$(curl -sS -X POST http://localhost:4003/engine/run \
  -H 'content-type: application/json' \
  -d '{"order":{"id":"engine-order-2","currentNodeOrder":0,"currentStepIndex":0,"failurePolicy":"RETRY"},"workflowNodes":[{"id":"node-approval","name":"Approval Node","order":0,"configType":"SIMPLE","approvalRequired":true,"failurePolicy":"RETRY","steps":[{"id":"step-1","name":"Step 1","executionType":"SCRIPT","commandRef":"echo ok","inputVariables":{},"successCriteria":"ok","retryPolicy":{"maxRetries":1,"backoffMs":10}}]}],"input":{"target":"device-2"}}' )"
run_approval_status="$(printf '%s' "${run_approval_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(j.result?.status||""));});')"
if [[ "${run_approval_status}" != "PENDING_APPROVAL" ]]; then
  echo "Smoke failed: expected PENDING_APPROVAL result, got: ${run_approval_resp}"
  exit 1
fi

echo "Execution-engine smoke passed."
