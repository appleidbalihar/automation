#!/usr/bin/env bash
# Ensure the RapidRAG platform admin user exists in the Keycloak platform realm.
#
# The script reads Keycloak credentials from Vault through generate-runtime-env.sh
# unless the required KEYCLOAK_* variables are already exported.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENVIRONMENT="${ENVIRONMENT:-dev}"
KEYCLOAK_URL="${KEYCLOAK_URL:-https://localhost:8443}"
KEYCLOAK_REALM="${KEYCLOAK_REALM:-automation-platform}"
KEYCLOAK_ADMIN_USERNAME="${KEYCLOAK_ADMIN_USERNAME:-admin}"
KEYCLOAK_PLATFORM_ADMIN_USERNAME="${KEYCLOAK_PLATFORM_ADMIN_USERNAME:-platform-admin}"
KEYCLOAK_PLATFORM_ADMIN_EMAIL="${KEYCLOAK_PLATFORM_ADMIN_EMAIL:-platform-admin@rapidrag.local}"
KEYCLOAK_PLATFORM_ADMIN_FIRST_NAME="${KEYCLOAK_PLATFORM_ADMIN_FIRST_NAME:-Platform}"
KEYCLOAK_PLATFORM_ADMIN_LAST_NAME="${KEYCLOAK_PLATFORM_ADMIN_LAST_NAME:-Admin}"
KEYCLOAK_PLATFORM_ADMIN_ROLE="${KEYCLOAK_PLATFORM_ADMIN_ROLE:-admin}"

RUNTIME_ENV_FILE=""

cleanup() {
  if [[ -n "${RUNTIME_ENV_FILE}" && -f "${RUNTIME_ENV_FILE}" ]]; then
    shred -u "${RUNTIME_ENV_FILE}" >/dev/null 2>&1 || rm -f "${RUNTIME_ENV_FILE}"
  fi
}
trap cleanup EXIT

if [[ -z "${KEYCLOAK_ADMIN_PASSWORD:-}" || -z "${KEYCLOAK_PLATFORM_ADMIN_PASSWORD:-}" ]]; then
  RUNTIME_ENV_FILE="/run/platform-secrets/.env.${ENVIRONMENT}.keycloak-seed"
  mkdir -p "$(dirname "${RUNTIME_ENV_FILE}")"
  ENVIRONMENT="${ENVIRONMENT}" OUTPUT_FILE="${RUNTIME_ENV_FILE}" bash "${ROOT_DIR}/scripts/generate-runtime-env.sh" >/dev/null
  # shellcheck disable=SC1090
  set -a; source "${RUNTIME_ENV_FILE}"; set +a
fi

if [[ -z "${KEYCLOAK_ADMIN_PASSWORD:-}" || -z "${KEYCLOAK_PLATFORM_ADMIN_PASSWORD:-}" ]]; then
  echo "ERROR: KEYCLOAK_ADMIN_PASSWORD and KEYCLOAK_PLATFORM_ADMIN_PASSWORD are required." >&2
  exit 1
fi

for dependency in curl jq; do
  if ! command -v "${dependency}" >/dev/null 2>&1; then
    echo "ERROR: ${dependency} is required" >&2
    exit 1
  fi
done

keycloak_json() {
  curl -sk -s "$@"
}

echo "Waiting for Keycloak at ${KEYCLOAK_URL}..."
for attempt in $(seq 1 120); do
  if keycloak_json "${KEYCLOAK_URL}/realms/master/.well-known/openid-configuration" | jq -e '.issuer' >/dev/null 2>&1; then
    break
  fi
  if [[ "${attempt}" == "120" ]]; then
    echo "ERROR: Keycloak did not become ready." >&2
    exit 1
  fi
  sleep 2
done

admin_token="$(
  keycloak_json -X POST "${KEYCLOAK_URL}/realms/master/protocol/openid-connect/token" \
    -H "content-type: application/x-www-form-urlencoded" \
    --data-urlencode "grant_type=password" \
    --data-urlencode "client_id=admin-cli" \
    --data-urlencode "username=${KEYCLOAK_ADMIN_USERNAME}" \
    --data-urlencode "password=${KEYCLOAK_ADMIN_PASSWORD}" \
    | jq -r '.access_token // empty'
)"

