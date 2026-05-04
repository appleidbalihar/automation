# RAG Knowledge Base Sync — Architecture

This document describes the architectural design of the GitHub/GitLab → Dify knowledge-base sync feature: component topology, key design decisions, data model, security boundaries, and polling strategies.

---

## Component Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser / Operator                                             │
│  SyncProcessMonitor.tsx                                         │
│  - Polls sync-status every 3 s while job is active             │
└───────────────────────────┬─────────────────────────────────────┘
                            │  JWT Bearer (HTTPS/443 via Nginx)
                            ▼
                    ┌───────────────┐
                    │  api-gateway  │  :4000  (Fastify, mTLS)
                    │               │
                    │  - JWT verify │
                    │  - Sync token │
                    │    verify     │
                    └──────┬────────┘
                           │  mTLS  :4001
                           ▼
                    ┌───────────────────┐
                    │  workflow-service  │  (Fastify, mTLS)
                    │                   │
                    │  - Triggers n8n   │
                    │  - sync-diff      │
                    │  - sync-progress  │
                    │  - sync-error-    │
                    │    handler        │
                    │  - sweepStaleJobs │
                    └──────┬────────────┘
                           │  HTTP POST (webhook)
                           ▼
              ┌────────────────────────┐
              │         n8n            │  :5678
              │  17-node sync workflow  │
              └────┬──────────┬────────┘
                   │          │
     ┌─────────────┘          └──────────────────┐
     ▼                                           ▼
┌──────────────────┐                   ┌─────────────────┐
│  GitHub / GitLab │                   │  Dify RAG       │
│  REST API        │                   │  :5001          │
│  - git trees     │                   │  - create_by_   │
│  - raw files     │                   │    text/file    │
└──────────────────┘                   │  - poll index   │
                                       └─────────────────┘
                   │
                   │  X-Rag-Sync-Token (progress callbacks)
                   └──────────────────────────────────────►
                                  api-gateway → workflow-service
                                        │
                                        ▼
                                  ┌─────────────┐
                                  │  PostgreSQL  │
                                  │  RagKbSyncJob│
                                  │  RagKbSource │
                                  │  Path        │
                                  └─────────────┘
```

---

## Design Decisions

### Async webhook with immediate 200 response (Node 1)
**Decision**: The n8n Webhook Trigger returns HTTP 200 immediately; all 16 remaining nodes run asynchronously.

**Rationale**: Sync jobs can take minutes (large repos, slow Dify indexing). If the webhook held the connection open, workflow-service would time out waiting. The immediate-ack pattern decouples trigger latency from job duration and lets the UI poll for status rather than waiting on the HTTP response.

### continueOnFail on Get Repo File Tree (Node 4)
**Decision**: The tree-fetch node has `continueOnFail: true` instead of letting n8n's default error routing take over.

**Rationale**: Without `continueOnFail`, an HTTP 401 from GitHub would route directly to the Error Trigger (Node 17), which sends a generic error callback. With `continueOnFail`, execution flows to Node 5 (Handle Tree Error), which can inspect the actual HTTP status code and message and send a human-readable `fetch_file_tree: failed` callback (e.g. `"HTTP 401: Bad credentials"`). This gives operators actionable information in the Sync Process Monitor without needing to inspect n8n logs.

### Smart diff via sync-diff (Nodes 6–7)
**Decision**: Introduce a backend `sync-diff` endpoint that filters the full git tree to only changed files before any content is fetched or uploaded.

**Rationale**: A large repository may have thousands of files, but a typical commit touches only a few. Re-uploading every file on every sync would:
- Waste API quota on Dify's document creation endpoint
- Cause unnecessary re-indexing delays
- Accumulate duplicate document versions in the Dify dataset

The SHA-based comparison in `RagKbSourcePath` ensures only genuinely new or modified files are processed. If nothing changed, the workflow skips all upload and indexing steps entirely (`skip_sync` path).

### stepName as upsert key in stepsJson
**Decision**: `RagKbSyncJob.stepsJson` is keyed by `stepName`, so each new callback for the same step overwrites the previous entry.

**Rationale**: The `upload_files` step sends many callbacks during its lifecycle (one per file). Storing every callback as a separate row would require a separate `SyncJobStep` table with pagination. The upsert-by-stepName approach keeps the data model simple: the UI always sees the latest state per named step, and the per-file progress information is carried in the `filesProcessed` counter rather than individual rows. The tradeoff is that detailed per-file history is not retained after the step completes.

### lastProgressAt for stale detection
**Decision**: Update `lastProgressAt` on every progress callback and sweep for staleness server-side rather than relying on a client-visible timeout.

**Rationale**: Network partitions or n8n crashes can leave jobs in `running` state with no further callbacks arriving. A client-side timeout (in the web UI) would only help the user who happens to have the monitor open. A server-side sweep at 15-minute inactivity marks the job `timed_out` regardless of UI state and unblocks future syncs that may be queued behind a hung job. The 15-minute window is generous enough to cover the 2-minute Dify polling loop plus network variability.

### Separate sync token (not JWT) for n8n callbacks
**Decision**: n8n uses a pre-shared `X-Rag-Sync-Token` header rather than a Keycloak JWT for its machine-to-machine calls.

**Rationale**: Keycloak JWT issuance requires a registered client with client credentials flow. n8n's HTTP Request nodes do not natively support Keycloak's token-exchange flow without a custom code node. A static pre-shared token (rotatable via Vault KV and `docker compose up -d`) achieves the same protection with no extra complexity. The sync endpoints that accept this token are never exposed to end-user browsers — only n8n's internal network address can reach them.

---

## Data Model Overview

### RagKnowledgeBase
Represents a single configured sync source. Holds the Dify dataset ID and source repo coordinates.

```
RagKnowledgeBase
  id             UUID PK
  name           String
  isDefault      Boolean
  difyDatasetId  String          — Dify's internal dataset identifier
  sourceType     String          — "github" | "gitlab"
  sourceUrl      String          — e.g. https://github.com/org/repo
  sourceBranch   String          — e.g. "main"
  sourcePath     String?         — optional sub-directory filter
  difyApiUrl     String          — Dify API base URL
