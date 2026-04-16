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

echo "Testing planner endpoint..."
planner_resp="$(curl -sS -k -X POST "https://localhost:4000/planner/draft" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'content-type: application/json' \
  -d '{"prompt":"Test prediction fallback"}' )"

valid_flag="$(printf '%s' "${planner_resp}" | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{const j=JSON.parse(d);process.stdout.write(String(Boolean(j.flowDefinition)));});')"
if [[ "${valid_flag}" != "true" ]]; then
  echo "Smoke failed: planner did not return a flow definition proposal."
  echo "Response: ${planner_resp}"
  exit 1
fi

echo "Flowise planner smoke passed."
