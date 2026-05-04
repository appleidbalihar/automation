# Container Reference

This reference matches the current `docker-compose.yml`.

## Container Summary

The platform runs the following Docker containers:

| Container | Category | Port(s) | Purpose |
|-----------|----------|---------|---------|
| `web` | App | 3000 | Next.js platform UI |
| `web-ingress` | App | host 3443 | HTTPS ingress (Nginx) |
| `api-gateway` | App | 4000 | JWT/RBAC API gateway (Fastify) |
| `workflow-service` | App | 4001 | RAG orchestration, Dify/n8n integration |
| `logging-service` | App | 4005 | Log ingest and query |
| `postgres` | Infra | 5432 | Platform database + pgvector |
| `redis` | Infra | 6379 | Cache and nonce store |
| `rabbitmq` | Infra | 5671, 15671 | AMQPS event bus |
| `opensearch` | Infra | 9200, 9600 | Log search backend |
| `minio` | Infra | 9000, 9001 | S3-compatible object storage |
| `keycloak` | Infra | 8443 | Identity provider, JWT issuer |
| `vault` | Infra | 8200 | PKI CA and secret storage |
| `dify-api` | Dify | 5001 | Dify API for datasets/apps/chat |
| `dify-worker` | Dify | internal | Async indexing worker |
| `dify-web` | Dify | host 3002 | Dify admin console |
| `dify-sandbox` | Dify | internal | Code execution sandbox |
| `dify-db` | Dify | internal | Dify application database |
| `dify-redis` | Dify | internal | Dify worker queue/cache |
| `n8n` | n8n | host 5679 | Document sync workflow runner |
| `n8n-db` | n8n | internal | n8n state database |
| `vault-bootstrap` | Sidecar | — | Vault init/unseal job |
| `db-migrate` | Sidecar | — | Prisma migration job |
| `cert-rotation-controller` | Sidecar | — | TLS cert rotation controller |
| `*-vault-agent` | Sidecar | — | Per-service Vault agents for TLS certs |

## Application Containers

### `web`

