# RapidRAG — Product FAQ

**Audience:** End users, operators, and administrators  
**Last updated:** 2026-05-12  
**Purpose:** Authoritative Q&A reference for the RapidRAG platform. This document is the primary knowledge source for the AI chat agent answering product and compliance questions.

---

## Table of Contents

1. [What Is RapidRAG?](#1-what-is-rapidrag)
2. [Getting Started](#2-getting-started)
3. [Knowledge Bases — Creating & Syncing](#3-knowledge-bases--creating--syncing)
4. [Asking Questions — The RAG Chat Interface](#4-asking-questions--the-rag-chat-interface)
5. [Slack Integration](#5-slack-integration)
6. [User Management & Access Control](#6-user-management--access-control)
7. [Security & Compliance](#7-security--compliance)
8. [Observability & Monitoring](#8-observability--monitoring)
9. [AI Agent & Prompt Tuning](#9-ai-agent--prompt-tuning)
10. [Troubleshooting](#10-troubleshooting)
11. [Infrastructure & Architecture](#11-infrastructure--architecture)

---

## 1. What Is RapidRAG?

**Q: What is RapidRAG?**  
A: RapidRAG is a RAG-as-a-Service (Retrieval-Augmented Generation) platform that connects your organization's document sources — GitHub repositories, GitLab projects, Google Drive folders, web URLs, and file uploads — to an AI knowledge base. Users can ask natural-language questions and receive answers grounded in your actual documents, not generic AI training data.

**Q: What problem does RapidRAG solve?**  
A: It eliminates the need to search through repositories, wikis, and documents manually. Instead of reading 200 files to answer "what does the deployment pipeline do," you ask RapidRAG and get a precise answer with the source content behind it.

**Q: What document sources does RapidRAG support?**  
A: Currently supported:
- **GitHub** repositories (public and private, via personal access token)
- **GitLab** repositories (public and private, via personal access token)
- **Google Drive** folders (via OAuth)
- **Web URLs** (crawl and index any web page)
- **File upload** (PDF, Markdown, TXT, and other text formats)

**Q: What AI models does RapidRAG use?**  
A: RapidRAG uses the LLM configured in the platform's Vault secret store (`platform/global/llm`). The default configuration points to fuelix.ai (Gemini-compatible). Administrators can reconfigure this to any OpenAI-compatible API provider. The embedding model is configured separately in Dify.

**Q: Is RapidRAG available as a hosted SaaS?**  
A: The production deployment targets `theaitools.ca`. The platform is currently running in the development environment. Contact your platform administrator for access.

---

## 2. Getting Started

**Q: How do I log in?**  
A: Navigate to the platform URL and click **Sign In**. Authentication is handled by Keycloak using your organization's credentials. If you do not have an account, ask your platform administrator to create one on the `/users` page.

**Q: What roles exist and what can each role do?**  
A: There are five roles:

| Role | Capabilities |
|------|-------------|
| `admin` | Full access — manage users, secrets, all KBs, all settings |
| `useradmin` | Manage users and roles; cannot access secrets or system config |
| `operator` | Create and manage knowledge bases; run syncs; view all logs |
| `approver` | Review and approve sync jobs and content changes |
| `viewer` | Ask questions on KBs shared with them; read-only access |

**Q: I just logged in — what should I do first?**  
A: Go to **Knowledge Connector** and create your first knowledge base by connecting a document source. Once the sync completes, go to **RAG Discussion** and start asking questions.

---

## 3. Knowledge Bases — Creating & Syncing

**Q: How do I create a knowledge base?**  
A: Go to **Knowledge Connector** → **New Knowledge Base**. Give it a name, select a source type (GitHub, GitLab, Google Drive, URL, or upload), provide the credentials and path, then click **Save and Sync**. The sync runs automatically.

**Q: How long does a sync take?**  
A: It depends on the repository or folder size. Typical syncs:
- Small repo (< 100 files): 1–3 minutes
- Medium repo (100–500 files): 3–10 minutes
- Large repo (500+ files): 10–30 minutes

You can track progress in real time on the Knowledge Connector UI — each step reports status as it runs.

**Q: What file types are indexed?**  
A: Text-based formats: `.md`, `.txt`, `.py`, `.ts`, `.js`, `.go`, `.java`, `.yaml`, `.yml`, `.json`, `.html`, `.rst`, `.sh`, `.tf`. Binary files (images, compiled artifacts, etc.) are skipped automatically.

**Q: What is an incremental sync?**  
A: When you trigger a sync on an existing knowledge base, RapidRAG uses SHA-based change detection to skip files that haven't changed. Only new, modified, or deleted files are processed. This makes repeat syncs much faster than the initial full sync.

**Q: How do I trigger a sync manually?**  
A: Open the knowledge base in **Knowledge Connector** and click **Sync Now**. You can also cancel a running sync or retry a failed one from the same page.

**Q: Can syncs run on a schedule?**  
A: The schedule field is available in the UI, but automatic cron execution is not yet active. Syncs must currently be triggered manually. Scheduled sync automation is on the roadmap.

**Q: What happens if a sync fails?**  
A: The sync job is marked as failed and each step reports its error. You can see the failure reason in the sync job detail view. Common causes: expired token, network timeout, or Dify indexing error. After fixing the root cause, click **Retry** to restart from the failed step.

**Q: Are knowledge bases isolated from each other? Could a query on one KB accidentally return results from another KB?**  
A: Yes, each knowledge base is completely isolated. Every knowledge base is backed by its own separate dataset with its own independent vector index and keyword index. There is no shared index between knowledge bases — retrieval is strictly scoped so a query on KB A can only return content from KB A, never from KB B. This also means keyword relevance weights (used in hybrid search) are calibrated independently per knowledge base, so domain-specific terminology ranks correctly within its own context without being diluted by content from other KBs.

**Q: Can I delete a knowledge base?**  
A: Yes. Deleting a KB removes it from the platform and removes all associated documents from the vector index. This action is not reversible without re-syncing.

---

## 4. Asking Questions — The RAG Chat Interface

**Q: How do I ask a question?**  
A: Go to **RAG Discussion** in the navigation menu. Select one or more knowledge bases from the selector, type your question, and press Enter. The platform queries the selected KBs in parallel and returns a labeled answer for each.

**Q: Can I query multiple knowledge bases at once?**  
A: Yes. Select multiple KBs in the selector before sending your message. RapidRAG fans out to all selected KBs simultaneously and presents each KB's answer separately, so you can see which knowledge base answered and with what content.

**Q: How does RapidRAG decide what context to retrieve?**  
A: It uses hybrid search — combining vector (semantic) search and BM25 (keyword) search via Dify. The top-K most relevant chunks (default: 10) above a relevance score threshold (default: 0.3) are retrieved and passed to the LLM. Both parameters are configurable per KB by operators.

**Q: What is a discussion thread?**  
A: A discussion thread is a conversation session. The platform maintains context across messages within a thread so you can ask follow-up questions ("what about the retry logic?" after asking about error handling). Threads expire after 30 minutes of inactivity.

**Q: Can I see my previous conversations?**  
A: Yes. Click the **History** icon in the RAG Discussion UI to see your past threads. Each thread shows the first question and the timestamp. Threads are private — only you (and platform admins) can see your conversations.

**Q: What if the AI doesn't know the answer?**  
A: If no relevant content is found above the score threshold, the platform responds with "I couldn't find relevant information in the knowledge base." This is by design — RapidRAG only answers from retrieved content, not from general AI knowledge, to prevent hallucination.

**Q: How fresh is the information in my knowledge base?**  
A: As fresh as the last successful sync. The sync timestamp is shown on each KB in the Knowledge Connector UI. If your source documents have changed since the last sync, trigger a new sync before asking questions.

---

## 5. Slack Integration

**Q: How does the Slack integration work?**  
A: RapidRAG has a Slack bot (RapidRAG Bot) that you can install to your workspace. Once installed, you can send direct messages to the bot to ask questions, or use slash commands to manage which knowledge base the bot queries.

**Q: How do I install the Slack bot?**  
A: Go to **Chat Channels** in the platform UI, click **Connect Slack**, and follow the OAuth authorization flow. Your workspace admin may need to approve the bot installation.

**Q: What slash commands does the bot support?**  
A: The `/kb` command manages the bot's active knowledge base:

| Command | Description |
|---------|-------------|
| `/kb list` | List KBs you have access to |
| `/kb use <name>` | Set the active KB for this conversation |
| `/kb all` | Query all your accessible KBs |
| `/kb status` | Show which KB is currently active |
| `/kb reset` | Clear the active KB selection |
| `/kb help` | Show available commands |

**Q: Can every Slack user in my workspace use the bot?**  
A: No. Access is controlled by an allowlist of Slack user IDs configured per deployment. Only allowlisted users receive answers; unauthorized users get a polite access-denied message. The allowlist is managed in the **Chat Channels** settings.

**Q: Is the Slack integration secure?**  
A: Yes. Every incoming Slack event is verified using HMAC-SHA256 signature validation against the Slack signing secret, with a 5-minute timestamp skew window to prevent replay attacks. Duplicate events are deduplicated using Redis to prevent double-replies on Slack retries.

**Q: Can the bot query multiple KBs at once in Slack?**  
A: Yes. Using `/kb all` or `/kb use` with multiple KBs selected, the bot queries all of them in parallel and combines the labeled answers in its reply.

---

## 6. User Management & Access Control

**Q: How do I create a new user?**  
A: Go to **Users** (admin or useradmin role required) → **New User**. Provide their name, email, and initial role. The user receives login credentials via Keycloak.

**Q: How do I share a knowledge base with another user?**  
A: Open the KB in **Knowledge Connector** → **Sharing** tab → **Add User**. You can share with specific users and grant them `chat` permission (read and query). Sharing is explicit — no user can access a KB they haven't been granted access to, even if they know the KB ID.

**Q: What is the difference between KB ownership and KB sharing?**  
A: The **owner** created the KB and has full control (edit, sync, delete, share, configure). A **shared-with** user has `chat` permission only — they can query the KB in RAG Discussion and Slack but cannot modify, sync, or delete it.

**Q: Can an admin see all knowledge bases?**  
A: Yes. Admins have a visibility override that allows them to see and manage all KBs regardless of ownership. Non-admin users see only their own KBs and KBs explicitly shared with them.

**Q: Can an admin see other users' chat conversations?**  
A: No. Discussion threads are strictly scoped by `ownerId`. Even admins cannot browse another user's chat history through the UI. Log data (with PII masking applied) is accessible via the `/logs` admin page for audit purposes.

**Q: What happens when a shared KB access is revoked mid-session?**  
A: RapidRAG performs a post-retrieval authorization check on every message. If a share is revoked while you are in an active thread, the revoked KB is silently dropped from subsequent queries. You will not receive an error, but answers from that KB will stop appearing.

---

## 7. Security & Compliance

**Q: Is PII stripped from documents before they are indexed?**  
A: Yes (as of 2026-05-12). The n8n sync workflows apply automated PII redaction before any document content is embedded into the vector store. The following patterns are detected and replaced:
- Email addresses → `[EMAIL REDACTED]`
- Phone numbers → `[PHONE REDACTED]`
- API keys and tokens (sk-, ghp_, glpat-, xox*) → `[SECRET REDACTED]`
- Credit card numbers (13–16 digit patterns) → `[CC REDACTED]`

Redaction counts are logged per file for audit purposes.

**Q: Does RapidRAG prevent sensitive data from leaking in AI answers?**  
A: Yes. Output gating is active on all LLM responses (both web and Slack paths). Before any answer is stored or returned to the user, it is scanned for API key patterns, token strings, and prompt-injection markers. Answers containing detected sensitive content are blocked and a warning is logged. This control can be toggled via the `OUTPUT_GATING_ENABLED` environment variable.

**Q: How are API keys and secrets managed?**  
A: All secrets (LLM API keys, OAuth client secrets, Dify credentials, Slack tokens, database passwords) are stored exclusively in HashiCorp Vault KV. No secrets appear in environment files, Docker Compose files, or source code. Vault Agent sidecars render credentials into each service at runtime via mTLS-authenticated API calls.

**Q: How is service-to-service communication secured?**  
A: All internal service communication uses mutual TLS (mTLS). Vault PKI issues certificates for each service. Certificate hot-reload (`packages/tls-runtime`) allows cert rotation without service restarts. The `cert-rotation-controller` sidecar automates the rotation lifecycle.

**Q: How is user authentication handled?**  
A: Authentication uses Keycloak as the OIDC/OAuth2 identity provider with the `automation-platform` realm. All API requests require a valid JWT issued by Keycloak. The API gateway validates the JWT and enforces RBAC on every route before proxying to backend services.

**Q: Is there audit logging for access and queries?**  
A: Yes. All platform events (sync jobs, RAG queries, authentication events, admin actions) are ingested into the structured logging system and indexed in OpenSearch. Logs are queryable via the `/logs` admin page with filters for service, level, correlation ID, and time range. All log payloads are recursively scanned for PII before storage.

**Q: Is there distributed tracing across the RAG pipeline?**  
A: Yes (as of 2026-05-12). Every inbound request to the workflow-service is assigned a unique `traceId` via `AsyncLocalStorage`. The `traceId` propagates through all structured log events for that request, enabling end-to-end correlation of a RAG query across gateway, retrieval, LLM call, and database write.

**Q: Does RapidRAG meet GDPR requirements?**  
A: RapidRAG implements key GDPR-relevant controls: PII pre-ingestion redaction (H1), output gating (H6), post-retrieval authorization (H5), strict user data isolation (threads, KBs), and structured audit logging. Formal GDPR/HIPAA compliance audit export (structured lineage reports) is on the roadmap (gap M6) but not yet available.

**Q: What compliance controls are currently active?**  
A: As of 2026-05-12, all six high-priority compliance controls are verified in production:

| ID | Control | Status |
|----|---------|--------|
| H1 | PII Pre-Ingestion Redaction | ✅ Active |
| H2 | Distributed Tracing (traceId per request) | ✅ Active |
| H3 | RAG Answer Quality — Faithfulness scoring | ✅ Active |
| H4 | RAG Answer Quality — Relevance scoring | ✅ Active |
| H5 | Post-Retrieval Authorization re-check | ✅ Active |
| H6 | Output Gating / Output Validation | ✅ Active |

---

## 8. Observability & Monitoring

**Q: Where can I see platform logs?**  
A: Go to **Logs** in the navigation menu (operator or admin role required). You can filter by service, log level, correlation ID, and time range. Logs are stored in PostgreSQL and indexed in OpenSearch for full-text search.

**Q: Where can I see RAG usage statistics?**  
A: Go to **RAG Stats** (`/rag-stats`). This page shows query counts, response timing, and per-KB usage metrics. Answer quality scores (faithfulness and relevance) are stored per message in `RagAnswerQualityLog` and will be surfaced here as the dashboard evolves.

**Q: How is answer quality measured?**  
A: After each RAG response, an asynchronous quality evaluation fires in the background (never blocking the chat response). It sends the question and answer to the configured LLM with a structured prompt asking it to rate:
- **Faithfulness** (0.0–1.0): Is the answer grounded in retrieved content, with no hallucination?
- **Relevance** (0.0–1.0): Does the answer actually address the question?

Scores are stored in `RagAnswerQualityLog` and are queryable for trend analysis. Enable via `QUALITY_EVAL_ENABLED=true`.

**Q: How do I monitor sync job progress?**  
A: Open the knowledge base in **Knowledge Connector**. The sync progress panel shows each step in real time (webhook callbacks from n8n update the step status). Completed, running, and failed steps are shown with timestamps and error details.

**Q: Is there alerting when something goes wrong?**  
A: Not yet. Alerting on error rates, latency thresholds, and certificate expiry is planned (gap M8) but not currently implemented. For now, monitor the `/logs` page and RAG Stats page for anomalies.

**Q: How do I check TLS certificate health?**  
A: Each backend service exposes a `GET /security/tls` endpoint that returns the current certificate details (expiry, issuer, SANs). The `/security` page in the platform UI aggregates TLS health across all services.

---

## 9. AI Agent & Prompt Tuning

**Q: Can I customize how the AI answers questions for my knowledge base?**  
A: Yes. Go to **AI Agent Prompt** (`/ai-agent-prompt`) to manage system prompt templates. Templates control the AI's persona, answer style, language, and any domain-specific instructions. You can create private templates (for yourself), shared templates (for your org), or use the built-in defaults.

**Q: How do I apply a custom prompt to my knowledge base?**  
A: In **Knowledge Connector**, open the KB and go to the **AI Settings** tab. Select a template from the dropdown and click **Apply**. The template is pushed to the Dify app backing that KB.

**Q: Can I adjust how many results the AI retrieves before answering?**  
A: Yes. In the KB's **Retrieval Settings** tab, you can configure:
- **Top-K**: Number of chunks retrieved (default: 10)
- **Score Threshold**: Minimum relevance score to include a chunk (default: 0.3, range: 0.0–1.0)
- **Reranker**: Whether to rerank retrieved chunks before passing them to the LLM (default: disabled)
- **Hybrid Search**: Toggle BM25+vector hybrid mode on/off

Higher Top-K gives the LLM more context but may increase latency and token cost. Higher score threshold gives more precise results but may result in "no answer found" for borderline queries.

**If answers are missing content you know is in the document**, try these in order:
1. Increase Top-K (e.g. 10 → 15 or 20) — for long documents with multiple sections
2. Lower Score Threshold (e.g. 0.3 → 0.2) — if relevant chunks are being filtered out
3. Disable the Reranker — if enabled, it can demote the correct chunks; disabling it lets vector scores decide directly

**Q: What is hybrid search and should I use it?**  
A: Hybrid search combines vector similarity (semantic meaning) with BM25 keyword matching. It is enabled by default and recommended for most use cases. It is particularly effective when users ask about exact command names, error codes, or technical identifiers that pure semantic search might miss. Disable it only if your documents are purely narrative with no technical terms.

**Q: How do I improve answer quality when results are poor?**  
A: See [docs/operations/rag-ai-agent-tuning.md](rag-ai-agent-tuning.md) for a full symptom/solution table. Common adjustments:
- Lower the score threshold if the AI says "no information found" too often
- Raise the score threshold if answers are off-topic or irrelevant
- Increase Top-K if answers are missing context that's clearly in the documents
- Update the system prompt to instruct the AI to focus on specific content types

---

## 10. Troubleshooting

**Q: The AI says "I couldn't find relevant information" but the answer is definitely in my documents.**  
A: This usually means the score threshold is too high, the reranker demoted the right chunks, or Top-K is too low. Try these steps in order:
1. **Increase Top-K** on the KB (default is 10 — try 15 or 20 for long technical documents with many sections)
2. **Lower the score threshold** (from 0.3 to 0.2 or 0.1) — the relevant chunk may be scoring just below the cutoff
3. **Disable the Reranker** in the KB's Retrieval Settings — if enabled, the reranker model can incorrectly demote correct chunks; disabling it lets the raw vector similarity scores determine the order
4. Rephrase your question using exact keywords or section titles that appear in the document
5. Ensure the last sync was successful and recent — trigger a new sync if in doubt
6. Check that the specific file type is in the supported list

**Note:** After changing retrieval settings, trigger a KB sync to push the new config to the vector index.

**Q: My sync is stuck in "Running" and hasn't progressed for 10+ minutes.**  
A: Check the sync job detail view for the last successful step. Common causes:
- GitHub/GitLab token expired or permissions changed — re-enter the token
- Dify API key stale — the platform auto-recovers Dify keys on next request; trigger a sync retry
- Network timeout during large file fetch — click **Retry** to resume from the failed step

**Q: I get a 401 error when trying to access a knowledge base.**  
A: Your session may have expired. Log out and log back in. If the issue persists, the KB may no longer be shared with you — check with the KB owner.

**Q: The Slack bot is not responding to my messages.**  
A: Check the following:
1. Your Slack user ID is on the allowlist for the deployment (ask the platform admin)
2. The bot has an active KB selected — try `/kb list` to see available KBs
3. The platform is running — the admin can check container status
4. Check the `/logs` admin page for `handleSlackMessage` errors filtered by your Slack user ID

**Q: How do I see why a specific sync step failed?**  
A: In **Knowledge Connector** → open the KB → click the failed sync job → expand the failed step. The error message and stack trace (if available) are shown inline. For more detail, search `/logs` for the sync job ID.

**Q: The /security page shows a TLS warning for a service.**  
A: A TLS warning means a service certificate is nearing expiry or has an issue. Go to **Secrets** → trigger a cert rotation, or check the `cert-rotation-controller` container logs for rotation errors. If the cert is already expired, a service restart may be needed after rotation.

**Q: How do I reset an active RAG discussion thread?**  
A: In the RAG Discussion UI, click the **New Thread** button to start a fresh conversation. The old thread is preserved in history. If you want to clear a Slack bot session, use `/kb reset`.

---

## 11. Infrastructure & Architecture

**Q: What is the platform's technology stack?**  
A: RapidRAG is a TypeScript monorepo (pnpm + Turborepo) running on Docker Compose (~30 containers). Key components:

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js (React) |
| API Gateway | Fastify + Keycloak JWT |
| RAG Orchestration | Fastify (workflow-service) |
| Vector Search | Dify (pgvector + BM25 hybrid) |
| Sync Orchestration | n8n |
| Database | PostgreSQL + pgvector |
| Cache / Dedup | Redis |
| Message Bus | RabbitMQ (AMQPS) |
| Log Search | OpenSearch |
| Object Storage | MinIO (S3-compatible) |
| Identity | Keycloak OIDC |
| Secret / PKI | HashiCorp Vault |
| AI Orchestration | Dify (LLM + embedding + vector) |

**Q: Where does the vector index live?**  
A: The vector index is managed by Dify and stored in the `dify-db` PostgreSQL container using the `pgvector` extension. Document chunks and their embeddings are stored there. Object storage (raw document files) lives in MinIO.

**Q: How many services are running?**  
A: Approximately 30 containers in the development stack, including application services, infrastructure services, Dify components, Vault agents (one per service), and operational sidecars (cert rotation, db migration).

**Q: Is the platform available offline / without internet access?**  
A: The production deployment model supports offline capability. All container images are pre-pulled from the GitLab Container Registry and stored locally. The platform can operate without internet access once deployed, provided the LLM API endpoint is reachable (or self-hosted).

**Q: What is the difference between the development and production environments?**  
A: The development environment runs on Docker Compose (`docker-compose.yml`) on a local server. The production environment (`docker-compose.prod.yml`) targets `theaitools.ca`, uses pre-built registry images rather than local builds, and is configured with production-grade secrets and TLS certificates for the public domain. Production deployment has not yet been executed.

**Q: How does secret rotation work?**  
A: Vault Agent sidecars monitor the Vault PKI and KV stores. When a TLS certificate approaches expiry, the `cert-rotation-controller` places a rotation request on the `rotation_control` RabbitMQ queue. Each service's `tls-runtime` package receives the notification and hot-reloads the new certificate in-process without restarting the service.

**Q: Is there a high-availability or clustering mode?**  
A: Not currently. The platform runs as a single-node Docker Compose stack. Horizontal autoscaling via Kubernetes (K8s + HPA) is on the roadmap (gap M7) but not yet implemented.
