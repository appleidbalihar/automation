# RAG Knowledge Base Sync — Operations Runbook

This runbook covers day-to-day operations for the GitHub/GitLab → Dify knowledge-base sync feature: triggering syncs, monitoring progress, diagnosing failures, and maintaining the n8n workflow.

---

## Triggering a Sync

### Via the Web UI
1. Navigate to **Integrations** (`/integrations`).
2. Find the knowledge base integration you want to sync.
3. Click the **Sync** button (circular arrow icon) on that integration's row.
4. The Sync Process Monitor panel opens (or updates) showing the sync in progress.

### Via the API
```bash
curl -X POST https://<host>/gateway/rag/knowledge-bases/<kb-id>/sync \
  -H "Authorization: Bearer <keycloak-jwt>" \
  -H "Content-Type: application/json"
```

Response: `{ "syncJobId": "<uuid>", "status": "pending" }`

You can then poll for status:
```bash
curl https://<host>/gateway/rag/knowledge-bases/<kb-id>/sync-status \
  -H "Authorization: Bearer <keycloak-jwt>"
```

---

## Reading the Sync Process Monitor

The Sync Process Monitor is the primary observability tool for sync jobs. It is accessible from the **Integrations** page.

### KB selector and job history
- The **KB selector** dropdown at the top lets you switch between configured knowledge bases.
- The **Job history** dropdown shows the last 10 sync jobs for the selected KB. Select any past job to review its steps.
- The monitor auto-switches to whichever KB has just started an active sync.

### Progress bar
- Shows `filesProcessed / filesTotal` (e.g. `3 / 8 files`).
- Only counts files included in the smart diff — files that have not changed are excluded from the total.
- If the repo was unchanged, the total is 0 and no progress bar is shown (see Skip Sync below).

### Step table

Each sync goes through up to four named steps:

| Step name | Display label | What it means |
|-----------|--------------|---------------|
| `fetch_file_tree` | Fetch File Tree | n8n is fetching the full recursive file list from GitHub/GitLab |
| `skip_sync` | Skip Sync | Diff returned 0 changed files; sync ended without uploading anything |
| `upload_files` | Upload Files | Changed files are being fetched and uploaded to Dify |
| `dify_indexing` | Dify Indexing | Dify is chunking, embedding, and indexing the uploaded documents |

### Status badges

| Badge colour | Meaning |
|-------------|---------|
| Blue / pulsing | `running` — step is currently active |
| Green | `completed` — step finished successfully |
| Red | `failed` — step encountered an error; see error message |
| Grey | Not yet reached |

### Log drill-down
Click the **log icon** (clipboard/list icon) on any step row to open a log drawer. The drawer shows the raw `logMessage` lines that were sent with each progress callback for that step. This is the first place to look when a step fails without an obvious error message.

---

## Common Scenarios

### Normal sync with changes
Steps appear in order: Fetch File Tree → Upload Files → Dify Indexing, each transitioning from running to completed. The progress bar fills as files are uploaded.

### Skip Sync ("No files to update")
If the repository content is identical to the last sync (all SHA hashes match), you will see:
- `fetch_file_tree: completed`
- `skip_sync: completed`

This is **expected and correct behaviour**. It means the smart diff found no changed files. No re-uploading or re-indexing occurred. This is more efficient than re-processing an entire repository on every scheduled sync.

---

## Investigating a Failed Sync

### Step 1: Check the Sync Process Monitor
1. Open **Integrations** (`/integrations`) and select the failing KB.
2. Check which step shows a red **failed** badge.
3. Click the log icon on that step to see the raw error message from n8n.

### Step 2: Read the step's error message
The error message (shown in the step row or log drawer) typically identifies the cause directly. Common messages:
- `"HTTP 401: Bad credentials"` — access token is invalid or expired
- `"HTTP 404: Not Found"` — repository URL is wrong or the branch does not exist
- `"HTTP 403: Forbidden"` — token has insufficient scopes (needs `repo` read permission)
- `"Dify API error: dataset not found"` — Dify dataset ID mismatch; may need to recreate the KB