```

### RagKbSyncJob
One row per sync execution. Tracks lifecycle from creation through completion or failure.

```
RagKbSyncJob
  id               UUID PK
  knowledgeBaseId  UUID FK
  trigger          String          — "manual" | "scheduled" | "webhook"
  status           String          — "pending" | "running" | "completed"
                                  —  "failed" | "timed_out" | "cancelled"
  filesTotal       Int             — set by sync-diff response
  filesProcessed   Int             — incremented by per-file callbacks
  stepsJson        Json            — { [stepName]: StepEntry }
  errorMessage     String?
  lastProgressAt   DateTime?       — updated on every callback (stale detection)
  createdAt        DateTime
  startedAt        DateTime?
  completedAt      DateTime?
```

### RagKbSourcePath
One row per file in the repo as of the last successful sync. Used exclusively by the smart-diff comparison.

```
RagKbSourcePath
  id               UUID PK
  knowledgeBaseId  UUID FK
  filePath         String          — "docs/setup.md" (repo-relative)
  fileSha          String          — Git blob SHA from last sync
```

---

## Security Boundaries

```
┌─────────────────────────────────────────────────────────────┐
│  Public zone (via Nginx :3443)                              │
│  Browser → JWT Bearer → api-gateway                        │
│  Endpoints: /rag/knowledge-bases/*, /rag/*/sync-status, …  │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Machine-to-machine zone (internal network only)            │
│  n8n → X-Rag-Sync-Token → api-gateway                      │
│  Endpoints: /sync-progress, /sync-diff, /sync-error-handler │
│  NOT reachable via browser (same-origin checks + no CORS)   │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Service mesh (mTLS, internal Docker network only)          │
│  api-gateway ↔ workflow-service ↔ PostgreSQL               │
│  Vault-issued leaf certs, 72-hour TTL, auto-renew          │
└─────────────────────────────────────────────────────────────┘
```

### Endpoint auth matrix

| Endpoint group | Caller | Auth |
|----------------|--------|------|
| `/rag/knowledge-bases` (CRUD) | Browser / API client | Keycloak JWT, role `operator+` |
| `/rag/*/sync` (trigger) | Browser / API client | Keycloak JWT, role `operator+` |
| `/rag/*/sync-status` | Browser (poll) | Keycloak JWT |
| `/rag/*/sync-progress` | n8n | `X-Rag-Sync-Token` |
| `/rag/*/sync-diff` | n8n | `X-Rag-Sync-Token` |
| `/rag/sync-error-handler` | n8n | `X-Rag-Sync-Token` |
| `/rag/*/retry-failed-indexing` | Browser | Keycloak JWT, role `operator+` |

---

## Polling Architecture

### Web UI polling (3-second interval)
`SyncProcessMonitor.tsx` polls `GET /rag/knowledge-bases/:id/sync-status` every 3 seconds while the job status is `running` or `pending`. Polling stops when status transitions to `completed`, `failed`, `timed_out`, or `cancelled`. The 3-second cadence is a balance between UI responsiveness and API load; for large repos with many files, the `filesProcessed` counter updates are visible in near-real-time.

### n8n Dify indexing poll (5-second interval, max 24 attempts)
Node 15 (Poll Dify Indexing) polls Dify's document status API after upload. Dify's indexing pipeline is asynchronous — documents may take seconds to minutes depending on size and configured chunking strategy. The 5-second interval × 24 attempts gives a 2-minute window, which covers the vast majority of normal indexing scenarios. If indexing does not complete within 2 minutes, the poll exits and the final status reflects whichever documents did or did not finish.

### Why not WebSockets or SSE?
The sync workflow is orchestrated by n8n (an external service) that pushes callbacks to the API. Bridging those callbacks to long-lived browser connections would require a message bus or SSE proxy layer. Short-interval polling over standard HTTP is simpler to operate, easier to debug, and sufficient for the 3–60 second timescale of sync steps.

---

## Supported File Extensions

The sync-diff filter accepts only these extensions:

| Category | Extensions |
|----------|-----------|
| Markdown / text | `.md` `.markdown` `.txt` |
| Web | `.html` `.htm` `.xml` |
| Data | `.csv` |
| Documents | `.pdf` `.docx` `.epub` `.eml` `.msg` |
| Spreadsheets | `.xlsx` `.xls` |
| Presentations | `.pptx` `.ppt` |

All other extensions (images, code files, binaries) are silently excluded from the diff and never uploaded to Dify.
