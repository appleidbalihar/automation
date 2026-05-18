#!/usr/bin/env bash
# Reads all credentials from Vault and writes a credentials reference document.
# Output is written outside the repo to avoid accidental commits.
# Usage: ENVIRONMENT=prod bash scripts/generate-credentials-doc.sh
#        ENVIRONMENT=dev  bash scripts/generate-credentials-doc.sh

set -euo pipefail

ENVIRONMENT="${ENVIRONMENT:-dev}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_FILE="${OUTPUT_FILE:-/root/platform-credentials-${ENVIRONMENT}.md}"

# ── Vault bootstrap ────────────────────────────────────────────────────────────
VAULT_DATA_DIR=""
for vol_name in "rapidrag_vault_data" "09_rapidrag_vault_data" "09_automationplatform_vault_data" "$(basename "${REPO_ROOT}")_vault_data"; do
  mp="$(docker volume inspect "${vol_name}" --format '{{.Mountpoint}}' 2>/dev/null || true)"
  if [[ -n "${mp}" && -f "${mp}/vault-init.json" ]]; then
    VAULT_DATA_DIR="${mp}"
    break
  fi
done
if [[ -z "${VAULT_DATA_DIR}" ]]; then
  echo "ERROR: Could not find vault_data volume. Is the stack running?" >&2
  exit 1
fi

ROOT_TOKEN=$(sudo jq -r '.root_token' "${VAULT_DATA_DIR}/vault-init.json")
export VAULT_ADDR="http://localhost:8200"
export VAULT_TOKEN="${ROOT_TOKEN}"

kv_get() {
  vault kv get -format=json "secret/$1" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['data']; [print(f'{k}={v}') for k,v in sorted(d.items())]" \
    || echo "(path not found)"
}

kv_field() {
  vault kv get -format=json "secret/$1" 2>/dev/null \
    | python3 -c "import sys,json; d=json.load(sys.stdin)['data']['data']; print(d.get('$2','(not set)'))" \
    || echo "(not set)"
}

ENV="${ENVIRONMENT}"

# ── Read all secrets ────────────────────────────────────────────────────────────
KC_ADMIN_PASS=$(kv_field "platform/${ENV}/infra/keycloak/config" admin_password)
KC_PLATFORM_ADMIN_PASS=$(kv_field "platform/${ENV}/infra/keycloak/config" platform_admin_password)
MINIO_ACCESS=$(kv_field "platform/${ENV}/infra/minio/config" access_key)
MINIO_SECRET=$(kv_field "platform/${ENV}/infra/minio/config" secret_key)
OS_PASS=$(kv_field "platform/${ENV}/infra/opensearch/config" admin_password)
PG_USER=$(kv_field "platform/${ENV}/infra/postgres/config" user)
PG_PASS=$(kv_field "platform/${ENV}/infra/postgres/config" password)
PG_DB=$(kv_field "platform/${ENV}/infra/postgres/config" db)
RMQ_USER=$(kv_field "platform/${ENV}/infra/rabbitmq/config" username)
RMQ_PASS=$(kv_field "platform/${ENV}/infra/rabbitmq/config" password)
REDIS_PASS=$(kv_field "platform/${ENV}/infra/redis/config" password)

N8N_OWNER_EMAIL=$(kv_field "platform/${ENV}/app/n8n/config" owner_email)
N8N_OWNER_PASS=$(kv_field "platform/${ENV}/app/n8n/config" owner_password)
if [[ "${N8N_OWNER_EMAIL}" == "(not set)" || -z "${N8N_OWNER_EMAIL}" ]]; then
  N8N_OWNER_EMAIL="admin@platform.local"
fi

DIFY_CONSOLE_EMAIL=$(kv_field "platform/global/dify/config" console_email)
DIFY_CONSOLE_PASS=$(kv_field "platform/global/dify/config" console_password)
DIFY_APP_URL=$(kv_field "platform/global/dify/config" default_app_url)
DIFY_MODEL_PROVIDER=$(kv_field "platform/global/dify/config" model_provider)
DIFY_MODEL_BASE=$(kv_field "platform/global/dify/config" model_api_base)
DIFY_MODEL_KEY=$(kv_field "platform/global/dify/config" model_api_key)
DIFY_CHAT_MODEL=$(kv_field "platform/global/dify/config" chat_model)
DIFY_EMBED_MODEL=$(kv_field "platform/global/dify/config" embedding_model)
DIFY_DATASET_KEY=$(kv_field "platform/global/dify/config" dataset_api_key)

LLM_KEY=$(kv_field "platform/global/llm" api_key)
LLM_MODEL=$(kv_field "platform/global/llm" model)
LLM_BASE=$(kv_field "platform/global/llm" base_url)

VAULT_TOKEN_OUT="${ROOT_TOKEN}"

if [[ "${ENV}" == "prod" ]]; then
  DOMAIN="rapidrag.ai"
  WEB_URL="https://${DOMAIN}/rapidrag/"
  N8N_URL="https://${DOMAIN}/n8n/"
  DIFY_WEB_URL="https://${DOMAIN}/dify/"
  KC_URL="https://${DOMAIN}:8443"
  MINIO_URL="https://localhost:9001  (SSH tunnel required)"
  RMQ_URL="https://localhost:15671  (SSH tunnel required)"
  VAULT_UI="http://localhost:8200  (SSH tunnel required)"
  OS_URL="https://localhost:9200  (SSH tunnel required)"
  N8N_LOCAL="http://localhost:5679  (SSH tunnel required)"
  DIFY_LOCAL="http://localhost:3002  (SSH tunnel required)"
