#!/usr/bin/env sh
set -eu

VAULT_ADDR="${VAULT_ADDR:-http://vault:8200}"
VAULT_INIT_FILE="${VAULT_INIT_FILE:-/vault/file/vault-init.json}"
APPROLE_DIR="${APPROLE_DIR:-/vault/file/approle}"
PKI_ROOT_TTL="${PKI_ROOT_TTL:-87600h}"
PKI_INT_TTL="${PKI_INT_TTL:-43800h}"
PKI_LEAF_TTL="${PKI_LEAF_TTL:-8760h}"

SERVICES="
api-gateway
workflow-service
order-service
execution-engine
integration-service
logging-service
rag-service
chat-service
web
postgres
rabbitmq
redis
keycloak
minio
opensearch
"

mkdir -p "$(dirname "$VAULT_INIT_FILE")" "$APPROLE_DIR"

wait_for_vault() {
  attempts=0
  while [ "$attempts" -lt 90 ]; do
    if curl -sS "${VAULT_ADDR}/v1/sys/health" >/dev/null 2>&1; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 2
  done
  echo "Vault not reachable at ${VAULT_ADDR}" >&2
  exit 1
}

is_initialized() {
  curl -fsS "${VAULT_ADDR}/v1/sys/init" | grep -q '"initialized":true'
}

if ! command -v jq >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
  apk add --no-cache jq curl >/dev/null
fi

wait_for_vault

if ! is_initialized; then
  vault operator init -address="${VAULT_ADDR}" -key-shares=1 -key-threshold=1 -format=json >"${VAULT_INIT_FILE}"
fi

UNSEAL_KEY="$(jq -r '.unseal_keys_b64[0]' "${VAULT_INIT_FILE}")"
ROOT_TOKEN="$(jq -r '.root_token' "${VAULT_INIT_FILE}")"

vault operator unseal -address="${VAULT_ADDR}" "${UNSEAL_KEY}" >/dev/null
export VAULT_TOKEN="${ROOT_TOKEN}"

vault auth enable approle >/dev/null 2>&1 || true

vault secrets enable pki >/dev/null 2>&1 || true
vault secrets tune -max-lease-ttl="${PKI_ROOT_TTL}" pki >/dev/null

vault write -force pki/root/generate/internal common_name="Platform Root CA" ttl="${PKI_ROOT_TTL}" >/dev/null 2>&1 || true

vault secrets enable -path=pki_int pki >/dev/null 2>&1 || true
vault secrets tune -max-lease-ttl="${PKI_INT_TTL}" pki_int >/dev/null

CSR_FILE="/tmp/pki_intermediate.csr"
SIGNED_FILE="/tmp/pki_intermediate_signed.pem"
vault write -format=json pki_int/intermediate/generate/internal common_name="Platform Intermediate CA" | jq -r '.data.csr' >"${CSR_FILE}"
CSR_CONTENT="$(cat "${CSR_FILE}")"
vault write -format=json pki/root/sign-intermediate csr="${CSR_CONTENT}" format=pem_bundle ttl="${PKI_INT_TTL}" \
  | jq -r '.data.certificate' >"${SIGNED_FILE}"
SIGNED_CONTENT="$(cat "${SIGNED_FILE}")"
vault write pki_int/intermediate/set-signed certificate="${SIGNED_CONTENT}" >/dev/null

vault write pki/config/urls \
  issuing_certificates="${VAULT_ADDR}/v1/pki/ca" \
  crl_distribution_points="${VAULT_ADDR}/v1/pki/crl" >/dev/null

vault write pki_int/config/urls \
  issuing_certificates="${VAULT_ADDR}/v1/pki_int/ca" \
  crl_distribution_points="${VAULT_ADDR}/v1/pki_int/crl" >/dev/null

for service in ${SERVICES}; do
  vault write "pki_int/roles/${service}" \
    allowed_domains="${service},${service}.local,localhost" \
    allow_subdomains=true \
    allow_localhost=true \
    allow_any_name=true \
    key_type="rsa" \
    key_bits=2048 \
    max_ttl="${PKI_LEAF_TTL}" >/dev/null

  cat >/tmp/"${service}".hcl <<EOF
path "pki_int/issue/${service}" {
  capabilities = ["update"]
}
path "pki/cert/ca" {
  capabilities = ["read"]
}
path "pki_int/cert/ca" {
  capabilities = ["read"]
}
EOF

  vault policy write "${service}-pki" /tmp/"${service}".hcl >/dev/null
  vault write auth/approle/role/"${service}-role" token_policies="${service}-pki" token_ttl="1h" token_max_ttl="24h" >/dev/null

  mkdir -p "${APPROLE_DIR}/${service}"
  vault read -format=json auth/approle/role/"${service}-role"/role-id | jq -r '.data.role_id' >"${APPROLE_DIR}/${service}/role_id"
  vault write -force -format=json auth/approle/role/"${service}-role"/secret-id | jq -r '.data.secret_id' >"${APPROLE_DIR}/${service}/secret_id"
done

echo "Vault PKI bootstrap complete."
