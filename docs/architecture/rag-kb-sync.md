# RAG Knowledge Base Sync - Architecture

## Scope

This document describes the current source sync architecture for GitHub/GitLab/Google Drive/Web source records into Dify-backed knowledge bases. The active code is in `apps/workflow-service/src/main.ts`, `apps/api-gateway/src/main.ts`, and `apps/web/src/app/integrations/*`.

## Component Flow

```text
Knowledge Connector UI
  |
  | POST /gateway/rag/knowledge-bases/:id/sync
  v
api-gateway
  |
  | proxy to workflow-service
  v
workflow-service
  |
  | create RagKbSyncJob and trigger n8n webhook
  v
n8n workflow
  |
  | fetch source tree/files
  | POST /rag/knowledge-bases/:id/sync-diff
  | upload/update documents in Dify
  | POST /rag/knowledge-bases/:id/sync-progress
  v
workflow-service updates PostgreSQL
  |
  v
SyncProcessMonitor polls status/history and reads sync-job logs
```

## Current Data Model

| Model | Role in sync |
|-------|--------------|
| `RagKnowledgeBase` | Source URL, source type, branch, `sourcePaths`, Dify dataset reference, owner/default/share relations |
| `RagKbFileTracker` | One row per indexed file: `filePath`, `fileSha`, `difyDocumentId` |
| `RagKbSyncJob` | Job status, counters, n8n execution metadata, `stepsJson`, `lastProgressAt` |
| `PlatformLog` | Sanitized sync log lines queried by `/logs/sync-job` |

Removed/stale name: `RagKbSourcePath` is not current. Use `RagKbFileTracker`.

## Smart Diff

`POST /rag/knowledge-bases/:id/sync-diff` receives a source tree from n8n and returns only files that need work.

The workflow-service:

1. Loads the KB.
2. Filters to supported document extensions.
3. Applies `sourcePaths` filters, falling back to legacy `sourcePath` only when needed.
4. Loads existing `RagKbFileTracker` rows.
5. Deletes tracker rows and Dify documents that no longer exist in the configured paths.
6. Returns new files and modified files. Modified files include the previous `difyDocumentId` so n8n can update rather than create where supported.

Supported extensions in code:

```text
md, markdown, txt, html, htm, xml, csv, pdf, docx, xlsx, xls,
pptx, ppt, eml, msg, epub, rst, mdx
```

## Step Storage

`RagKbSyncJob.stepsJson` is an array of step objects. The service upserts by `stepName`: the latest callback for a step replaces the existing object with the same `stepName`.

Common step names:

| Step | Meaning |
|------|---------|
| `fetch_file_tree` | Source tree/list retrieval |
| `calculate_diff` | Backend diff against `RagKbFileTracker` |
| `cleanup_removed_paths` | Delete obsolete Dify documents and tracker rows |
| `skip_sync` | No changed files were returned by diff |
| `upload_files` | Upload or update source files in Dify |
| `upload_file_success` | Per-file success callback that upserts `RagKbFileTracker` |
| `dify_indexing` | Dify indexing status/polling |
| `retry_failed_indexing` | Retry failed Dify documents |
| `cleanup_dify_documents`, `cleanup_vector_embeddings`, `cleanup_reset_state`, `cleanup_file_tracker` | Full cleanup operation |

## Auth Boundaries

| Endpoint group | Caller | Auth |
|----------------|--------|------|
| `/rag/integrations*` | Web UI/API client | JWT role checks in api-gateway |
| `/rag/knowledge-bases/:id/sync` | Web UI/API client | `admin`, `useradmin`, `operator` |
| `/rag/knowledge-bases/:id/sync-status` | Web UI/API client | authenticated platform roles |
| `/rag/knowledge-bases/:id/sync-history` | Web UI/API client | `admin`, `useradmin`, `operator` |
| `/rag/knowledge-bases/:id/sync-diff` | n8n | sync token |
| `/rag/knowledge-bases/:id/sync-progress` | n8n | sync token |
| `/rag/sync-error-handler` | n8n | internal/sync-error flow |
| `/logs/sync-job` | Web UI | `admin`, `useradmin`, `operator` |

n8n callbacks use `X-Rag-Sync-Token` or `X-N8N-Webhook-Token`, checked against `N8N_WEBHOOK_TOKEN`.

## Polling Model

`SyncProcessMonitor.tsx` polls:

- `GET /rag/knowledge-bases/:id/sync-status`
- `GET /rag/knowledge-bases/:id/sync-history`
- `GET /logs/sync-job?syncJobId=...&stepName=...` for drawer logs

Polling is simple HTTP polling rather than WebSockets/SSE. It matches the n8n callback model and keeps the runtime small.

## Failure And Recovery

- Failed source access appears on `fetch_file_tree` or `calculate_diff`.
- Failed Dify indexing can include `failedDocuments`.
- Retry calls `POST /rag/knowledge-bases/:id/retry-failed-indexing`.
- Cleanup calls `POST /rag/knowledge-bases/:id/cleanup`.
- Cancel calls `POST /rag/knowledge-bases/:id/sync-cancel`; if `N8N_API_KEY` and execution ID are present, workflow-service also asks n8n to stop the execution.
- Stale jobs are tracked with `lastProgressAt` and swept by workflow-service.
