# RapidRAG — Enterprise RAG Architecture Assessment

**Date:** 2026-05-12
**Author:** Platform Engineering
**Status:** Assessment Complete

---

## 1. Executive Summary

RapidRAG is a RAG-as-a-Service platform built on a TypeScript monorepo (pnpm + Turborepo) with a Docker Compose runtime. It connects document sources (GitHub, GitLab, Google Drive, web URLs, file uploads) to a Dify-backed knowledge base and delivers AI answers through a web UI and Slack. This assessment maps the current state of the platform against the enterprise RAG architecture standard covering the two core pipelines, security, observability, governance, and production readiness.

**Overall Verdict:** The platform has a strong, well-architected foundation. Both RAG pipelines work end-to-end. The security model is solid (Vault PKI, mTLS, RBAC, KB ownership, chat isolation). The biggest gaps are in **observability depth**, **PII pre-processing**, **compliance audit trails**, and the **production deployment** not yet being executed.

## 2. What Is Deployed

### 2.1 Core RAG Pipelines

#### Indexing (Ingestion) Pipeline ✅

| Component | Implementation | Detail |
|-----------|---------------|--------|
| Data Extraction | n8n workflows | GitHub, GitLab, Google Drive, web URL, manual upload sources |
| Chunking & Embedding | Dify (`dify-worker`) | Async indexing worker handles splitting and embedding |
| Vector Storage | pgvector (PostgreSQL) + Dify internal DB | `ankane/pgvector` image; vector extension available |
| Object Storage | MinIO (S3-compatible) | `dify_storage` volume holds uploaded documents |
| Incremental Sync | `RagKbFileTracker` (SHA diff) | Skips unchanged files; tracks Dify document IDs for updates/deletes |
| Sync Orchestration | n8n | `github-to-dify-sync.json` (18-node), `gitlab-to-dify-sync.json` (14-node) |
| Sync Job Tracking | `RagKbSyncJob` model | Per-step JSON progress updated via n8n webhook callbacks |

#### Generation (Inference) Pipeline ✅

| Component | Implementation | Detail |
|-----------|---------------|--------|
| Query Processing | `POST /rag/discussions/:id/messages` → workflow-service | JWT-authenticated, thread-owner enforced |
| Retrieval | Dify vector search | Configurable `topK` (default 4) and score threshold (default 0.4) |
| Hybrid Search | Dify BM25 + vector | Enabled globally — catches exact command strings and semantic matches |
| Augmentation & Generation | Dify LLM orchestration | Supports multiple LLM providers (fuelix.ai/gemini configured) |
| Multi-KB Fan-Out | Parallel Dify calls | Queries multiple KBs simultaneously; labeled per-KB answers returned |
| Conversation Context | `RagDiscussionKbSession` | Per-KB Dify `conversation_id` tracked for follow-up continuity |
| Topic Detection | 3-stage classifier | Explicit phrases, back-references, 35% keyword overlap heuristic |
| Thread Lifetime | 30-minute inactivity expiry | Configurable in `workflow-service/src/main.ts` |
| Dify Key Auto-Recovery | On-demand 401 heal | Login → new API key → Vault update → single retry, zero overhead on happy path |

### 2.2 Security and Access Control

| Feature | Status | Detail |
|---------|--------|--------|
| Authentication | ✅ | Keycloak OIDC/JWT — full OAuth flow with realm `automation-platform` |
| RBAC | ✅ | 5 roles: admin, useradmin, operator, approver, viewer |
| mTLS (service-to-service) | ✅ | Vault PKI CA issues certs; Vault Agent sidecars render into `/tls/*` per service |
| TLS Certificate Hot-Reload | ✅ | `packages/tls-runtime` hot-reloads certs in-process without restart |
| Cert Rotation Controller | ✅ | `cert-rotation-controller` sidecar + `rotation_control` queue |
| Secret Management | ✅ | HashiCorp Vault KV — all API keys, OAuth tokens, Dify keys, Slack tokens |
| KB Ownership Model | ✅ | Every KB has an explicit `ownerId`; no global scope; admin-only visibility override |
| Pre-Retrieval Access Filtering | ✅ | KB list filtered: `ownerId = me` OR `RagKbShare.sharedWithId = me` |
| KB Sharing (granular) | ✅ | `RagKbShare` table — owner/admin can share with specific users; `chat` permission only |
| Chat Session Isolation | ✅ | `RagDiscussionThread.ownerId` — strict per-user; admin cannot see other users' threads |
| n8n Callback Auth | ✅ | `X-Rag-Sync-Token` / `X-N8N-Webhook-Token` on sync callbacks |
| Log Masking | ✅ | Logging-service recursive PII masking on ingested payloads |
| Slack Signature Verification | ✅ | HMAC-SHA256 with 5-minute timestamp skew check on every Slack event |
| Slack Deduplication | ✅ | Redis `SET NX EX 300` on `event_id` prevents duplicate Dify calls on Slack retries |
| Rate Limiting | ⚠️ | App-level Slack rate-limit env vars designed; nginx `limit_req` optional, not enabled |
| Post-Retrieval Authorization | ❌ | Only pre-retrieval filtering; no second check after vector search returns results |
| Prompt Injection Protection | ⚠️ | Retrieval scoping exists; no explicit output validation / output gating layer |
| PII Pre-Ingestion Redaction | ❌ | No automated PII stripping before documents are chunked and embedded |
| ReBAC (SpiceDB/Auth0 FGA) | ❌ | Binary model only (owner or shared-with); no role inheritance or hierarchical ACL |

