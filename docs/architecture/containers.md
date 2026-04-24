# Container Reference

This document describes every container in the platform, its purpose, dependencies, exposed ports, and key configuration.

---

## Application Containers

### `web`
**Image**: built from `apps/web/`  
**Port**: 3000 (internal, exposed via `web-ingress`)  
**Framework**: Next.js 15 / React 19  

The operator-facing dashboard. Provides all UI pages: dashboard, integrations, logs explorer, Operations AI chat, secrets management, user management, and security/certificate panel.

**Depends on**: `api-gateway`  
**Key env vars**: `WEB_KEYCLOAK_URL`, `NEXT_PUBLIC_API_BASE_URL`, `WEB_INTERNAL_API_BASE_URL`  
**Auth**: Keycloak OAuth 2.0. JWT stored in browser localStorage.  
**API proxy**: All `/gateway/*` requests are proxied to `api-gateway:4000`.

---

### `web-ingress`
**Image**: Nginx  
**Port**: 3443 (host)  

TLS termination and reverse proxy in front of the Next.js app. Operators always connect through this container.

**Depends on**: `web`  
**TLS**: Certificate issued by Vault Agent sidecar, mounted at `/tls/`  

---

### `api-gateway`
**Image**: built from `apps/api-gateway/`  
**Port**: 4000 (mTLS)  
**Framework**: Fastify  

Central entry point for all API calls. Responsibilities:
- Validates Keycloak JWTs and enforces RBAC
- Routes RAG, secrets, and health requests to backend services
- Runs a background certificate monitor (scan every 5 min, warn at 7 days, critical at 3 days)
- Receives n8n sync-progress webhook callbacks and forwards to workflow-service
- Provides admin secret management via Vault KV2

**Depends on**: `workflow-service`, `logging-service`, `keycloak`, `vault`  
**Key env vars**: `WORKFLOW_SERVICE_URL`, `LOGGING_SERVICE_URL`, `KEYCLOAK_URL`, `VAULT_ADDR`, `CERT_SCAN_INTERVAL_MS`, `CERT_WARNING_DAYS`, `CERT_CRITICAL_DAYS`

**Routes summary**:

| Method | Path | Role Required | Description |
|--------|------|---------------|-------------|
| GET | /health | — | Liveness check |
| GET | /health/dependencies | — | Downstream health |
| GET | /health/readiness | — | Full readiness probe |
| GET | /security/tls | operator | Certificate status |
| GET | /rag/integrations | operator | List KB sources |
| POST | /rag/integrations | operator | Create KB source |
| PATCH | /rag/integrations/:id | operator | Update KB source |
| DELETE | /rag/integrations/:id | operator | Delete KB source |
| POST | /rag/integrations/:id/set-default | operator | Set default KB |
| GET/POST | /rag/knowledge-bases | operator | Manage knowledge bases |
| PATCH | /rag/knowledge-bases/:id/config | operator | Update KB config |
| POST | /rag/knowledge-bases/:id/sync | operator | Trigger sync |
| POST | /rag/knowledge-bases/:id/sync-cancel | operator | Cancel sync |
| GET | /rag/knowledge-bases/:id/sync-status | operator | Sync status |
| GET | /rag/knowledge-bases/:id/sync-history | operator | Sync job history |
| POST | /rag/knowledge-bases/:id/sync-progress | internal | n8n callback |
| GET/POST | /rag/discussions | operator | Manage chat threads |
| POST | /rag/discussions/:id/messages | operator | Send chat message |
| DELETE | /rag/discussions/:id | operator | Delete thread |
| GET/POST | /rag/channels | operator | Deploy channels |
| GET/POST/PATCH/DELETE | /admin/secrets | admin | Vault secret management |
| GET | /admin/secrets/catalog | admin | Available secret groups |
| GET | /auth/me | any | Current user info |

---

### `workflow-service`
**Image**: built from `apps/workflow-service/`  
**Port**: 4001 (mTLS)  
**Framework**: Fastify  

