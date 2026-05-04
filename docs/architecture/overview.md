# Platform Architecture Overview

## What Is RapidRAG

RapidRAG is a self-hosted RAG (Retrieval-Augmented Generation) operations platform. Operators connect document sources (GitHub, GitLab, Google Drive, or web URLs), sync supported files into Dify knowledge bases, and chat through the RAG Assistant. Administrators manage users, secrets, logs, and certificate health from the web UI.

## Quick Reference: Services and Ports

The RapidRAG platform runs these services:

| Service | Host Port | Purpose |
|---------|-----------|---------|
| `web-ingress` | `3443` | HTTPS ingress (Nginx TLS entrypoint) |
| `web` | `3000` | Next.js platform UI and `/gateway/*` API proxy |
| `api-gateway` | `4000` | JWT/RBAC enforcement, OAuth flow, certificate monitor |
| `workflow-service` | `4001` | RAG source lifecycle, Dify provisioning and chat |
| `logging-service` | `4005` | Log ingest, query, and timeline APIs |
| `postgres` | `5432` | Platform database with pgvector extension |
| `redis` | `6379` | Cache and OAuth nonce storage |
| `rabbitmq` | `5671`, `15671` | AMQPS event bus and management UI |
| `opensearch` | `9200`, `9600` | Log search backend |
| `minio` | `9000`, `9001` | S3-compatible object storage |
| `keycloak` | `8443` | Identity provider and JWT issuer |
| `vault` | `8200` | PKI certificate authority and secret storage |
| `dify-api` | `5001` | Dify API for datasets, apps, chat, and document indexing |
| `dify-web` | `3002` | Dify admin console |
| `dify-worker` | internal | Dify async indexing and embedding worker |
| `dify-sandbox` | internal | Dify code execution sandbox |
| `n8n` | `5679` | Document sync workflow runner |

For full container details (images, env vars, dependencies), see `docs/architecture/containers.md`.

## System Architecture (Request Flow)

How a browser request flows through the platform:

```
Browser → HTTPS :3443 → web-ingress (Nginx)
                              ↓
                         web (Next.js :3000)
                              ↓ /gateway/* proxy
                         api-gateway (Fastify :4000, mTLS)
                         ↙                    ↘
            workflow-service (:4001)    logging-service (:4005)
                         ↓
              ┌─ PostgreSQL + pgvector
              ├─ RabbitMQ (events)
              ├─ Vault (secrets + PKI)
              ├─ Dify API/worker/web (RAG)
              └─ n8n (sync workflows)
```

## Web UI Pages and Routes

The authenticated platform UI lives at `https://<host>:3443` under these routes:

| Route | Page | Who Can Access |
|-------|------|---------------|
| `/dashboard` | Platform summary and quick links | All roles |
| `/knowledge-connector` | Source and knowledge base management | admin, useradmin, operator |
| `/rag-assistant` | Dify-backed RAG chat | All roles |
| `/profile` | User profile and password change | All roles |
| `/logs` | Platform log explorer | admin only |
| `/users` | User management | admin, useradmin |
| `/secrets` | Vault secret management | admin only |
| `/security` | Certificate health panel | admin only |

Legacy compatibility routes:

| Legacy Route | Current Behavior |
|--------------|-----------------|
| `/integrations` | Same as `/knowledge-connector` |
| `/operations-ai` | Redirects to `/rag-assistant` |
| `/operations-ai-dify` | Redirects to `/rag-assistant` |
| `/operations-ai/setup` | Redirects to `/knowledge-connector` |

## User Roles and Permissions

RapidRAG uses Keycloak-issued JWTs with these platform roles:

| Role | Permissions |
|------|-------------|
| `admin` | Full access: logs, users, secrets, certificates, all KB operations |
| `useradmin` | User management plus KB and source operations |
| `operator` | Source sync, RAG chat, sync-job logs |
| `approver` | Read and chat access |
| `viewer` | Read and chat access |

**Admin-only routes:** `/logs`, `/logs/timeline`
**Operator and above:** `/logs/sync-job` (scoped by sync job ID)

## Database Models (Prisma)

The platform database schema (`packages/db/prisma/schema.prisma`) contains these tables:

| Table | What It Stores |
|-------|---------------|
| `PlatformLog` | Sanitized platform log events |
| `RagKnowledgeBase` | Knowledge base configuration, Dify dataset ID, ownership |
| `RagKbShare` | Access grants sharing a KB with other users |
| `RagKnowledgeBaseConfig` | Prompt, model, retrieval, and response-style settings |
| `RagKbFileTracker` | Per-file SHA hash and Dify document ID for incremental sync |
| `RagKbSyncJob` | Sync job lifecycle, steps, progress, and error state |
| `RagChannelDeployment` | Channel deployment metadata |
| `RagDiscussionThread` | RAG chat thread records |
| `RagDiscussionMessage` | Individual messages in a chat thread |

Note: These are **database tables**, not Docker containers. Docker containers are listed in the Service table above and in `containers.md`.

## How Source Sync Works

When an operator triggers a knowledge base sync:

```
1. Operator clicks "Sync" in Knowledge Connector UI
2. POST /gateway/rag/knowledge-bases/:id/sync → api-gateway → workflow-service
3. workflow-service creates a RagKbSyncJob record
4. workflow-service triggers n8n webhook (rag-sync-github / rag-sync-gitlab / etc.)
5. n8n fetches source files from GitHub/GitLab/Google Drive
6. n8n calls sync-diff endpoint to find changed files
7. Changed/new files are uploaded and indexed in Dify
8. n8n posts progress callbacks → workflow-service updates sync job steps
9. UI polls sync-status endpoint and displays progress
```

## How RAG Chat Works

When an operator sends a message in the RAG Assistant:

```
1. User types message in /rag-assistant UI
2. POST /gateway/rag/discussions/:threadId/messages → api-gateway → workflow-service
3. workflow-service retrieves the Dify app API key from Vault
4. workflow-service calls Dify chat API with the user's message
5. Dify retrieves relevant document chunks from the knowledge base
6. Dify sends chunks + message to the configured LLM (e.g. gemini-3.1-pro via fuelix.ai)
7. LLM response is returned to workflow-service
8. Response is stored in RagDiscussionMessage and returned to the UI
```

## Security Architecture

- **TLS certificates** are issued by Vault PKI and mounted into each service from `/tls`
- **Service-to-service** communication uses mTLS (mutual TLS)
- **Secrets** (API keys, OAuth tokens, Dify credentials) are stored in Vault, never in the database
- **JWT verification** is done at the api-gateway for all browser-facing requests
- **n8n sync callbacks** are authenticated with `X-Rag-Sync-Token` or `X-N8N-Webhook-Token`

## Monorepo Code Layout

```
apps/
  api-gateway/       JWT/RBAC gateway, OAuth flow, cert monitor
  logging-service/   Log ingest and query service
  web/               Next.js RapidRAG UI
  workflow-service/  RAG orchestration, Dify/n8n integration
packages/
  auth/              Auth hooks and role utilities
  config/            Shared environment config loader
  contracts/         Shared event names and type contracts
  db/                Prisma schema and database client
  observability/     Structured logging helpers
  tls-runtime/       TLS/mTLS server and fetch helpers
  ui-kit/            Shared React UI components
infra/
  docker/            Dockerfiles for app images
  keycloak/          Realm export and seed scripts
  nginx/             Nginx ingress configuration
  n8n/               Sync workflow templates
  postgres/ redis/ rabbitmq/ vault/   Infrastructure config
```