### Step 3: Check stepsJson in the database
```sql
SELECT id, status, "errorMessage", "stepsJson", "lastProgressAt"
FROM "RagKbSyncJob"
WHERE "knowledgeBaseId" = '<kb-id>'
ORDER BY "createdAt" DESC
LIMIT 5;
```

### Step 4: Check application logs
```bash
# Filter workflow-service logs for sync events
docker compose logs workflow-service --since 30m | grep -i "sync\|rag\|error"
```

Or use the **Logs** page (`/logs`), filtering by:
- Source: `workflow-service`
- Severity: `ERROR` or `WARN`
- Time range: around the sync start time

### Step 5: Check the n8n execution (if needed)
1. Open n8n at `http://<host>:5678` (admin credentials in Vault).
2. Go to **Executions** and find the execution matching the sync start time.
3. Click the execution to see per-node input/output, including the raw GitHub API response.

---

## Common Failure Modes and Resolution

### HTTP 401 on Fetch File Tree

**Symptom**: `fetch_file_tree` step fails with `"HTTP 401: Bad credentials"`.

**Cause**: The OAuth token or PAT used to access the source repository is invalid, expired, or revoked.

**Resolution**:
1. Go to **Integrations** → find the affected integration → click the credential panel.
2. If using OAuth: click **Reconnect** to re-authorize. If the OAuth app was revoked, generate a new one.
3. If using PAT: click the **Token** tab, paste a new valid Personal Access Token, click **Save Token**.
4. Trigger a new sync.

### Sync stuck in "running" for more than 15 minutes

**Symptom**: Sync job status is `running` but the Sync Process Monitor shows no progress updates for an extended period.

**Cause**: n8n execution may have crashed, the network between n8n and api-gateway may have dropped, or the Dify indexing poll exceeded its timeout without sending a final callback.

**Resolution — automatic**: The `sweepStaleJobs` process runs every 60 seconds in workflow-service and automatically marks any job with no progress for 15 minutes as `timed_out`. No manual action is needed unless you want to force it immediately.

**Resolution — manual** (force-fail the job):
```sql
UPDATE "RagKbSyncJob"
SET status = 'failed',
    "errorMessage" = 'Manually marked failed by operator',
    "completedAt" = NOW()
WHERE id = '<sync-job-id>'
  AND status = 'running';
```

Then trigger a fresh sync.

### Dify indexing errors (some or all documents failed)

**Symptom**: `dify_indexing` step shows `failed` or `completed` but the Operations AI chat cannot find expected content.

**Cause**: Dify rejected or failed to index one or more documents. This can happen with malformed PDFs, unsupported encoding, or Dify service instability.

**Resolution**:
1. Check the log drawer for `dify_indexing` — it lists which documents failed.
2. In the Sync Process Monitor, click the **Retry** button (if available) to call `POST /rag/knowledge-bases/:id/retry-failed-indexing`, which re-submits only the failed documents to Dify without re-uploading.
3. If retry fails, check Dify's own logs: `docker compose logs dify --since 1h | grep -i error`.
4. For persistent failures on specific files, consider excluding them from the sync path or converting them to a supported format.

### "No files to update" / skip_sync appears unexpectedly

**Symptom**: Every sync immediately shows `skip_sync: completed` even though you expect new content.

**Cause**: The `RagKbSourcePath` table has stored SHAs that match the current repository content. This happens if:
- Content was not actually changed (expected behaviour)
- The branch parameter is wrong and n8n is fetching a different branch than you expect
- Files were force-pushed and the SHAs were accidentally preserved

**Resolution**:
1. Verify the `sourceBranch` on the KB record matches the branch you are editing.
2. If you need to force a full re-sync, clear the stored SHAs:
```sql
DELETE FROM "RagKbSourcePath"
WHERE "knowledgeBaseId" = '<kb-id>';
```
Then trigger a new sync. All files will be treated as new.

---

## Updating the n8n Workflow Template

### When is this needed?
When you change the sync logic — add a node, fix a callback, change a URL — you must push the updated JSON to n8n's database. Editing the JSON template file alone has no runtime effect.

### Process