if [[ -z "${admin_token}" ]]; then
  echo "ERROR: Could not obtain Keycloak admin token." >&2
  exit 1
fi

user_id="$(
  keycloak_json "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${KEYCLOAK_PLATFORM_ADMIN_USERNAME}&exact=true" \
    -H "authorization: Bearer ${admin_token}" \
    | jq -r '.[0].id // empty'
)"

if [[ -z "${user_id}" ]]; then
  echo "Creating ${KEYCLOAK_PLATFORM_ADMIN_USERNAME} in realm ${KEYCLOAK_REALM}..."
  create_payload="$(
    jq -n \
      --arg username "${KEYCLOAK_PLATFORM_ADMIN_USERNAME}" \
      --arg email "${KEYCLOAK_PLATFORM_ADMIN_EMAIL}" \
      --arg firstName "${KEYCLOAK_PLATFORM_ADMIN_FIRST_NAME}" \
      --arg lastName "${KEYCLOAK_PLATFORM_ADMIN_LAST_NAME}" \
      '{username:$username,email:$email,firstName:$firstName,lastName:$lastName,enabled:true,emailVerified:true,requiredActions:[]}'
  )"
  create_code="$(
    curl -sk -s -o /dev/null -w "%{http_code}" -X POST \
      "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users" \
      -H "authorization: Bearer ${admin_token}" \
      -H "content-type: application/json" \
      --data "${create_payload}"
  )"
  if [[ "${create_code}" != "201" && "${create_code}" != "204" ]]; then
    echo "ERROR: Failed to create ${KEYCLOAK_PLATFORM_ADMIN_USERNAME} (HTTP ${create_code})." >&2
    exit 1
  fi
  user_id="$(
    keycloak_json "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?username=${KEYCLOAK_PLATFORM_ADMIN_USERNAME}&exact=true" \
      -H "authorization: Bearer ${admin_token}" \
      | jq -r '.[0].id // empty'
  )"
fi

if [[ -z "${user_id}" ]]; then
  echo "ERROR: Could not resolve ${KEYCLOAK_PLATFORM_ADMIN_USERNAME} id after create/search." >&2
  exit 1
fi

echo "Resetting password for ${KEYCLOAK_PLATFORM_ADMIN_USERNAME}..."
credential_payload="$(
  jq -n --arg password "${KEYCLOAK_PLATFORM_ADMIN_PASSWORD}" \
    '{type:"password",value:$password,temporary:false}'
)"
reset_code="$(
  curl -sk -s -o /dev/null -w "%{http_code}" -X PUT \
    "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${user_id}/reset-password" \
    -H "authorization: Bearer ${admin_token}" \
    -H "content-type: application/json" \
    --data "${credential_payload}"
)"
if [[ "${reset_code}" != "204" ]]; then
  echo "ERROR: Failed to reset password for ${KEYCLOAK_PLATFORM_ADMIN_USERNAME} (HTTP ${reset_code})." >&2
  exit 1
fi

role_payload="$(
  keycloak_json "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/roles/${KEYCLOAK_PLATFORM_ADMIN_ROLE}" \
    -H "authorization: Bearer ${admin_token}" \
    | jq '[{id:.id,name:.name}]'
)"

if [[ -z "${role_payload}" || "${role_payload}" == "null" ]]; then
  echo "ERROR: Role ${KEYCLOAK_PLATFORM_ADMIN_ROLE} was not found in realm ${KEYCLOAK_REALM}." >&2
  exit 1
fi

echo "Assigning realm role ${KEYCLOAK_PLATFORM_ADMIN_ROLE}..."
assign_code="$(
  curl -sk -s -o /dev/null -w "%{http_code}" -X POST \
    "${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${user_id}/role-mappings/realm" \
    -H "authorization: Bearer ${admin_token}" \
    -H "content-type: application/json" \
    --data "${role_payload}"
)"
if [[ "${assign_code}" != "204" && "${assign_code}" != "409" ]]; then
  echo "ERROR: Failed to assign ${KEYCLOAK_PLATFORM_ADMIN_ROLE} role (HTTP ${assign_code})." >&2
  exit 1
fi

echo "Keycloak platform admin is ready: ${KEYCLOAK_PLATFORM_ADMIN_USERNAME}"