else
  DOMAIN="dev.rapidrag.ai"
  WEB_URL="https://${DOMAIN}/   or   https://localhost:3443/"
  N8N_URL="http://localhost:5679"
  DIFY_WEB_URL="http://localhost:3002"
  KC_URL="https://localhost:8443"
  MINIO_URL="https://localhost:9001"
  RMQ_URL="https://localhost:15671"
  VAULT_UI="http://localhost:8200"
  OS_URL="https://localhost:9200"
  N8N_LOCAL="${N8N_URL}"
  DIFY_LOCAL="${DIFY_WEB_URL}"
fi

DATE_NOW=$(date '+%Y-%m-%d %H:%M %Z')

# ── Write document ──────────────────────────────────────────────────────────────
cat > "${OUTPUT_FILE}" <<EOF
# Service Credentials — RapidRAG Platform (${ENV^^})

**Environment:** ${ENV}
**Domain:** ${DOMAIN}
**Generated:** ${DATE_NOW}
**Stack root:** ${REPO_ROOT}

> This file was generated by scripts/generate-credentials-doc.sh
> KEEP THIS FILE SECURE — contains plaintext credentials.
> DO NOT commit to git, send via email, or paste into Slack.

---

## Platform Application

| Service | URL | Username | Password |
|---------|-----|----------|----------|
| **RapidRAG Web UI** | ${WEB_URL} | \`platform-admin\` | \`${KC_PLATFORM_ADMIN_PASS}\` |

---

## Infrastructure Services

| Service | URL / Host | Username / Access Key | Password / Secret Key |
|---------|------------|-----------------------|----------------------|
| **Keycloak Admin Console** | ${KC_URL} | \`admin\` | \`${KC_ADMIN_PASS}\` |
| **Keycloak Platform Realm** | ${KC_URL}/realms/automation-platform | \`platform-admin\` | \`${KC_PLATFORM_ADMIN_PASS}\` |
| **Vault** | ${VAULT_UI} | root token | \`${VAULT_TOKEN_OUT}\` |
| **MinIO Console** | ${MINIO_URL} | \`${MINIO_ACCESS}\` | \`${MINIO_SECRET}\` |
| **MinIO API** | https://localhost:9000 | \`${MINIO_ACCESS}\` | \`${MINIO_SECRET}\` |
| **RabbitMQ Management** | ${RMQ_URL} | \`${RMQ_USER}\` | \`${RMQ_PASS}\` |
| **RabbitMQ AMQPS** | localhost:5671 | \`${RMQ_USER}\` | \`${RMQ_PASS}\` |
| **OpenSearch** | ${OS_URL} | \`admin\` | \`${OS_PASS}\` |
| **PostgreSQL** | localhost:5432  db=\`${PG_DB}\` | \`${PG_USER}\` | \`${PG_PASS}\` |
| **Redis** | localhost:6379 | *(no username)* | \`${REDIS_PASS}\` |

---

## Application Services

| Service | URL | Login | Password |
|---------|-----|-------|----------|
| **n8n Workflow Editor** | ${N8N_LOCAL} | \`${N8N_OWNER_EMAIL}\` | \`${N8N_OWNER_PASS}\` |
| **Dify Web UI** | ${DIFY_LOCAL} | \`${DIFY_CONSOLE_EMAIL}\` | \`${DIFY_CONSOLE_PASS}\` |
| **Dify API (internal)** | ${DIFY_APP_URL} | \`${DIFY_CONSOLE_EMAIL}\` | \`${DIFY_CONSOLE_PASS}\` |

---

## LLM Providers

### Fuelix AI — AI Agent Prompt page (\`platform/global/llm\`)

| Field | Value |
|-------|-------|
| **Base URL** | \`${LLM_BASE}\` |
| **API Key** | \`${LLM_KEY}\` |
| **Model** | \`${LLM_MODEL}\` |

### Dify Knowledge Base Provisioning (\`platform/global/dify/config\`)

| Field | Value |
|-------|-------|
| **Model Provider** | \`${DIFY_MODEL_PROVIDER}\` |
| **Model API Base** | \`${DIFY_MODEL_BASE}\` |
| **Model API Key** | \`${DIFY_MODEL_KEY}\` |
| **Chat Model** | \`${DIFY_CHAT_MODEL}\` |
| **Embedding Model** | \`${DIFY_EMBED_MODEL}\` |
| **Dataset API Key** | \`${DIFY_DATASET_KEY}\` |

---

## Port Reference

| Port | Protocol | Service |
|------|----------|---------|
| 3443 | HTTPS | Web Ingress (nginx) — platform entry point |
| 4000 | HTTPS | API Gateway |
| 4001 | HTTP | Workflow Service |
| 5001 | HTTP | Dify API |
| 3002 | HTTP | Dify Web UI |
| 5679 | HTTP | n8n Editor (mapped from 5678) |
| 8443 | HTTPS | Keycloak |
| 8200 | HTTP | Vault |
| 5432 | TCP | PostgreSQL |
| 6379 | TCP | Redis |
| 5671 | AMQPS | RabbitMQ |
| 15671 | HTTPS | RabbitMQ Management |
| 9000 | HTTPS | MinIO API |
| 9001 | HTTPS | MinIO Console |
| 9200 | HTTPS | OpenSearch |

EOF

chmod 600 "${OUTPUT_FILE}"
echo "Credentials document written to: ${OUTPUT_FILE}"
echo "View with: sudo cat ${OUTPUT_FILE}"