Backend orchestration service. Owns the RAG knowledge base lifecycle, Dify integration, and n8n sync triggering. All RAG API calls from `api-gateway` are proxied here.

**Depends on**: `db-migrate`, `rabbitmq`, `dify-api`, `n8n`, `vault`, `flowise`  
**Key env vars**: `DATABASE_URL`, `RABBITMQ_URL`, `DIFY_API_BASE_URL`, `N8N_API_BASE_URL`, `VAULT_ADDR`, `FLOWISE_OPERATIONS_CHAT_URL`

**Responsibilities**:
- Create / update / delete `RagKnowledgeBase` and `RagKbSyncJob` records
- Provision Dify datasets and apps, store API keys in Vault
- Trigger n8n workflows for document ingestion
- Handle Dify and Flowise conversation sessions
- Publish platform events to RabbitMQ

---

### `logging-service`
**Image**: built from `apps/logging-service/`  
**Port**: 4005 (mTLS)  
**Framework**: Fastify  

Log aggregation service. Has no public API routes — it only consumes from RabbitMQ.

**Depends on**: `db-migrate`, `rabbitmq`, `opensearch`  
**Key env vars**: `DATABASE_URL`, `RABBITMQ_URL`, `OPENSEARCH_URL`

**Log pipeline**:
1. Subscribes to `platform.events` RabbitMQ exchange
2. Parses and sanitizes each event (masks passwords, tokens, keys, credentials)
3. Persists to `PlatformLog` table (PostgreSQL)
4. Asynchronously ships to OpenSearch (`platform-logs-YYYY.MM.DD` index)

OpenSearch shipping is non-blocking — if OpenSearch is unavailable, logs still land in PostgreSQL.

---

## Infrastructure Containers

### `postgres`
**Image**: `pgvector/pgvector:pg16`  
**Port**: 5432  

Primary relational database. The `pgvector` extension enables vector similarity queries used by Dify for RAG embeddings.

**Database**: `automation`  
**Key tables**: `PlatformLog`, `RagKnowledgeBase`, `RagKnowledgeBaseConfig`, `RagKbSyncJob`, `RagChannelDeployment`, `RagDiscussionThread`, `RagDiscussionMessage`  
**TLS**: SSL required; certificate from Vault Agent sidecar.

---

### `redis`
**Image**: Redis 7  
**Port**: 6379 (TLS — `rediss://`)  

Used for caching and session data. TLS enforced.

---

### `rabbitmq`
**Image**: RabbitMQ 3  
**Ports**: 5671 (AMQPS), 15671 (management UI)  

Event bus for asynchronous inter-service communication. Used by:
- All services publishing platform events → logging-service
- Certificate rotation controller publishing rotation events → api-gateway
- workflow-service publishing RAG sync events

Exchange: `platform.events` (topic)

---

### `opensearch`
**Image**: OpenSearch 2.14  
**Port**: 9200  

Full-text search backend for platform logs. Indexed daily as `platform-logs-YYYY.MM.DD`. Queried by the logs explorer page via the logging-service.

Default credentials: `admin / DevAdmin123!`

---

### `minio`
**Image**: MinIO  
**Ports**: 9000 (API), 9001 (console)  

S3-compatible object storage for document uploads before ingestion into Dify knowledge bases.

Default credentials: `minioadmin / minioadmin`

---

### `keycloak`
**Image**: Keycloak 25  
**Port**: 8443 (HTTPS)  

Identity provider and SSO. Issues JWTs for web sessions. All services validate tokens against Keycloak's JWKS endpoint.

**Realm**: `automation-platform`  
**Default admin**: `admin / admin`  
**Default platform user**: `platform-admin / admin123` (role: `admin`)  
**Client**: `automation-web` (Confidential, used by Next.js backend)  

Auto-seeded from `infra/keycloak/realm-export.json` on first boot.

---

