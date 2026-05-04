# RAG Knowledge Base Sync — Developer Reference

This document is the definitive technical reference for the GitHub/GitLab → Dify knowledge-base sync feature. It covers every node in the n8n workflow, the smart-diff subsystem, progress callback protocol, error handling, authentication, and operational procedures for updating the workflow in the database.

---

## Architecture Overview

```
Operator (Web UI / REST)
         │
         │  POST /rag/knowledge-bases/:id/sync  (JWT Bearer)
         ▼
   ┌─────────────┐
   │ api-gateway │  :4000
   └──────┬──────┘
          │  proxy (mTLS)
          ▼
   ┌─────────────────┐
   │ workflow-service │  :4001
   └──────┬──────────┘
          │  HTTP POST to n8n webhook
          ▼
   ┌──────────────────────────────────────────────────┐
   │  n8n  (17-node workflow)                         │
   │                                                  │
   │  Webhook → Parse → Callbacks → GitHub/GitLab API │
   │         → sync-diff → Fetch content → Dify API   │
   │         → Poll Dify indexing → Final callback     │
   └──────┬───────────────────────────────────────────┘
          │ progress callbacks  (X-Rag-Sync-Token)
          ▼
   ┌─────────────┐                  ┌───────────────────┐
   │ api-gateway │ ─── proxy ──────►│ workflow-service   │
   │   :4000     │                  │ updates PostgreSQL │
   └─────────────┘                  └───────────────────┘
          ▲
          │  GET /rag/knowledge-bases/:id/sync-status (JWT Bearer, every 3 s)
   ┌──────────────┐
   │  Web UI      │
   │  SyncProcess │
   │  Monitor     │
   └──────────────┘
```

---

## The 17-Node n8n Workflow

### Node 1 — Webhook Trigger
- Accepts the incoming POST from workflow-service.
- Immediately returns HTTP 200 to the caller so workflow-service does not time out.
- The remaining 16 nodes execute asynchronously after the response is sent.

### Node 2 — Parse Sync Params
- Code node that extracts `owner` and `repo` from `sourceUrl` (e.g. `https://github.com/org/myrepo` → `owner=org`, `repo=myrepo`).
- Adds `syncStartedAt` (ISO 8601 timestamp) to the workflow context for later callbacks.

### Node 3 — Init Step Callback
- HTTP POST to `https://api-gateway:4000/rag/knowledge-bases/:id/sync-progress`.
- Reports `stepName: "fetch_file_tree"`, `status: "running"` so the UI immediately shows the first step as in-progress.
- Header: `X-Rag-Sync-Token`.

### Node 4 — Get Repo File Tree
- **GitHub**: `GET https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1`
- **GitLab**: equivalent Trees API with private token header.
- Returns the full recursive file tree (path + SHA for every file in the repo).
- `continueOnFail: true` — if this node errors (network failure, 401, 404), execution continues to Handle Tree Error rather than going straight to the Error Trigger.

### Node 5 — Handle Tree Error
- Code node that inspects the result from Node 4.
- Checks for `json.error` (n8n-level failure) or `json.statusCode >= 400` (HTTP error).
- On failure: sends a `fetch_file_tree: failed` progress callback with a human-readable message like `"HTTP 401: Bad credentials"`.
- Then `throw`s to route execution into the Error Trigger (Node 17).
- On success: passes data through unchanged.

### Node 6 — Filter Supported Files (sync-diff)
- HTTP POST to `https://api-gateway:4000/rag/knowledge-bases/:id/sync-diff` (proxied to workflow-service).
- Sends the full git tree (all paths + SHAs).
- The backend (workflow-service) does two things:
  1. **Extension filter**: keeps only files whose extension is in the supported set — `.md .markdown .txt .html .htm .xml .csv .pdf .docx .xlsx .xls .pptx .ppt .eml .msg .epub`.
  2. **SHA diff**: compares each file's SHA against the value stored in `RagKbSourcePath.fileSha`. Returns only files that are new or have a changed SHA.
- Response is the filtered list of changed files.

### Node 7 — Map Diff Files
- Code node that inspects the response from Node 6.
- If the list is empty (no files changed), it:
  1. Sends `fetch_file_tree: completed` callback.
  2. Sends `skip_sync: completed` callback.
  3. Returns an empty array so downstream nodes process 0 items.
- If files are present, passes them through to Node 8.

### Node 8 — Upload Start Callback
- Code node that sends two callbacks in sequence:
  1. `fetch_file_tree: completed`
  2. `upload_files: running`
