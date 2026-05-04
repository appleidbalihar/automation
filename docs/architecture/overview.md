# Platform Architecture Overview

## System Purpose

RapidRAG is a self-hosted RAG operations platform. Operators connect document sources, sync supported files into Dify knowledge bases, chat through the RAG Assistant, and administer users, secrets, logs, and certificate health from the web UI.

## Current Runtime Topology

```
Browser
  |
  | HTTPS :3443
  v
web-ingress (Nginx)
  |
  v
web (Next.js :3000)
  |
  | /gateway/* proxy
  v
api-gateway (Fastify :4000, HTTPS/mTLS)
  |                         |
  |                         v
  |                   logging-service (:4005)
  v
workflow-service (:4001)
  |
  +-- PostgreSQL + pgvector
  +-- RabbitMQ
  +-- Vault
  +-- Dify API/worker/web
  +-- n8n
```

## Service Inventory

| Service | Port | Current role |
|---------|------|--------------|
| `web-ingress` | host `3443` -> container `443` | TLS entrypoint for the platform web app |
| `web` | `3000` | Next.js app, auth gate, landing page, platform UI, `/gateway/*` proxy |
| `api-gateway` | `4000` | JWT/RBAC enforcement, service proxy, OAuth flow, certificate monitor, sync callback entrypoint |
| `workflow-service` | `4001` | RAG source lifecycle, Dify provisioning/chat, n8n sync triggering, Vault-backed source secrets |
| `logging-service` | `4005` | Log ingest/query/timeline APIs, PostgreSQL persistence, optional OpenSearch shipping |
| `postgres` | `5432` | Platform database and pgvector store used by Dify |
| `redis` | `6379` | Redis endpoint for platform/OAuth nonce use |
| `rabbitmq` | `5671`, `15671` | AMQPS event bus and management UI |
| `opensearch` | `9200`, `9600` | Search backend for platform logs |
| `minio` | `9000`, `9001` | S3-compatible object storage |
| `keycloak` | `8443` | Identity provider and JWT issuer |
| `vault` | `8200` | PKI CA plus KV secret storage |
| `dify-api` | `5001` | Dify API used for datasets, apps, chat, and document indexing |
| `dify-web` | `3002` | Dify admin console for setup/admin tasks |
| `dify-worker` | internal | Dify async indexing worker |
| `dify-sandbox` | internal | Dify code execution sandbox |
| `n8n` | host `5679` -> container `5678` | Document sync workflow runner |

Flowise is no longer part of `docker-compose.yml`. Some database fields remain only for legacy discussion-thread compatibility.

## Web UI Routes

The authenticated platform shell lives under `apps/web/src/app/(platform)`.

| Route | Component | Notes |
|-------|-----------|-------|
| `/dashboard` | `DashboardOverview` | Platform summary and quick links |
| `/knowledge-connector` | `IntegrationsPage` | Primary source/KB management route |
| `/rag-assistant` | `OperationsAiDifyChat` | Primary Dify-backed chat route |
| `/profile` | `ProfilePage` | Current user profile/password |
| `/logs` | `LogsExplorer` | Admin-only platform logs |
| `/users` | `UsersAdminPanel` | Admin/useradmin user management |
| `/secrets` | `AdminSecretsPanel` | Admin-only Vault secret management |
| `/security` | `SecurityHealthPanel` | Admin-only certificate health |

Compatibility routes still exist:

| Legacy route | Current behavior |
|--------------|------------------|
| `/integrations` | Renders the same `IntegrationsPage` as `/knowledge-connector` |
| `/operations-ai` | Redirects to `/rag-assistant` |
| `/operations-ai-dify` | Redirects to `/rag-assistant` |
| `/operations-ai/setup` | Redirects to `/knowledge-connector` |

## Authentication And Roles

The web app uses Keycloak-backed platform sessions and sends bearer tokens to the API. The API gateway verifies JWTs and applies role checks per route.

| Role | Current UI/API meaning |
|------|------------------------|
| `admin` | Full platform administration, including logs, users, secrets, security, and KB operations |
| `useradmin` | User administration plus KB/source operations allowed by gateway routes |
| `operator` | Source sync, RAG operations, and sync-job logs |
| `approver` | Read/chat access where gateway routes allow it |
| `viewer` | Read/chat access where gateway routes allow it |

System-wide `/logs` and `/logs/timeline` are admin-only. `/logs/sync-job` is available to admin, useradmin, and operator because it is scoped by sync job.

## Data Model

Current Prisma models are in `packages/db/prisma/schema.prisma`.

| Model | Purpose |
|-------|---------|
| `PlatformLog` | Sanitized platform log events |
| `RagKnowledgeBase` | Source configuration, Dify dataset reference, ownership, default flag |
| `RagKbShare` | Explicit chat access grants to other users |
| `RagKnowledgeBaseConfig` | Prompt/model/retrieval and response-style configuration |
| `RagKbFileTracker` | Per-file SHA and Dify document ID for incremental sync |
| `RagKbSyncJob` | Sync/cleanup/retry job lifecycle and step JSON |
| `RagChannelDeployment` | Channel deployment metadata |
| `RagDiscussionThread`, `RagDiscussionKbSession`, `RagDiscussionMessage` | RAG chat history and Dify conversation sessions |

The old `RagKbSourcePath` model has been replaced by `sourcePaths` on `RagKnowledgeBase` plus `RagKbFileTracker`.

## Main Data Flows

### Source Sync

```
Operator -> Knowledge Connector -> POST /gateway/rag/knowledge-bases/:id/sync
  -> api-gateway
  -> workflow-service creates/updates RagKbSyncJob
  -> workflow-service triggers n8n
  -> n8n fetches source files and calls sync-diff
  -> changed supported files are uploaded/indexed in Dify
  -> n8n posts sync-progress callbacks
  -> UI polls sync-status/history and sync-job logs
```

### RAG Chat

```
Operator -> RAG Assistant -> /gateway/rag/discussions/*
  -> api-gateway
  -> workflow-service
  -> Dify chat API
  -> response stored in RagDiscussionMessage
```

### Logs

Services publish sanitized platform events. `logging-service` stores them in PostgreSQL and attempts non-blocking OpenSearch indexing. The admin logs page queries `/gateway/logs`; step log drawers query `/gateway/logs/sync-job`.

## Security

- Service TLS certificates are issued by Vault PKI and mounted from `/tls`.
- App services use the shared `@platform/tls-runtime` package for HTTPS server setup and outgoing TLS fetches.
- Source tokens, OAuth tokens, OAuth app credentials, and Dify API keys are stored in Vault, not in platform tables.
- The API gateway is the browser-facing API boundary. Workflow and logging services are called through the gateway from the UI.
- n8n sync callbacks use `X-Rag-Sync-Token` or `X-N8N-Webhook-Token`, backed by `N8N_WEBHOOK_TOKEN`.

## Monorepo Layout

```
apps/
  api-gateway/       Fastify gateway, RBAC, OAuth, cert monitor
  logging-service/   log ingest/query service
  web/               Next.js RapidRAG UI
  workflow-service/  RAG orchestration and Dify/n8n integration
packages/
  auth/              auth hook and role utilities
  config/            shared env loader
  contracts/         event names/contracts
  db/                Prisma schema/client
  observability/     logging helpers
  tls-runtime/       TLS/mTLS helper runtime
  ui-kit/            shared React UI primitives
infra/
  docker/            app image Dockerfiles
  keycloak/          realm export and seed helpers
  nginx/             web ingress config
  n8n/               workflow templates/helpers
  postgres/ redis/ rabbitmq/ vault/
```
