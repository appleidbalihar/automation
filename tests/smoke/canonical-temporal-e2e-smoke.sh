#!/usr/bin/env bash
set -euo pipefail

echo "Obtaining Keycloak access token..."
AUTH_RESPONSE=$(curl -sS -k -X POST \
  -d "client_id=automation-web" \
  -d "username=platform-admin" \
  -d "password=admin123" \
  -d "grant_type=password" \
  "https://localhost:8443/realms/automation-platform/protocol/openid-connect/token")

TOKEN=$(printf '%s' "${AUTH_RESPONSE}" | grep -o '"access_token":"[^"]*' | cut -d'"' -f4)

if [[ -z "${TOKEN}" ]]; then
  echo "Failed to obtain auth token"
  echo "Response: ${AUTH_RESPONSE}"
  exit 1
fi

echo "Creating a valid v2 workflow..."
create_resp="$(curl -sS -k -X POST https://localhost:4000/workflows \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"name":"Temporal Test Workflow","flowDefinition":{"schemaVersion":"v2","nodes":[{"id":"node-1","type":"task","label":"Node 1","position":{"x":100,"y":100},"config":{"nodeType":"ACTION","configType":"SIMPLE","approvalRequired":false,"approvalMode":"NONE","failurePolicy":"RETRY","steps":[{"id":"step-1","name":"Step 1","executionType":"SCRIPT","commandRef":"echo temporal-ok","inputVariables":{},"successCriteria":"ok","retryPolicy":{"maxRetries":1,"backoffMs":50}}]}}],"edges":[]}}' )"

workflow_id="$(printf '%s' "${create_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.workflow?.id||"");});')"
version_id="$(printf '%s' "${create_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.version?.id||"");});')"

if [[ -z "${workflow_id}" || -z "${version_id}" ]]; then
  echo "Failed to create workflow. Response: ${create_resp}"
  exit 1
fi
echo "Created workflow: ${workflow_id} (version ${version_id})"

echo "Publishing workflow using proper /publish path..."
publish_resp="$(curl -sS -k -X POST "https://localhost:4000/workflows/${workflow_id}/versions/${version_id}/publish" \
  -H "Authorization: Bearer ${TOKEN}")"

pub_version_id="$(printf '%s' "${publish_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.version?.id||"");});')"

if [[ -z "${pub_version_id}" ]]; then
  echo "Failed to publish workflow. Response: ${publish_resp}"
  exit 1
fi
echo "Successfully published workflow version: ${pub_version_id}"

echo "Executing order via Temporal path..."
execute_resp="$(curl -sS -k -X POST "https://localhost:4000/orders/execute" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -d "{\"workflowVersionId\":\"${pub_version_id}\",\"input\":{\"device\":\"edge-1\"}}" )"

order_id="$(printf '%s' "${execute_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.orderId||"");});')"
order_status="$(printf '%s' "${execute_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(j.result?.status||"");});')"

if [[ -z "${order_id}" || "${order_status}" != "SUCCESS" ]]; then
  echo "Smoke failed: expected SUCCESS order execution via Temporal, got: ${execute_resp}"
  exit 1
fi

echo "Canonical Temporal e2e smoke passed."
