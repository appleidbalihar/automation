# RAG Knowledge Base Sync - Operations Runbook

## Trigger A Sync

### Web UI

1. Open **Knowledge Connector** (`/knowledge-connector`).
2. Find the source.
3. Click **Sync**.
4. Watch the Sync Process Monitor.

`/integrations` still works as a compatibility route, but new docs should use `/knowledge-connector`.

### API

```bash
curl -X POST "https://<host>:3443/gateway/rag/knowledge-bases/<kb-id>/sync" \
  -H "Authorization: Bearer <keycloak-jwt>" \
  -H "Content-Type: application/json"
```

Poll:

```bash
curl "https://<host>:3443/gateway/rag/knowledge-bases/<kb-id>/sync-status" \
  -H "Authorization: Bearer <keycloak-jwt>"
```

## Monitor Jobs

The Sync Process Monitor shows:

- current KB selector
- recent job history
- trigger type
- file counters
- step status
- failed Dify documents
- retry controls
- log drawer per step

Important step names:

| Step | Meaning |
|------|---------|
| `fetch_file_tree` | Fetch source file tree/list |
| `calculate_diff` | Compare source files with `RagKbFileTracker` |
| `cleanup_removed_paths` | Remove documents that no longer match configured paths |
| `skip_sync` | No changed files to upload |
| `upload_files` | Upload/update changed files in Dify |
| `upload_file_success` | Per-file tracker update callback |
| `dify_indexing` | Dify indexing status |
| `retry_failed_indexing` | Retry failed Dify documents |
| `cleanup_*` | Full cleanup job steps |

## Read Logs

Use the step log drawer first. It calls:

```text
GET /gateway/logs/sync-job?syncJobId=<job-id>&stepName=<step-name>
```

For admin-wide investigation, use `/logs` and filter by source, severity, or message.

Container logs:

```bash
docker compose logs workflow-service --since 30m
docker compose logs api-gateway --since 30m
docker compose logs n8n --since 30m
docker compose logs dify-api dify-worker --since 30m
```

## Common Operations

### Cancel A Running Sync

Use the UI Cancel action or call:

```bash
curl -X POST "https://<host>:3443/gateway/rag/knowledge-bases/<kb-id>/sync-cancel" \
  -H "Authorization: Bearer <keycloak-jwt>"
```

If the job has an n8n execution ID and `N8N_API_KEY` is configured, workflow-service also asks n8n to stop the execution.

### Retry Failed Dify Indexing

Use the monitor retry controls or call:

```bash
curl -X POST "https://<host>:3443/gateway/rag/knowledge-bases/<kb-id>/retry-failed-indexing" \
  -H "Authorization: Bearer <keycloak-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"syncJobId":"<failed-job-id>"}'
```

### Cleanup Indexed Data

Cleanup deletes indexed Dify documents and tracker state but keeps the integration record:

```bash
curl -X POST "https://<host>:3443/gateway/rag/knowledge-bases/<kb-id>/cleanup" \
  -H "Authorization: Bearer <keycloak-jwt>"
```

After cleanup, run a fresh sync to rebuild the index.

## Common Failures

### Bad Source Credentials

Symptoms:

- `fetch_file_tree` failed
- provider HTTP 401/403/404

Actions:

1. Open Knowledge Connector.
2. Reconnect OAuth or save a new PAT.
3. Confirm branch/source URL/path filters.
4. Trigger sync again.

### No Files To Update

Symptoms:

- `skip_sync` completed
- `filesTotal` is 0

This is expected when every matching file has the same SHA as the row in `RagKbFileTracker`.

Force a full resync:

```sql
DELETE FROM "RagKbFileTracker"
WHERE "knowledgeBaseId" = '<kb-id>';
```

Then trigger sync.

### Dify Indexing Failed

Symptoms:

- `dify_indexing` failed
- `failedDocuments` in monitor

Actions:

1. Open the step log drawer.
2. Retry failed documents from the monitor.
3. Check `docker compose logs dify-api dify-worker --since 30m`.
4. Exclude or convert persistently unsupported files.

### Job Stuck Running

Workflow-service sweeps stale jobs using `lastProgressAt`. To inspect:

```sql
SELECT j.id, j.status, j."lastProgressAt", j."createdAt", kb.name
FROM "RagKbSyncJob" j
JOIN "RagKnowledgeBase" kb ON kb.id = j."knowledgeBaseId"
WHERE j.status IN ('running', 'pending')
ORDER BY j."createdAt" DESC;
```

Manual timeout:

```sql
UPDATE "RagKbSyncJob"
SET status = 'timed_out',
    "errorMessage" = 'Manually timed out by operator',
    "completedAt" = NOW()
WHERE id = '<sync-job-id>'
  AND status IN ('running', 'pending');
```

## Diagnostic SQL

Recent jobs:

```sql
SELECT id, status, trigger, "filesProcessed", "filesTotal",
       "errorMessage", "lastProgressAt", "createdAt", "completedAt"
FROM "RagKbSyncJob"
WHERE "knowledgeBaseId" = '<kb-id>'
ORDER BY "createdAt" DESC
LIMIT 10;
```

Steps:

```sql
SELECT "stepsJson"
FROM "RagKbSyncJob"
WHERE id = '<sync-job-id>';
```

Tracked files:

```sql
SELECT "filePath", "fileSha", "difyDocumentId", "syncedAt"
FROM "RagKbFileTracker"
WHERE "knowledgeBaseId" = '<kb-id>'
ORDER BY "filePath"
LIMIT 100;
```

Tracked file counts:

```sql
SELECT kb.name, COUNT(t.id) AS tracked_files
FROM "RagKnowledgeBase" kb
LEFT JOIN "RagKbFileTracker" t ON t."knowledgeBaseId" = kb.id
GROUP BY kb.id, kb.name
ORDER BY kb.name;
```

Path filters:

```sql
SELECT id, name, "sourceType", "sourceUrl", "sourceBranch", "sourcePath", "sourcePaths"
FROM "RagKnowledgeBase"
ORDER BY "updatedAt" DESC;
```

## n8n Workflow Maintenance

Template files:

```text
infra/n8n/templates/github-to-dify-sync.json
infra/n8n/templates/gitlab-to-dify-sync.json
```

Editing the JSON file alone does not update the active n8n workflow. Publish a new `workflow_history` version and update `workflow_entity.activeVersionId`, then recreate n8n if needed:

```bash
docker compose stop n8n
docker compose rm -f n8n
docker compose up -d n8n
```

Known workflow IDs:

| Workflow | ID |
|----------|----|
| GitHub to Dify Sync | `4f8dbb73-d6c5-4a55-8178-8c4f51c76d01` |
| GitLab to Dify Sync | `22d3d7b8-d94b-4300-a3a3-b55835e6c902` |