- This marks the transition from discovery phase to upload phase in the UI.

### Node 9 — Fetch File Content
- For each file in the diff list: HTTP GET to the raw file endpoint.
  - GitHub: `https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}`
  - GitLab: raw file blob API.
- `responseFormat: file` — returns binary for non-text files, text for text files.

### Node 10 — Upload Doc to Dify
- Code node with two upload paths:
  - **Text extensions** (`.md`, `.txt`, `.html`, etc.): calls Dify `POST /datasets/:id/document/create_by_text` API with the file content as a string.
  - **Binary files** (`.pdf`, `.docx`, `.xlsx`, etc.): calls Dify `POST /datasets/:id/document/create_by_file` as multipart form upload.
- Returns the Dify document ID on success, or an error object on failure.

### Node 11 — Report File Progress
- Code node that fires after each individual file upload.
- Sends a progress callback with:
  - `stepName: "upload_files"`
  - `status: "running"` (NOT `"completed"` — see step deduplication below)
  - `filesProcessed`: incremented count
  - `filesTotal`: total diff file count
- On upload error, sends `status: "failed"` for that file entry (but does not stop the loop).

### Node 12 — Aggregate Doc IDs
- Code node that waits for all per-file iterations to finish.
- Collects all `difyDocId` values and any `uploadErrors` into a single item for downstream nodes.

### Node 13 — Indexing Start Callback
- Code node that marks `upload_files` as `completed` if there were no upload errors, or `failed` if any upload errors were collected.

### Node 14 — Dify Indexing Start Callback
- Code node that sends `dify_indexing: running` callback.

### Node 15 — Poll Dify Indexing
- Code node with a polling loop:
  - Polls Dify's document status API every 5 seconds.
  - Maximum 24 attempts (~2 minutes total).
  - Collects per-document status: `completed`, `error`, or still indexing.
- Exits when all documents are in a terminal state or max attempts reached.

### Node 16 — Report Final Status
- Code node that sends the final `dify_indexing: completed` or `dify_indexing: failed` callback.
- Sets the job-level `errorMessage` field if any documents failed indexing.

### Node 17 — Error Trigger
- n8n built-in error workflow trigger.
- Fires on any unhandled `throw` from any node in the workflow.
- POSTs to `https://api-gateway:4000/rag/sync-error-handler` with error details.
- `sync-error-handler` in workflow-service:
  - Marks the `RagKbSyncJob` record as `failed`.
  - Finds any `stepsJson` entries still in `running` state and sets them to `failed`.

---

## Smart Diff (sync-diff)

### Purpose
Avoid re-uploading files that have not changed since the last sync. GitHub and GitLab return a SHA hash for every file in the tree; these SHAs are stable — the same file content always produces the same SHA.

### Flow
```
n8n → POST /rag/knowledge-bases/:id/sync-diff
       Body: { files: [{ path, sha, type, url }] }

workflow-service:
  1. Filter to supported extensions
  2. SELECT filePath, fileSha FROM RagKbSourcePath WHERE knowledgeBaseId = :id
  3. For each file in the tree:
       if not in RagKbSourcePath  → include (new file)
       if sha !== stored sha      → include (changed file)
       else                       → exclude (unchanged)
  4. Return filtered list

After successful upload + indexing:
  workflow-service upserts RagKbSourcePath rows with new SHAs
```

### RagKbSourcePath table
| Column | Type | Description |
|--------|------|-------------|
| id | UUID | PK |
| knowledgeBaseId | UUID | FK → RagKnowledgeBase |
| filePath | String | Relative path in repo (e.g. `docs/setup.md`) |
| fileSha | String | Git blob SHA for last-synced version |

### Skip Sync behaviour
If sync-diff returns 0 files, Node 7 (Map Diff Files) sends a `skip_sync: completed` callback and the flow ends. The UI shows this as a completed step labelled "Skip Sync". This is normal and expected when the repository content has not changed since the last sync.

---

## Progress Callback Protocol

### Endpoint
`POST https://api-gateway:4000/rag/knowledge-bases/:id/sync-progress`
Header: `X-Rag-Sync-Token: <N8N_WEBHOOK_TOKEN>`

