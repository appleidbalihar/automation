# RAG Knowledge Base Sync - Developer Reference

## Source Files

| Area | Files |
|------|-------|
| Gateway routes/auth | `apps/api-gateway/src/main.ts` |
| Sync orchestration | `apps/workflow-service/src/main.ts` |
| UI source management | `apps/web/src/app/integrations-page.tsx` and `apps/web/src/app/integrations/*` |
| Prisma models | `packages/db/prisma/schema.prisma` |
| n8n templates | `infra/n8n/templates/source-to-dify-sync.json` (unified), legacy: `github-to-dify-sync.json`, `gitlab-to-dify-sync.json` |

## Important Routes

### Browser-facing routes through api-gateway

| Method | Path | Roles |
|--------|------|-------|
| `GET` | `/rag/integrations` | authenticated platform roles |
| `POST` | `/rag/integrations` | authenticated platform roles |
| `PATCH` | `/rag/integrations/:id` | authenticated platform roles |
| `PATCH` | `/rag/integrations/:id/oauth-app-credentials` | `admin`, `useradmin`, `operator` |
| `DELETE` | `/rag/integrations/:id` | authenticated platform roles |
| `POST` | `/rag/integrations/:id/set-default` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases` | authenticated platform roles |
| `POST` | `/rag/knowledge-bases` | `admin`, `useradmin` |
| `GET` | `/rag/knowledge-bases/:id` | authenticated platform roles |
| `PATCH` | `/rag/knowledge-bases/:id/config` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases/default-prompt` | `admin`, `useradmin` |
| `POST` | `/rag/knowledge-bases/:id/generate-prompt` | `admin`, `useradmin` |
| `POST` | `/rag/knowledge-bases/:id/apply-template` | `admin`, `useradmin` |
| `POST` | `/rag/knowledge-bases/:id/shares` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases/:id/shares` | authenticated platform roles |
| `DELETE` | `/rag/knowledge-bases/:id/shares/:shareId` | authenticated platform roles |
| `POST` | `/rag/knowledge-bases/:id/sync` | `admin`, `useradmin`, `operator` |
| `POST` | `/rag/knowledge-bases/:id/sync-cancel` | `admin`, `useradmin`, `operator` |
| `POST` | `/rag/knowledge-bases/:id/retry-failed-indexing` | `admin`, `useradmin`, `operator` |
| `POST` | `/rag/knowledge-bases/:id/cleanup` | `admin`, `useradmin`, `operator` |
| `GET` | `/rag/knowledge-bases/:id/sync-status` | authenticated platform roles |
| `GET` | `/rag/knowledge-bases/:id/sync-history` | `admin`, `useradmin`, `operator` |
| `GET` | `/logs/sync-job` | `admin`, `useradmin`, `operator` |

### Prompt template routes through api-gateway

| Method | Path | Roles |
|--------|------|-------|
| `GET` | `/rag/prompt-templates` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates` | `admin`, `useradmin` |
| `GET` | `/rag/prompt-templates/:id` | `admin`, `useradmin` |
| `PATCH` | `/rag/prompt-templates/:id` | `admin`, `useradmin` |
| `DELETE` | `/rag/prompt-templates/:id` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates/:id/duplicate` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates/:id/share` | `admin`, `useradmin` |
| `DELETE` | `/rag/prompt-templates/:id/share/:userId` | `admin`, `useradmin` |
| `POST` | `/rag/prompt-templates/generate` | `admin`, `useradmin` |

### n8n/internal callback routes

| Method | Path | Auth |
|--------|------|------|
| `POST` | `/rag/knowledge-bases/:id/sync-diff` | `X-Rag-Sync-Token` or `X-N8N-Webhook-Token` |
| `POST` | `/rag/knowledge-bases/:id/sync-progress` | `X-Rag-Sync-Token` or `X-N8N-Webhook-Token` |
| `POST` | `/rag/sync-error-handler` | internal n8n error flow |

## Current Sync Diff

The implementation is `POST /rag/knowledge-bases/:id/sync-diff` in workflow-service.

Input shape:

```json
{
  "syncJobId": "job-id",
  "tree": [
    { "path": "docs/runbook.md", "type": "blob", "sha": "abc123" }
  ]
}
```

Output shape:

```json
{
  "ok": true,
  "files": [
    {
      "path": "docs/runbook.md",
      "sha": "abc123",
      "isUpdate": false
    }
  ]
}
```

For modified files, the returned item can include `difyDocumentId` and `isUpdate: true`.

The diff logic uses:

- `RagKnowledgeBase.sourcePaths` for configured path filters.
- legacy `RagKnowledgeBase.sourcePath` only as a fallback.
- `RagKbFileTracker` for prior `filePath`, `fileSha`, and `difyDocumentId`.

Do not use `RagKbSourcePath`; it is an old table name.

## File Tracker Updates

`sync-progress` updates `RagKbFileTracker` when it receives:

```json
{
  "status": "running",
  "step": {
    "stepName": "upload_file_success",
    "status": "completed"
  },
  "filePath": "docs/runbook.md",
  "fileSha": "abc123",
  "difyDocumentId": "dify-doc-id"
}
```

The service upserts by `(knowledgeBaseId, filePath)`.

## Step JSON

`RagKbSyncJob.stepsJson` is stored as an array. The helper updates the entry with the same `stepName` if present, otherwise it appends a new step.

Common step object:

```json
{
  "task": "Upload Files",
  "stepName": "upload_files",
  "status": "running",
  "startedAt": "2026-05-04T12:00:00.000Z",
  "message": "3/8 processed",
  "errorMessage": null
}
```

`dify_indexing` and `retry_failed_indexing` may include `failedDocuments`.

## Job Statuses

Expected values include:

- `pending`
- `running`
- `completed`
- `failed`
- `timed_out`
- `cancelled`

`lastProgressAt` is refreshed on callbacks and used for stale-job sweeping.

## UI Integration

Current primary routes:

- `/knowledge-connector`: source and sync management.
- `/rag-assistant`: Dify-backed chat.
- `/ai-agent-prompt`: reusable system prompt template management for admin/useradmin.

Compatibility routes:

- `/integrations`: same component as Knowledge Connector.
- `/operations-ai`, `/operations-ai-dify`, `/operations-ai/setup`: redirects.

Important UI files:

- `CreateSourceModal.tsx`: OAuth/PAT create flow and provider setup instructions.
- `EditSourceModal.tsx`: metadata/path/token/OAuth updates.
- `KnowledgeSourcesTable.tsx`: row actions including sync, cleanup, share, edit, delete.
- `SyncProcessMonitor.tsx`: job polling, step table, retry actions.
- `StepLogDrawer.tsx`: `/logs/sync-job` drawer.
- `prompt-templates/*`: template list, cards, editor modal, and API client.

## Prompt Templates

Prompt templates are stored in `SystemPromptTemplate` and `SystemPromptTemplateShare`. Built-in templates are seeded by workflow-service startup logic, private templates belong to `ownerId`, and shared templates use either `shareScope = "all"` or rows in `SystemPromptTemplateShare`.

Applying a template:

```text
POST /rag/knowledge-bases/:id/apply-template { "templateId": "..." }
```

The workflow-service checks visibility, updates `RagKnowledgeBase.templateId`, writes prompt-related KB config fields, and pushes the prompt to Dify when a Dify app is available.

## Cleanup

Full cleanup endpoint:

```text
POST /rag/knowledge-bases/:id/cleanup
```

It cancels any running sync, deletes indexed Dify documents where possible, clears tracker rows, resets KB sync state, and writes a cleanup sync job so the monitor/history can show what happened.

## Retry Failed Indexing

Retry endpoint:

```text
POST /rag/knowledge-bases/:id/retry-failed-indexing
```

Request body may include a `syncJobId` and/or `documentIds`. The workflow-service creates a retry job with `trigger: "retry_failed_indexing"` and step name `retry_failed_indexing`.

## n8n Template Updates

All source types (GitHub, GitLab, Google Drive) route through one unified workflow:

```text
infra/n8n/templates/source-to-dify-sync.json   ← the only active template
```

`infra/n8n/init-workflows.sh` imports and activates this file automatically on
every container start (mounted via `docker-compose.yml`). To apply a template
change, edit the JSON and restart n8n:

```bash
scripts/platform-containers.sh dev restart n8n
```

Active workflow:

| Workflow | Webhook path | ID |
|----------|--------------|----|
| Generic Source to Dify Sync | `POST /webhook/rag-sync-source` | `rag-sync-source-template` |

Legacy workflows (inactive):

| Workflow | ID |
|----------|----|
| GitHub → Dify KB Sync | `c81ad5e4-7f92-4e07-a2d3-741534a0c16c` |
| GitLab → Dify KB Sync | `22d3d7b8-d94b-4300-a3a3-b55835e6c902` |

## Development Checks

Useful commands:

```bash
pnpm --filter workflow-service test
pnpm --filter web build
pnpm --filter api-gateway build
docker compose logs workflow-service --since 30m
docker compose logs n8n --since 30m
```