### 2.3 Infrastructure and Services

All services run in Docker Compose (~30 containers total in dev).

| Container | Category | Port(s) | Status |
|-----------|----------|---------|--------|
| `web` | App | 3000 | ✅ Next.js platform UI |
| `web-ingress` | App | 3443 | ✅ Nginx HTTPS ingress |
| `api-gateway` | App | 4000 | ✅ Fastify JWT/RBAC gateway |
| `workflow-service` | App | 4001 | ✅ RAG orchestration |
| `logging-service` | App | 4005 | ✅ Log ingest and query |
| `postgres` + pgvector | Infra | 5432 | ✅ Platform DB with vector extension |
| `redis` | Infra | 6379 | ✅ Cache, nonce, Slack dedup store |
| `rabbitmq` | Infra | 5671/15671 | ✅ AMQPS event bus |
| `opensearch` | Infra | 9200/9600 | ✅ Log search backend |
| `minio` | Infra | 9000/9001 | ✅ S3-compatible object storage |
| `keycloak` | Infra | 8443 | ✅ Identity provider |
| `vault` | Infra | 8200 | ✅ PKI CA + KV secret store |
| `dify-api` | Dify | 5001 | ✅ Dataset, app, chat, document indexing |
| `dify-worker` | Dify | internal | ✅ Async embedding/indexing worker |
| `dify-web` | Dify | 3002 | ✅ Dify admin console |
| `dify-sandbox` | Dify | internal | ✅ Code execution sandbox |
| `n8n` | n8n | 5679 | ✅ Sync workflow runner |
| `vault-bootstrap` | Sidecar | — | ✅ Vault init/unseal job |
| `db-migrate` | Sidecar | — | ✅ Prisma migration job |
| `cert-rotation-controller` | Sidecar | — | ✅ TLS cert rotation |
| `*-vault-agent` | Sidecar | — | ✅ Per-service TLS cert rendering |

**Deployment model:** Docker Compose with offline production capability via GitLab Container Registry images (`docker-compose.prod.yml` — no internet pulls required).

### 2.4 Observability and Monitoring

| Feature | Status | Detail |
|---------|--------|--------|
| Structured Logging | ✅ | `packages/observability` — RabbitMQ event consumption + PostgreSQL storage |
| Log Explorer UI | ✅ | `/logs` page — correlation filter, timeline, sync-job scoped views |
| OpenSearch Integration | ✅ | Best-effort non-blocking log indexing |
| RAG Stats Page | ✅ | `/rag-stats` — response timing, query count, usage metrics |
| TLS Health Diagnostics | ✅ | `GET /security/tls` per backend service |
| Sync Job Progress | ✅ | Real-time step tracking via n8n webhook callbacks; displayed in Knowledge Connector UI |
| OpenTelemetry / Distributed Tracing | ❌ | Not implemented — no trace IDs across pipeline stages |
| RAGAS Answer Quality Metrics | ❌ | No faithfulness, groundedness, or relevance scoring |
| Retrieval Metrics (Recall@k, MRR) | ❌ | Not tracked — no signal on retrieval effectiveness |
| Per-Stage Latency Breakdown | ❌ | No instrumentation of retrieval vs. LLM vs. total latency |
| Token Usage Cost Tracking | ❌ | No per-query or per-tenant token spend logging |
| Alerting / Notifications | ❌ | No alert rules on error rates, latency thresholds, or cert expiry |

### 2.5 Governance and Operations