### Body Schema
```json
{
  "syncJobId": "<RagKbSyncJob.id>",
  "status": "running | completed | failed",
  "filesProcessed": 3,
  "filesTotal": 8,
  "step": {
    "task": "Upload Files",
    "stepName": "fetch_file_tree | skip_sync | upload_files | dify_indexing",
    "status": "running | completed | failed",
    "startedAt": "2026-05-04T10:00:00.000Z",
    "completedAt": "2026-05-04T10:00:05.000Z",
    "message": "Human-readable description",
    "errorMessage": "Only present on failure"
  },
  "logMessage": "Log line shipped to OpenSearch",
  "logSeverity": "INFO | ERROR"
}
```

### Step Deduplication (stepName upsert)
`RagKbSyncJob.stepsJson` is a JSON object keyed by `stepName`. When a callback arrives, workflow-service does:

```typescript
stepsJson[step.stepName] = { ...existingEntry, ...step };
```

This means multiple callbacks with the same `stepName` overwrite each other. The final stored state for `upload_files` will be the one from Node 13 (Indexing Start Callback), which sets it to `completed` or `failed`.

### Why Report File Progress uses `status: "running"`
Nodes 11 (Report File Progress) sends per-file callbacks for `upload_files` all with `status: "running"`. If it used `status: "completed"`, the UI would show the step as done before all files were processed. The upsert design means only the LAST callback for a given `stepName` wins — so per-file callbacks update `filesProcessed` while keeping the step in `running` state, and only Node 13 (Indexing Start Callback) flips it to `completed`.

---

## Error Handling Pipeline

### Layer 1: Handle Tree Error (Node 5)
Catches HTTP errors from Node 4 (Get Repo File Tree). Responsible for failures like:
- HTTP 401: bad/revoked access token
- HTTP 404: repository not found
- Network timeout

Sends a human-readable `fetch_file_tree: failed` callback before throwing. The throw routes to Node 17.

### Layer 2: Error Trigger (Node 17)
Catches ALL unhandled throws from any node in the workflow (Nodes 5, 9, 10, etc.).
POSTs to `/rag/sync-error-handler`.

### Layer 3: sync-error-handler endpoint
In workflow-service:
```
POST /rag/sync-error-handler
Auth: X-Rag-Sync-Token
```
Actions:
1. Sets `RagKbSyncJob.status = "failed"`
2. Sets `RagKbSyncJob.errorMessage` from the error payload
3. Iterates `stepsJson` — any step with `status: "running"` is updated to `status: "failed"`
4. Sets `completedAt` on the job record

---

## Stale Job Detection

### Mechanism
`RagKbSyncJob.lastProgressAt` is updated on every progress callback received. A background timer (`sweepStaleJobs`) runs every 60 seconds in workflow-service.

### Sweep logic
```typescript
const threshold = new Date(Date.now() - 15 * 60 * 1000); // 15 minutes ago
const staleJobs = await db.ragKbSyncJob.findMany({
  where: {
    status: { in: ["running", "pending"] },
    OR: [
      { lastProgressAt: { lt: threshold } },
      { lastProgressAt: null, createdAt: { lt: threshold } },
    ],
  },
});
for (const job of staleJobs) {
  await markJobTimedOut(job.id);
}
```

### Result
Stale jobs are marked `timed_out`. The UI shows this as a failed sync. No manual intervention is required for stale cleanup.

---

## Authentication

### Sync callback endpoints (n8n → api-gateway)
| Endpoint | Auth mechanism | Header |
|----------|---------------|--------|
| `POST /rag/knowledge-bases/:id/sync-progress` | `authorizeSyncProgressCallback()` | `X-Rag-Sync-Token` |
| `POST /rag/knowledge-bases/:id/sync-diff` | `authorizeSyncProgressCallback()` | `X-Rag-Sync-Token` |
| `POST /rag/sync-error-handler` | `authorizeSyncProgressCallback()` | `X-Rag-Sync-Token` |

These endpoints do NOT use JWT auth. The sync token is a shared secret configured as `N8N_WEBHOOK_TOKEN` environment variable in both api-gateway (to verify) and n8n (to send).

### User-facing endpoints (Web UI / operators)
| Endpoint | Auth mechanism |
|----------|---------------|
| All other `/rag/*` endpoints | Keycloak JWT Bearer, role `operator+` |

### Why sync callbacks skip JWT
n8n has no Keycloak session. Using a separate pre-shared token for machine-to-machine callbacks avoids the complexity of Keycloak service accounts while keeping the sync endpoints protected from unauthenticated access.

---

## Updating the n8n Workflow