### `vault`
**Image**: HashiCorp Vault 1.17  
**Port**: 8200  

Dual purpose:
1. **PKI Certificate Authority** — Issues TLS leaf certificates to all services via Vault Agent sidecars
2. **KV2 Secret Store** — Stores platform secrets (Dify API keys, source credentials, integration tokens)

**PKI mount**: `pki/`  
**KV2 mount**: `secret/`  
**Auth**: AppRole (each service has its own role/secret-id)  
**Bootstrap**: `infra/vault/bootstrap-pki.sh` runs once via the `vault-init` one-shot container

Secret paths follow the convention: `secret/data/platform/{scope}/{group}/{name}`

---

### `dify-api`
**Image**: Dify 0.6.16  
**Port**: 5001  

RAG engine. workflow-service calls Dify's REST API to:
- Create datasets (knowledge bases)
- Upload and index documents
- Run chat completions with retrieved context

Each knowledge base in the platform corresponds to a Dify App. The Dify API key is stored in Vault per knowledge base.

**Internal dependencies**: `dify-db` (PostgreSQL), `dify-redis` (Redis), `dify-worker` (Celery)

---

### `n8n`
**Image**: n8n  
**Port**: 5678  

Workflow automation engine. Runs pre-built sync workflows for each source type (GitHub, GitLab, Google Drive, web scrape). Triggered by workflow-service via REST API.

n8n sends progress callbacks to `api-gateway:4000/rag/knowledge-bases/:id/sync-progress` as documents are processed.

**Internal DB**: `n8n-db` (PostgreSQL)  
**Credentials**: Stored in Vault and injected via environment or n8n credential store

---

### `flowise`
**Image**: Flowise 2.2.3  
**Port**: 3001  

Legacy AI chat orchestration. Still running for backward compatibility with existing conversation threads that use `flowiseSessionId`. New conversations use Dify. Being phased out.

**DB**: SQLite (local volume)

---

## One-Shot / Sidecar Containers

### `db-migrate`
Runs `prisma migrate deploy` once at startup against the PostgreSQL database. Application containers wait for this to complete before starting.

---

### `vault-init`
Runs `infra/vault/bootstrap-pki.sh` once. Initializes Vault, mounts PKI and KV2 engines, creates AppRoles for each service, and issues the root CA certificate. Data persisted in a named volume so it does not re-run.

---

### Vault Agent Sidecars (`vault-agent-*`)
One sidecar per service. Each:
1. Authenticates to Vault using AppRole credentials
2. Requests a leaf TLS certificate from the PKI engine
3. Renders `cert.pem`, `key.pem`, `ca.pem` to a shared volume
4. Watches for certificate expiry and triggers renewal

Services watch their `/tls/` volume and hot-reload certificates without restarting.

---

### `cert-rotation-controller`
Polls periodically (`ROTATION_INTERVAL_SECONDS`). When a service certificate is within `CERT_CRITICAL_DAYS` of expiry and renewal has not occurred, it writes a rotation request and triggers a graceful container restart to force certificate reload.

---

## Port Quick Reference

| Port | Container | Protocol |
|------|-----------|----------|
| 3443 | web-ingress | HTTPS |
| 3000 | web | HTTP (internal) |
| 4000 | api-gateway | mTLS HTTPS |
| 4001 | workflow-service | mTLS HTTPS |
| 4005 | logging-service | mTLS HTTPS |
| 5432 | postgres | PostgreSQL/TLS |
| 6379 | redis | TLS |
| 5671 | rabbitmq | AMQPS |
| 15671 | rabbitmq | HTTPS management |
| 8200 | vault | HTTP |
| 8443 | keycloak | HTTPS |
| 9200 | opensearch | HTTPS |
| 9000 | minio | HTTPS |
| 9001 | minio | HTTPS console |
| 5001 | dify-api | HTTP (internal) |
| 3001 | flowise | HTTP (internal) |
| 5678 | n8n | HTTP (internal) |