- Image: built with `infra/docker/Dockerfile.web`
- Port: `3000` internal
- Framework: Next.js
- Purpose: RapidRAG landing page and authenticated platform UI.
- Important env: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_PLATFORM_URL`, `NEXT_PUBLIC_OAUTH_CALLBACK_BASE_URL`, `WEB_INTERNAL_API_BASE_URL`, Keycloak env, `NODE_EXTRA_CA_CERTS`.
- API proxy: `/gateway/*` forwards server-side to `WEB_INTERNAL_API_BASE_URL`, default `https://api-gateway:4000`.

### `web-ingress`

- Image: `nginx:1.27-alpine`
- Port: host `3443` -> container `443`
- Purpose: HTTPS ingress for the web app.
- Config: `infra/nginx/web-https.conf`
- TLS: Vault-issued cert from `tls_web_ingress`.

### `api-gateway`

- Image: shared service image built from `infra/docker/Dockerfile.service`
- Port: `4000`
- Framework: Fastify
- Purpose: browser-facing API boundary.
- Responsibilities:
  - Keycloak JWT/RBAC checks
  - proxying RAG, logs, secrets, and security APIs
  - OAuth connect/callback/disconnect flow
  - n8n sync callback authorization
  - certificate health scanning and rotation request queueing
- Depends on: `workflow-service`, `logging-service`, `api-gateway-vault-agent`.
- Important env: `WORKFLOW_SERVICE_URL`, `LOGGING_SERVICE_URL`, `KEYCLOAK_URL`, `PLATFORM_OAUTH_SECRET`, OAuth callback/client env, TLS env.

### `workflow-service`

- Image: shared service image built from `infra/docker/Dockerfile.service`
- Port: `4001`
- Framework: Fastify
- Purpose: RAG orchestration service.
- Responsibilities:
  - create/edit/delete knowledge sources
  - manage `sourcePaths`, sharing, defaults, config, sync jobs, cleanup jobs, retry jobs
  - provision and call Dify datasets/apps
  - trigger and cancel n8n executions
  - store source credentials, OAuth tokens, OAuth app credentials, and Dify API keys in Vault
  - publish platform events to RabbitMQ
- Depends on: `db-migrate`, `rabbitmq`, `workflow-service-vault-agent`.
- Runtime integrations: Dify API, n8n, PostgreSQL, RabbitMQ, Vault.

### `logging-service`

- Image: shared service image built from `infra/docker/Dockerfile.service`
- Port: `4005`
- Framework: Fastify
- Purpose: platform log ingest and query service.
- Routes:
  - `GET /health`
  - `GET /security/tls`
  - `POST /logs/ingest`
  - `GET /logs`
  - `GET /logs/timeline`
  - `GET /logs/sync-job`
- Storage: PostgreSQL `PlatformLog`; OpenSearch indexing is best-effort/non-blocking.

## Platform Infrastructure

### `postgres`

- Image: `ankane/pgvector:latest`
- Port: `5432`
- Purpose: platform database with TLS enabled and pgvector available.
- Data volume: `postgres_data`.

### `redis`

- Image: `redis:7-alpine`
- Port: `6379`
- Purpose: Redis endpoint, configured for TLS through `infra/redis/redis.conf`.

### `rabbitmq`

- Image: `rabbitmq:3-management`
- Ports: `5671` AMQPS, `15671` management UI
- Purpose: platform event bus.

### `opensearch`

- Image: `opensearchproject/opensearch:2.14.0`
- Ports: `9200`, `9600`
- Purpose: optional search backend for logs.

### `minio`

- Image: `minio/minio:latest`
- Ports: `9000`, `9001`
- Purpose: S3-compatible object storage.

### `keycloak`

- Image: `quay.io/keycloak/keycloak:25.0`
- Port: `8443`
- Purpose: realm import, login, JWT issuance.
- Realm import: `infra/keycloak/realm-export.json`.

### `vault`

- Image: `hashicorp/vault:1.17`
- Port: `8200`
- Purpose: PKI CA and KV secret storage.
- Bootstrap service: `vault-bootstrap`.
- Data volume: `vault_data`.

## Dify Stack

### `dify-db`

- Image: `postgres:15-alpine`
- Internal only
- Purpose: Dify application database.

### `dify-redis`

- Image: `redis:6-alpine`
- Internal only
- Purpose: Dify worker queue/cache.

### `dify-migrate`

- Image: `langgenius/dify-api:0.6.16`
- One-shot migration job for the Dify schema.

### `dify-api`

- Image: `langgenius/dify-api:0.6.16`
- Port: `5001`
- Purpose: Dify API for app/dataset/chat/document indexing operations.

### `dify-worker`

- Image: `langgenius/dify-api:0.6.16`
- Internal only
- Purpose: async Dify indexing/embedding worker.

### `dify-sandbox`

- Image: `langgenius/dify-sandbox:0.2.10`
- Internal only
- Purpose: Dify code execution sandbox.

### `dify-web`

- Image: `langgenius/dify-web:0.6.16`
- Port: host `3002` -> container `3000`
- Purpose: Dify admin console.

## n8n Stack

### `n8n-db`

- Image: `postgres:15-alpine`
- Internal only
- Purpose: n8n state database.

### `n8n`

- Image: `n8nio/n8n:latest`
- Port: host `5679` -> container `5678`
- Purpose: workflow runner for document sync and channel workflows.
- Notes: `N8N_PATH` is `/n8n/`; `WEBHOOK_URL` defaults to `https://dev.eclassmanager.com/n8n/`.

## Sidecars And Control Jobs

### `db-migrate`

- Image: built with `infra/docker/Dockerfile.migrate`
- Purpose: Prisma migration job before app services start.

### Vault Agent sidecars

Sidecars named `*-vault-agent` issue and renew certs into service-specific `tls_*` volumes.

### `vault-bootstrap`

Initializes/unseals Vault and configures PKI, policies, and AppRole material.

### `cert-rotation-controller`

Reads queued rotation requests from `rotation_control` and restarts configured containers when needed.

## Removed Or Legacy Items

- `flowise` is not in the compose file. Only legacy database fields reference old Flowise sessions.
- `vault-init` is not the current bootstrap service name; use `vault-bootstrap`.
- `RagKbSourcePath` is not a current table; incremental state is `RagKbFileTracker`.

## Port Quick Reference

| Host port | Container/service |
|-----------|-------------------|
| `3443` | `web-ingress` |
| `4000` | `api-gateway` |
| `4001` | `workflow-service` |
| `4005` | `logging-service` |
| `5432` | `postgres` |
| `5671` | `rabbitmq` AMQPS |
| `5679` | `n8n` |
| `6379` | `redis` |
| `8200` | `vault` |
| `8443` | `keycloak` |
| `9000`, `9001` | `minio` |
| `9200`, `9600` | `opensearch` |
| `3002` | `dify-web` |
| `5001` | `dify-api` |