### How n8n resolves the active workflow
n8n does NOT read nodes from `workflow_entity.nodes` at runtime. It reads from `workflow_history` using `workflow_entity.activeVersionId` as the lookup key. Editing `workflow_entity.nodes` directly has no runtime effect.

### Update procedure
```sql
-- Step 1: Insert a new history row with the updated nodes JSON
INSERT INTO workflow_history (
  "versionId", "workflowId", authors, nodes, connections, name, autosaved, "createdAt", "updatedAt"
) VALUES (
  '<new-uuid>',          -- generate a new UUID v4
  '<workflow-id>',       -- see Workflow IDs below
  'admin',
  '<nodes-json>'::json,  -- updated nodes array from the template file
  '<connections-json>'::json,
  '<workflow-name>',
  false,
  NOW(),
  NOW()
);

-- Step 2: Point workflow_entity to the new version
UPDATE workflow_entity
SET "activeVersionId" = '<new-uuid>', "updatedAt" = NOW()
WHERE id = '<workflow-id>';
```

### Restart n8n
```bash
docker compose restart n8n
```

### Workflow IDs
| Source | Workflow ID |
|--------|-------------|
| GitHub → Dify | `4f8dbb73-d6c5-4a55-8178-8c4f51c76d01` |
| GitLab → Dify | `22d3d7b8-d94b-4300-a3a3-b55835e6c902` |

### Template file locations
```
infra/n8n/templates/github-to-dify-sync.json   ← source of truth for GitHub workflow
infra/n8n/templates/gitlab-to-dify-sync.json   ← source of truth for GitLab workflow
```

The `.sql` helper scripts in the repo root (`.tmp_publish_n8n_workflow*.sql`) automate the INSERT + UPDATE pattern above.

---

## API Endpoint Reference

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/rag/knowledge-bases` | JWT operator+ | Create KB integration |
| GET | `/rag/knowledge-bases` | JWT operator+ | List KBs |
| POST | `/rag/knowledge-bases/:id/sync` | JWT operator+ | Trigger a sync |
| GET | `/rag/knowledge-bases/:id/sync-status` | JWT operator+ | Poll latest sync job |
| GET | `/rag/knowledge-bases/:id/sync-history` | JWT operator+ | Last N sync jobs |
| POST | `/rag/knowledge-bases/:id/sync-progress` | X-Rag-Sync-Token | n8n progress callback |
| POST | `/rag/knowledge-bases/:id/sync-diff` | X-Rag-Sync-Token | n8n smart-diff request |
| POST | `/rag/sync-error-handler` | X-Rag-Sync-Token | n8n unhandled error callback |
| POST | `/rag/knowledge-bases/:id/retry-failed-indexing` | JWT operator+ | Retry failed Dify documents |

---

## Key Prisma Models

```prisma
model RagKnowledgeBase {
  id             String  @id @default(uuid())
  name           String
  isDefault      Boolean @default(false)
  difyDatasetId  String
  sourceType     String  // "github" | "gitlab"
  sourceUrl      String
  sourceBranch   String
  sourcePath     String?
  difyApiUrl     String
}

model RagKbSyncJob {
  id               String    @id @default(uuid())
  knowledgeBaseId  String
  trigger          String    // "manual" | "scheduled" | "webhook"
  status           String    // "pending" | "running" | "completed" | "failed" | "timed_out"
  filesTotal       Int       @default(0)
  filesProcessed   Int       @default(0)
  stepsJson        Json      @default("{}")
  errorMessage     String?
  lastProgressAt   DateTime?
  createdAt        DateTime  @default(now())
  startedAt        DateTime?
  completedAt      DateTime?
}

model RagKbSourcePath {
  id               String  @id @default(uuid())
  knowledgeBaseId  String
  filePath         String  // e.g. "docs/setup.md"
  fileSha          String  // Git blob SHA from last successful sync
}
```

---

## SyncProcessMonitor Component

Source: `apps/web/src/app/integrations/SyncProcessMonitor.tsx`

- Renders a step table showing each `stepName` with status badge, start time, and duration.
- KB selector and sync-job history dropdown (last 10 jobs per KB).
- Auto-switches to the KB that has just started an active sync.
- Polls `GET /rag/knowledge-bases/:id/sync-status` every 3 seconds while job status is `running` or `pending`.
- Shows a progress bar based on `filesProcessed / filesTotal`.
- Per-step "log" button opens a drawer showing raw `logMessage` lines for that step.
- Step op-type badges: Fetch/Compare, Skip, Upload, Index.
