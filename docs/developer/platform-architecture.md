# Developer Guide: Platform Architecture

## Active Apps

- `apps/web`: Next.js RapidRAG UI. Primary platform routes are `/dashboard`, `/knowledge-connector`, `/rag-assistant`, `/profile`, `/ai-agent-prompt`, plus admin-only `/rag-stats`, `/logs`, `/users`, `/secrets`, and `/security`.
- `apps/api-gateway`: Fastify gateway for JWT/RBAC, OAuth, security/cert APIs, log proxying, RAG route proxying, n8n callback auth, and certificate rotation queueing.
- `apps/workflow-service`: Fastify service that owns RAG knowledge-base state, Dify integration, n8n sync triggering/cancellation, sharing, prompt templates, RAG stats, and Vault-backed source secrets.
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
- Prompt templates: `SystemPromptTemplate` and `SystemPromptTemplateShare`; KBs reference templates through `RagKnowledgeBase.templateId`.
- Multi-KB chat continuity: `RagDiscussionKbSession`; legacy `flowiseSessionId` remains only for old thread compatibility.
- Secrets/tokens/API keys: Vault KV, not Prisma tables.
- Logs: `PlatformLog` plus optional OpenSearch indexing.
- Dify and n8n each have their own internal PostgreSQL databases.

## Legacy Compatibility

- Flowise is no longer a compose service. `flowiseSessionId` remains in `RagDiscussionThread` only for old thread compatibility.
- `/operations-ai`, `/operations-ai-dify`, and `/operations-ai/setup` redirect to the current RAG routes.
- `/integrations` still renders the source management UI, but the sidebar uses `/knowledge-connector`.

## Browser/API Boundary

The web app calls same-origin `/gateway/*` by default. `apps/web/src/app/gateway/[...path]/route.ts` forwards these requests server-side to `WEB_INTERNAL_API_BASE_URL`, which defaults to `https://api-gateway:4000`. `NEXT_PUBLIC_API_BASE_URL` can override this, but the browser falls back to `/gateway` when a remote host would otherwise use `localhost` or `127.0.0.1`.

All browser-facing RAG, logs, secrets, OAuth, security, and stats APIs should be added to `apps/api-gateway/src/main.ts` first so RBAC and correlation handling stay centralized. Workflow-only internal routes, such as OAuth token storage and provider credential lookup, remain in `workflow-service`.