| Feature | Status | Detail |
|---------|--------|--------|
| Prompt Template Management | ✅ | `SystemPromptTemplate` — built-in/private/shared/all scopes; CRUD at `/ai-agent-prompt` |
| Template Application to KB | ✅ | Template applied to `RagKnowledgeBaseConfig`; pushed to Dify app on apply |
| RAG Retrieval Tuning | ✅ | Score threshold, top-k, hybrid search configurable per KB via Knowledge Connector UI |
| AI Agent Tuning Documentation | ✅ | `docs/operations/rag-ai-agent-tuning.md` — full ops guide with symptom tables |
| Sync Retry & Cancel | ✅ | Manual retry and cancel for failed/stuck sync jobs via UI |
| Vault Secret Management UI | ✅ | `/secrets` page — admin can read/write Vault paths directly |
| User Management | ✅ | `/users` page — admin can manage users |
| Scheduled Sync | ⚠️ | `syncSchedule` field exists in DB schema; cron runner not yet wired to execute |
| Knowledge Base Versioning | ❌ | No index snapshots or rollback capability; Dify manages index internally |
| Prompt Versioning / A-B Testing | ❌ | No version history or comparison between prompt configurations |
| Vector Index Atomic Swap | ❌ | No shadow-write + atomic swap for zero-downtime re-indexing |
| Data Lineage Tracking | ⚠️ | `RagKbSyncJob` has audit fields; not structured for GDPR/HIPAA lineage export |
| Compliance Audit Export | ❌ | Logs exist; not in GDPR/SOX/HIPAA structured export format |
| Multi-Tenancy Isolation | ✅ | Per-user KB ownership + share model enforces tenant isolation |

### 2.6 Chat Channels (External Messaging)

| Feature | Status | Detail |
|---------|--------|--------|
| Slack OAuth Install (bot-first) | ✅ | Platform-owned RapidRAG Bot; OAuth `chat:write`, `commands`, `im:history` scopes |
| Slack DM messaging | ✅ | `handleSlackMessage()` — Dify query + Slack reply via `response_url`/`chat.postMessage` |
| Slack `/kb` slash commands | ✅ | `list`, `use`, `all`, `status`, `reset`, `help` subcommands |
| Allowlist access mode | ✅ | Per-deployment Slack user ID whitelist stored in DB |
| Multi-KB Slack responses | ✅ | Parallel Dify calls; labeled per-KB answers merged in reply |
| Chat History Drawer (UI) | ✅ | Paginated per-deployment conversation history with clear/delete |
| Slack event deduplication | ✅ | Redis `SET NX EX 300` prevents duplicate bot replies on Slack retries |
| Slack end-to-end verification | ⚠️ | Dev checklist: all steps ✅ except "Full end-to-end Slack verification" |
| Telegram integration | ❌ | DB schema supports `origin="telegram"` but no implementation yet |
| Google Chat integration | ❌ | DB schema supports `origin="google_chat"` but no implementation yet |
| WhatsApp integration | ❌ | Not planned; referenced in legacy `RagChannelDeployment.channelType` only |

---

## 3. What Is Missing (Gaps)

### 3.1 High Priority Gaps

These gaps carry compliance risk, answer-quality risk, or block production.

| # | Gap | Enterprise Requirement | Risk |
|---|-----|----------------------|------|
| H1 | **PII Pre-Ingestion Redaction** | Strip PII from documents BEFORE chunking and embedding | GDPR/HIPAA compliance — once embedded, PII cannot be surgically removed without full re-indexing |
| H2 | **OpenTelemetry Distributed Tracing** | Full trace IDs across retrieval → LLM → response pipeline | Cannot diagnose latency bottlenecks or audit which chunks triggered which answers |
| H3 | **RAG Quality Metrics (RAGAS)** | Faithfulness, relevance, groundedness scoring per query | No signal when answer quality degrades — users notice before the platform does |
| H4 | **Retrieval Metrics (Recall@k, MRR)** | Measure whether the right chunks are actually retrieved | No evidence the vector index is returning relevant content |
| H5 | **Post-Retrieval Authorization Check** | Re-verify user permissions after vector search returns results | Pre-retrieval filter alone can miss edge cases in shared KB scenarios |
| H6 | **Output Gating / Output Validation** | Scan LLM output before returning to user | Risk of sensitive data leakage across KBs; prompt injection from malicious doc content |
| H7 | **Production Deployment** | Platform running on `rapidrag.ai` | 0/36 production tasks (P1–P36) completed; platform is dev-only |
| H8 | **LLM Provider Configuration** | Dify LLM + embedding model configured (D2/D3) | Without embedding model, all KB indexing fails silently |

### 3.2 Medium Priority Gaps