1. **Edit the template file**:
   - GitHub workflow: `infra/n8n/templates/github-to-dify-sync.json`
   - GitLab workflow: `infra/n8n/templates/gitlab-to-dify-sync.json`

2. **Extract nodes and connections JSON** from the template (the template is the full n8n export format).

3. **Run the DB update** (use the helper SQL scripts or apply manually):
```sql
-- Insert new history version
INSERT INTO workflow_history (
  "versionId", "workflowId", authors, nodes, connections, name, autosaved, "createdAt", "updatedAt"
) VALUES (
  gen_random_uuid()::text,
  '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01',   -- GitHub workflow ID
  'admin',
  '<nodes-json>'::json,
  '<connections-json>'::json,
  'GitHub to Dify Sync',
  false,
  NOW(), NOW()
);

-- Point workflow_entity to the new version
UPDATE workflow_entity
SET "activeVersionId" = (
  SELECT "versionId" FROM workflow_history
  WHERE "workflowId" = '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01'
  ORDER BY "createdAt" DESC LIMIT 1
), "updatedAt" = NOW()
WHERE id = '4f8dbb73-d6c5-4a55-8178-8c4f51c76d01';
```

4. **Restart n8n** to load the new version:
```bash
docker compose restart n8n
```

5. **Verify** by triggering a test sync and checking the Sync Process Monitor.

### Workflow IDs
| Workflow | ID |
|----------|----|
| GitHub → Dify | `4f8dbb73-d6c5-4a55-8178-8c4f51c76d01` |
| GitLab → Dify | `22d3d7b8-d94b-4300-a3a3-b55835e6c902` |

---

## Diagnostic SQL Queries

### List recent sync jobs for a KB
```sql
SELECT id, status, trigger, "filesProcessed", "filesTotal",
       "errorMessage", "createdAt", "completedAt"
FROM "RagKbSyncJob"
WHERE "knowledgeBaseId" = '<kb-id>'
ORDER BY "createdAt" DESC
LIMIT 10;
```

### Inspect step details for a specific job
```sql
SELECT "stepsJson"
FROM "RagKbSyncJob"
WHERE id = '<sync-job-id>';
```

### Find all currently running jobs (across all KBs)
```sql
SELECT j.id, j.status, j."lastProgressAt", kb.name AS kb_name
FROM "RagKbSyncJob" j
JOIN "RagKnowledgeBase" kb ON kb.id = j."knowledgeBaseId"
WHERE j.status IN ('running', 'pending')
ORDER BY j."createdAt" DESC;
```

### Find potentially stale jobs (running but no progress for 10+ minutes)
```sql
SELECT j.id, j.status, j."lastProgressAt", kb.name AS kb_name,
       NOW() - j."lastProgressAt" AS idle_duration
FROM "RagKbSyncJob" j
JOIN "RagKnowledgeBase" kb ON kb.id = j."knowledgeBaseId"
WHERE j.status = 'running'
  AND (j."lastProgressAt" < NOW() - INTERVAL '10 minutes'
    OR j."lastProgressAt" IS NULL)
ORDER BY j."createdAt" DESC;
```

### Check stored file SHAs for a KB (smart diff state)
```sql
SELECT "filePath", "fileSha"
FROM "RagKbSourcePath"
WHERE "knowledgeBaseId" = '<kb-id>'
ORDER BY "filePath"
LIMIT 50;
```

### Count tracked files per KB
```sql
SELECT kb.name, COUNT(p.id) AS tracked_files
FROM "RagKnowledgeBase" kb
LEFT JOIN "RagKbSourcePath" p ON p."knowledgeBaseId" = kb.id
GROUP BY kb.id, kb.name
ORDER BY kb.name;
```

### Manual force-timeout of a stale job
```sql
UPDATE "RagKbSyncJob"
SET status = 'timed_out',
    "errorMessage" = 'Manually timed out by operator',
    "completedAt" = NOW()
WHERE id = '<sync-job-id>'
  AND status IN ('running', 'pending');
```

### Clear smart-diff SHA cache (force full re-sync on next run)
```sql
DELETE FROM "RagKbSourcePath"
WHERE "knowledgeBaseId" = '<kb-id>';
```
