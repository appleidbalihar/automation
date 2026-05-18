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

- Image: built with `infra/docker/Dockerfile.web` (~240 MB)
- Base: `node:22-alpine`; runtime stage uses Next.js **standalone output** — no pnpm or full node_modules at runtime.
- Port: `3000` internal
- Framework: Next.js 15 (`output: 'standalone'`)
- Entrypoint: `node apps/web/server.js`
- Purpose: RapidRAG landing page and authenticated platform UI.
- Production: `read_only: true` with `/tmp` tmpfs (standalone server requires no writable FS).
- Important env: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_PLATFORM_URL`, `NEXT_PUBLIC_OAUTH_CALLBACK_BASE_URL`, `WEB_INTERNAL_API_BASE_URL`, Keycloak env, `NODE_EXTRA_CA_CERTS`.
- API proxy: `/gateway/*` forwards server-side to `WEB_INTERNAL_API_BASE_URL`, default `https://api-gateway:4000`.

### `web-ingress`

- Image: `nginx:1.27-alpine`
- Port: host `3443` -> container `443`
- Purpose: HTTPS ingress for the web app.
- Config: `infra/nginx/web-https.conf`
- TLS: Vault-issued cert from `tls_web_ingress`.

### `api-gateway`

- Image: shared service image built from `infra/docker/Dockerfile.service` (~1.1 GB); base `node:22-alpine`
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

- Image: shared service image built from `infra/docker/Dockerfile.service` (~1.1 GB); base `node:22-alpine`
- Port: `4001`
- Framework: Fastify
- Purpose: RAG orchestration service.
- Responsibilities:
  - create/edit/delete knowledge sources
  - manage `sourcePaths`, sharing, defaults, config, sync jobs, cleanup jobs, retry jobs
  - manage AI agent prompt templates and apply templates to KB agent configs
  - calculate platform-wide RAG stats
  - provision and call Dify datasets/apps
  - trigger and cancel n8n executions
  - store source credentials, OAuth tokens, OAuth app credentials, and Dify API keys in Vault
  - publish platform events to RabbitMQ
- Depends on: `db-migrate`, `rabbitmq`, `workflow-service-vault-agent`.
- Runtime integrations: Dify API, n8n, PostgreSQL, RabbitMQ, Vault.

### `logging-service`

- Image: shared service image built from `infra/docker/Dockerfile.service` (~1.1 GB); base `node:22-alpine`
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
- Data volume: `redis_data`.

### `rabbitmq`

- Image: `rabbitmq:3-management`
- Ports: `5671` AMQPS, `15671` management UI
- Purpose: platform event bus.
- Data volume: `rabbitmq_data`.

### `opensearch`

- Image: `opensearchproject/opensearch:2.14.0`
- Ports: `9200`, `9600`
- Purpose: optional search backend for logs.
- Data volume: `opensearch_data`.

### `minio`

- Image: `minio/minio:latest`
- Ports: `9000`, `9001`
- Purpose: S3-compatible object storage.
- Data volume: `minio_data`.

### `keycloak`

- Image: `quay.io/keycloak/keycloak:25.0`
- Port: `8443`
- Purpose: realm import, login, JWT issuance.
- Data volume: `keycloak_data`.
- Realm import: `infra/keycloak/realm-export.json` is bootstrap-only. Users and runtime realm state live in `keycloak_data`.
- Platform admin recovery: `ENVIRONMENT=dev bash scripts/seed-keycloak-platform-admin.sh`.

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
- Data volume: `dify_db_data`.

### `dify-redis`

- Image: `redis:6-alpine`
- Internal only
- Purpose: Dify worker queue/cache.
- Data volume: `dify_redis_data`.

### `dify-migrate`

- Image: `langgenius/dify-api:0.6.16`
- One-shot migration job for the Dify schema.

### `dify-api`

- Image: `langgenius/dify-api:0.6.16`
- Port: `5001`
- Purpose: Dify API for app/dataset/chat/document indexing operations.
- Storage volume: `dify_storage`.

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
- Data volume: `n8n_db_data`.

### `n8n`

- Image: `n8nio/n8n:latest`
- Port: host `5679` -> container `5678`
- Purpose: workflow runner for document sync and channel workflows.
- Notes: `N8N_PATH` is `/n8n/`; `WEBHOOK_URL` defaults to `https://dev.rapidrag.ai/n8n/`.
- Data volume: `n8n_data`.

## Persistent Data Volumes

Stateful services must keep their writable state in named Docker volumes. App/runtime containers are stateless and can be rebuilt or force-recreated safely.

| Service | Persistent volume(s) | Protected data |
|---|---|---|
| `postgres` | `postgres_data` | Platform DB, including KB metadata, users' platform records, logs, and RAG state |
| `redis` | `redis_data` | Redis AOF/RDB state for cache/nonce/session-adjacent runtime data |
| `rabbitmq` | `rabbitmq_data` | RabbitMQ definitions, queues, and durable messages |
| `opensearch` | `opensearch_data` | Search indexes |
| `minio` | `minio_data` | Object storage buckets/data |
| `keycloak` | `keycloak_data` | Realms, users, credentials, and login state |
| `vault` | `vault_data` | Vault KV secrets, PKI material, AppRole ids, audit log |
| `dify-db`, `dify-redis`, `dify-api`, `dify-worker` | `dify_db_data`, `dify_redis_data`, `dify_storage` | Dify DB, queue/cache state, local storage |
| `n8n-db`, `n8n` | `n8n_db_data`, `n8n_data` | n8n DB and local workflow/config state |

Start and restart through the platform wrapper so Vault-rendered runtime env files are generated and shredded automatically:

```bash
/home/bali/09_rapidrag/scripts/platform-containers.sh dev start
/home/bali/09_rapidrag/scripts/platform-containers.sh dev restart keycloak web web-ingress
/home/bali/09_rapidrag/scripts/platform-containers.sh dev status
```

## Sidecars And Control Jobs

### `db-migrate`

- Image: built with `infra/docker/Dockerfile.migrate` (~315 MB); base `node:22-alpine`, 2-stage build targeting `packages/db` only.
- Purpose: Prisma migration job before app services start.
- If it exits 1 with `relation "X" already exists`, the migration was applied manually but never recorded. Fix: `prisma migrate resolve --applied <name>` — see `PRODUCTION_MIGRATION.md` § Known Issues.

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
