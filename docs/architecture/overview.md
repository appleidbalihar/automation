# Platform Architecture Overview

## System Purpose

The **Enterprise Automation Platform** is a microservice-based automation system built to support operational AI workflows: ingesting documents from multiple sources, indexing them into a vector knowledge base (Dify RAG), providing a chat interface for operations teams, and broadcasting answers through channels like Slack or Telegram.

---

## High-Level Architecture

```
Browser / Operator
       │
       ▼
  ┌──────────┐  HTTPS/443
  │  Nginx   │  Web Ingress
  │ (ingress)│
  └────┬─────┘
       │
       ▼
  ┌──────────┐  :3000
  │  Next.js │  Web App (UI)
  │  web app │
  └────┬─────┘
       │  /gateway/* proxy
       ▼
  ┌──────────────┐  :4000 mTLS
  │  api-gateway │  Auth · Routing · Cert Monitor
  └──────┬───────┘
         │
    ┌────┴────────────┐
    ▼                 ▼
┌─────────────┐  ┌─────────────┐
│  workflow-  │  │  logging-   │
│  service    │  │  service    │
│  :4001 mTLS │  │  :4005 mTLS │
└──────┬──────┘  └──────┬──────┘
       │                │
  ┌────┴────────────────┴──────────────────┐
  │              Data Layer                │
  │  PostgreSQL+pgvector  Redis  RabbitMQ  │
  └──────────────┬─────────────────────────┘
                 │
  ┌──────────────┴──────────────────────────┐
  │         External Services               │
  │  Dify (RAG)   n8n (Sync)   OpenSearch  │
  │  Keycloak (IAM)  Vault (PKI/Secrets)   │
  └─────────────────────────────────────────┘
```

---

## Service Inventory

| Service | Port | Role |
|---------|------|------|
| web-ingress (Nginx) | 3443 | TLS termination, reverse proxy to web |
| web (Next.js) | 3000 | Operator dashboard and UI |
| api-gateway (Fastify) | 4000 | Central API router, auth, cert monitor |
| workflow-service (Fastify) | 4001 | RAG orchestration, Dify/n8n integration |
| logging-service (Fastify) | 4005 | Log aggregation, OpenSearch shipping |
| PostgreSQL + pgvector | 5432 | Main relational DB + vector store |
| Redis 7 | 6379 | Cache, sessions |
| RabbitMQ 3 | 5671 | Event bus (AMQPS) |
| OpenSearch 2.14 | 9200 | Full-text log search |
| MinIO | 9000 / 9001 | S3-compatible document storage |
| Keycloak 25 | 8443 | Identity, SSO, JWT issuance |
| HashiCorp Vault 1.17 | 8200 | PKI CA, KV2 secrets |
| Dify 0.6.16 | 5001 | RAG engine, knowledge bases |
| n8n | 5678 | Sync workflow orchestration |
| Flowise 2.2.3 | 3001 | Legacy chat (deprecated) |

---

## Network & Security

**All inter-service traffic uses mTLS.** Every application service has a Vault Agent sidecar that:
1. Requests a leaf certificate from Vault's PKI engine
2. Writes `cert.pem`, `key.pem`, and `ca.pem` to a shared `/tls` volume
3. Renews the certificate before expiry and signals the service to reload

**Vault** acts as the single internal Certificate Authority. Vault must be healthy before any service starts.

**Authentication flow:**
```
Browser → Keycloak (login) → JWT issued
JWT sent as Authorization: Bearer on all API calls
api-gateway verifies JWT signature via Keycloak JWKS
Role extracted from JWT claims → RBAC enforcement
```

**Roles:**

| Role | Permissions |
|------|-------------|
| admin | Full access including secrets, users, cert panel |
| useradmin | User management |
| operator | Integrations, sync, chat, logs |
| approver | Approve workflow steps |
| viewer | Read-only access |

---

## Data Flow: Document Sync

```
Operator → /integrations (web) → POST /rag/knowledge-bases/:id/sync
  → api-gateway → workflow-service
  → workflow-service triggers n8n webhook
  → n8n fetches documents (GitHub / GitLab / GDrive / Web)
  → n8n chunks and embeds via Dify API
  → n8n sends progress callbacks → /rag/knowledge-bases/:id/sync-progress
  → RagKbSyncJob record updated in PostgreSQL
  → Operator watches progress in /integrations page
```

---

## Data Flow: Knowledge Base Sync (Smart Diff)

