# Developer Guide: Platform Architecture

## Active Apps

- `apps/web`: Next.js RapidRAG UI. Primary platform routes are `/dashboard`, `/knowledge-connector`, `/rag-assistant`, `/profile`, plus admin-only `/logs`, `/users`, `/secrets`, and `/security`.
- `apps/api-gateway`: Fastify gateway for JWT/RBAC, OAuth, security/cert APIs, log proxying, and RAG route proxying.
- `apps/workflow-service`: Fastify service that owns RAG knowledge-base state, Dify integration, n8n sync triggering, sharing, and Vault-backed source secrets.
- `apps/logging-service`: Fastify service for `/logs/ingest`, `/logs`, `/logs/timeline`, and `/logs/sync-job`.

## Shared Packages

- `packages/auth`: auth hook and role guard helpers.
- `packages/config`: shared environment loader.
- `packages/contracts`: event contract names.
- `packages/db`: Prisma schema and client.
- `packages/observability`: structured logging helpers.
- `packages/tls-runtime`: HTTPS/mTLS runtime and TLS fetch helpers.
- `packages/ui-kit`: shared React UI primitives.

## Persistence

- Platform data: PostgreSQL via Prisma.
- Incremental sync state: `RagKbFileTracker`.
- Source path filters: `RagKnowledgeBase.sourcePaths`; `sourcePath` is legacy compatibility.
- Secrets/tokens/API keys: Vault KV, not Prisma tables.
- Logs: `PlatformLog` plus optional OpenSearch indexing.
- Dify and n8n each have their own internal PostgreSQL databases.

## Legacy Compatibility

- Flowise is no longer a compose service. `flowiseSessionId` remains in `RagDiscussionThread` only for old thread compatibility.
- `/operations-ai`, `/operations-ai-dify`, and `/operations-ai/setup` redirect to the current RAG routes.
- `/integrations` still renders the source management UI, but the sidebar uses `/knowledge-connector`.