| # | Gap | Enterprise Requirement | Risk |
|---|-----|----------------------|------|
| M1 | **Scheduled Sync Execution** | Cron-driven KB refresh | `syncSchedule` field in DB; cron runner not wired — KBs must be manually synced |
| M2 | **Reranking Layer** | Reorder retrieved chunks before LLM call | Missing reranker passes all top-k chunks unordered to LLM; can cut token cost 80% when added |
| M3 | **Token Usage / Cost Tracking** | Per-query and per-tenant LLM spend logging | No billing data; cannot build "chunk-as-a-service" pricing model for tenants |
| M4 | **Vector Index Versioning & Rollback** | Shadow-write + atomic swap for zero-downtime re-indexing | Dify restart or re-index = downtime + stale Vault API key problem |
| M5 | **Prompt Versioning & A-B Testing** | Track prompt iterations; compare answer quality | No version history on prompt templates; can't safely roll back a bad prompt change |
| M6 | **Compliance Audit Export** | GDPR/HIPAA/SOX structured audit trail export | Platform logs exist but not in regulatory export format |
| M7 | **Horizontal Autoscaling (Kubernetes)** | HPA for services under load | Docker Compose only; no K8s deployment manifests or autoscaling |
| M8 | **Alerting & Notifications** | Alerts on error rates, latency SLOs, cert expiry | No alert rules; ops team discovers issues reactively |
| M9 | **ReBAC (Relationship-Based Access Control)** | SpiceDB/Auth0 FGA for complex permission hierarchies | Current binary model (owner/shared) cannot express inheritance or org-level roles |

### 3.3 Low Priority / Future Gaps

| # | Gap | Detail |
|---|-----|--------|
| L1 | Telegram Integration | Schema ready (`origin="telegram"`); backend + frontend not built |
| L2 | Google Chat Integration | Schema ready (`origin="google_chat"`); backend + frontend not built |
| L3 | Embedding Model Strategy | Single global model; no per-KB model selection (e.g., code vs. English text) |
| L4 | Vector Encryption Proxy | Encrypting embeddings at-rest AND during search (advanced Pinecone enterprise feature) |
| L5 | Dark/Light Mode UI | Enterprise SRS calls for theme switcher; not yet implemented |
| L6 | WCAG Accessibility Compliance | Enterprise SRS recommendation; not verified |
| L7 | Workflow Versioning | Original SRS requirement (Section 15); not in current platform scope |
| L8 | SLA Monitoring | Original SRS requirement (Section 15); not implemented |
| L9 | Notification System | Original SRS requirement (Section 15); not implemented |

---

## 4. Production Deployment Status

**Target:** `rapidrag.ai`
**Current State:** Development environment fully operational (all 34 containers running in dev since 2026-05-08 rebuild).

### Outstanding Blockers (must fix before any production deploy)

| Priority | Blocker | Task Reference |
|----------|---------|---------------|
| 🔴 Critical | Dify LLM provider not configured — without embedding model, all KB indexing fails | D2, D3 |
| 🔴 Critical | Production environment not provisioned | P1–P11 |
| 🔴 Critical | LLM API key not seeded to Vault (`platform/global/llm`) | D3, P23 |
| 🔴 Critical | Dify admin account not created in prod | P20 |
| 🟡 High | n8n workflows not imported/activated in prod | P15–P19 |
| 🟡 High | Slack platform bot app not created for prod | P31 |
| 🟡 High | SSL certificate + outer nginx not configured for `rapidrag.ai` | P25–P26 |
| 🟡 High | OAuth callback URLs (GitHub, GitLab, Google) not configured for prod | P24 |
| 🟢 Normal | Smoke tests not run | P27 |
| 🟢 Normal | Certbot auto-renewal not enabled | P28 |

**Production task completion: 0 / 36 tasks (P1–P36 all ⬜)**

---

## 5. Score Card Summary

| RAG Domain | Score | Deployed | Key Gap |
|-----------|-------|---------|---------|
| Indexing Pipeline | 90% | SHA-diff incremental sync, n8n orchestration, Dify embedding, pgvector | Scheduled cron not wired; no PII pre-sanitization |
| Generation Pipeline | 85% | Hybrid search, multi-KB fan-out, topic detection, Dify key auto-recovery | No reranking; no output gating; no token cost tracking |
| Security & Access Control | 70% | Vault PKI/mTLS, RBAC, KB ownership, chat isolation, Slack HMAC | PII pre-ingestion missing; no post-retrieval auth; no ReBAC |
| Observability | 35% | Structured logs, RAG stats, TLS diagnostics, sync job progress | No OpenTelemetry; no RAGAS metrics; no Recall@k; no alerting |
| Governance | 55% | Prompt templates, retrieval tuning, secret UI, user management | No index versioning; no prompt A-B testing; no compliance export |
| Multi-Tenancy | 80% | Per-user KB ownership, RagKbShare, strict thread isolation | ReBAC not implemented; no org-level permission hierarchy |
| Production Readiness | 10% | Dev stack complete and stable | Production deployment not started; LLM not configured |
| Chat Channels | 85% | Full Slack bot-first integration; dedup; multi-KB; allowlist | Full E2E verification pending; Telegram/Google Chat not built |

### Legend
- **90–100%** — Production-grade, enterprise-ready
- **70–89%** — Solid foundation, minor gaps
- **50–69%** — Functional but notable gaps
- **Below 50%** — Significant work needed