```
Operator → POST /rag/knowledge-bases/:id/sync  (JWT Bearer)
  → api-gateway → workflow-service
  → workflow-service POSTs to n8n webhook

n8n Webhook (async, 200 returned immediately):
  → Parse Sync Params (extract owner/repo from sourceUrl)
  → Init Step Callback → /sync-progress: fetch_file_tree: running
  → Get Repo File Tree  (GitHub/GitLab API, recursive=1)
    ↓ continueOnFail: true
  → Handle Tree Error
      if error: POST /sync-progress fetch_file_tree: failed → throw → Error Trigger
      if ok:    continue
  → POST /sync-diff (workflow-service smart diff)
      workflow-service:
        1. Filter to supported extensions (.md .pdf .docx .csv …)
        2. Compare SHA against RagKbSourcePath table
        3. Return only new/changed files
  → Map Diff Files
      if 0 files: send fetch_file_tree:completed + skip_sync:completed → end
      if files:   send fetch_file_tree:completed + upload_files:running → continue
  → For each changed file (loop):
      Fetch raw file content (GitHub/GitLab raw endpoint)
      Upload to Dify (create_by_text or create_by_file)
      Report File Progress → /sync-progress upload_files:running (filesProcessed++)
  → Aggregate Doc IDs
  → Indexing Start Callback → /sync-progress upload_files:completed|failed
  → Dify Indexing Start CB → /sync-progress dify_indexing:running
  → Poll Dify Indexing (every 5 s, max 24 attempts / ~2 min)
  → Report Final Status → /sync-progress dify_indexing:completed|failed
      workflow-service: upserts RagKbSourcePath with new SHAs

Error path (any unhandled throw):
  n8n Error Trigger → POST /rag/sync-error-handler
    workflow-service: marks job failed, sets running steps to failed

Stale detection (server-side):
  sweepStaleJobs() runs every 60 s in workflow-service
  Jobs with lastProgressAt older than 15 min → status: timed_out

UI monitoring:
  SyncProcessMonitor.tsx polls GET /sync-status every 3 s while job is active
  Shows step table (fetch_file_tree | skip_sync | upload_files | dify_indexing)
  Shows progress bar: filesProcessed / filesTotal
```

See `docs/developer/rag-kb-sync.md` for node-by-node workflow detail and `docs/operations/rag-kb-sync.md` for the operations runbook.

---

## Data Flow: Operations AI Chat

```
Operator → /operations-ai (web) → POST /rag/discussions/:id/messages
  → api-gateway → workflow-service
  → workflow-service → Dify chat API (with conversation ID)
  → Dify queries its vector store + LLM
  → Answer streamed back through workflow-service → api-gateway → web
  → Message stored as RagDiscussionMessage in PostgreSQL
```

---

## Data Flow: Log Ingestion

```
Any service → RabbitMQ "platform.events" exchange
  → logging-service consumes event
  → Masks sensitive fields (passwords, tokens, keys)
  → Stores in PlatformLog (PostgreSQL)
  → Ships to OpenSearch (daily index: platform-logs-YYYY.MM.DD)
  → Operator queries via /logs page
```

---

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript |
| Backend framework | Fastify |
| Frontend framework | Next.js 15 / React 19 |
| Monorepo tooling | Turborepo + pnpm workspaces |
| ORM | Prisma |
| Container runtime | Docker Compose |
| PKI / Secrets | HashiCorp Vault |
| Identity / SSO | Keycloak |
| RAG engine | Dify |
| Sync orchestration | n8n |
| Message bus | RabbitMQ |
| Vector database | pgvector (PostgreSQL extension) |
| Log search | OpenSearch |
| Object storage | MinIO |

---

## Monorepo Layout

```
/
├── apps/
│   ├── api-gateway/          Fastify, :4000
│   ├── workflow-service/     Fastify, :4001
│   ├── logging-service/      Fastify, :4005
│   └── web/                  Next.js,  :3000
├── packages/
│   ├── auth/                 Keycloak JWT verification, RBAC
│   ├── config/               Typed env config loader
│   ├── contracts/            Shared TypeScript interfaces & events
│   ├── db/                   Prisma client + schema
│   ├── observability/        Logging helpers
│   ├── tls-runtime/          mTLS cert reload, AMQP over TLS
│   └── ui-kit/               Shared React components
├── infra/
│   ├── vault/                PKI bootstrap scripts
│   ├── keycloak/             Realm export for seeding
│   ├── nginx/                Ingress config
│   ├── n8n/                  Workflow seed data
│   └── dify/                 Dify app seed data
├── docs/                     Architecture and operations docs
├── docker-compose.yml        Development stack
└── docker-compose.prod.yml   Production stack (image refs)
```
