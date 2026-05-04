# Web UI Operations Guide

This guide describes the current RapidRAG web UI under `apps/web`.

## Access

- Public landing page: `https://<host>:3443/`
- Authenticated platform shell: `https://<host>:3443/dashboard`
- API proxy used by the UI: `/gateway/*`

Unauthenticated users see the RapidRAG sign-in/register flow. Authenticated users enter the platform shell with the left navigation sidebar.

## Navigation Sidebar

The sidebar currently shows:

| Link | Route | Visibility |
|------|-------|------------|
| Dashboard | `/dashboard` | all authenticated users |
| Knowledge Connector | `/knowledge-connector` | all authenticated users |
| RAG Assistant | `/rag-assistant` | all authenticated users |
| Profile | `/profile` | all authenticated users |
| Logs | `/logs` | `admin` only |
| Users | `/users` | `admin` only in sidebar |
| Secrets | `/secrets` | `admin` only |
| Security Health | `/security` | `admin` only |

The sidebar can be pinned/unpinned. The preference is stored in browser local storage under `platform-left-nav:pinned`.

Compatibility routes:

- `/integrations` still opens the same Knowledge Connector UI.
- `/operations-ai`, `/operations-ai-dify`, and `/operations-ai/setup` redirect to current routes.

## Dashboard

Route: `/dashboard`

The dashboard gives quick links for chat, source setup, logs, and admin tools. Some cards still use legacy route labels, but redirects keep them functional.

## Knowledge Connector

Route: `/knowledge-connector`

Purpose: create, edit, share, sync, cleanup, and delete knowledge sources.

Supported source types:

| UI source | Notes |
|-----------|-------|
| GitHub | OAuth or PAT, branch plus one or more document paths |
| GitLab | OAuth or PAT, branch plus one or more document paths |
| Google Drive | OAuth or token fields |
| Web URL | No OAuth required |

### Creating A Source

1. Open Knowledge Connector.
2. Click the create/connect action.
3. Choose OAuth or PAT.
4. Enter name, optional project name/description, source URL, branch, and one or more document paths.
5. For OAuth, follow the provider app setup instructions and connect.
6. For PAT, paste the relevant token and create.

The UI sends `sourcePaths` as an array. `sourcePath` is sent only for backward compatibility.

### Editing A Source

The edit modal can update:

- name
- project name
- description
- source URL
- branch
- source paths
- PAT token
- OAuth app credentials

When paths or project metadata change, the UI can trigger a smart sync that includes `addedPaths`, `removedPaths`, and `projectNameChanged`.

### OAuth

OAuth setup is per integration. The UI shows provider-specific setup steps and callback URLs based on environment settings.

Actions:

- Create and connect with OAuth.
- Reconnect OAuth after token expiry/revocation.
- Disconnect OAuth to fall back to PAT.
- Save OAuth app client ID/secret for the integration.

### Sharing

The Share modal grants another user chat access to a KB through:

```text
POST /gateway/rag/knowledge-bases/:id/shares
GET /gateway/rag/knowledge-bases/:id/shares
DELETE /gateway/rag/knowledge-bases/:id/shares/:shareId
```

Sharing grants chat access only. It does not share thread history.

### Manual Sync

Click Sync on a source row. The UI calls:

```text
POST /gateway/rag/knowledge-bases/:id/sync
```

The row and Sync Process Monitor show the latest job and step progress.

### Cancel Sync

Click Cancel for a running job. The UI calls:

```text
POST /gateway/rag/knowledge-bases/:id/sync-cancel
```

### Cleanup

Cleanup removes indexed Dify documents and resets sync state without deleting the integration record.

```text
POST /gateway/rag/knowledge-bases/:id/cleanup
```

The monitor shows cleanup-specific steps such as Dify document deletion and file tracker reset.

### Retry Failed Indexing

If Dify indexing fails, retry all failed documents or a selected document:

```text
POST /gateway/rag/knowledge-bases/:id/retry-failed-indexing
```

## Sync Process Monitor

The monitor is embedded in the Knowledge Connector page.

It shows:

- KB selector
- recent job history
- trigger type (`manual`, `cleanup`, `retry_failed_indexing`, etc.)
- file counters
- step table
- error details
- failed Dify document retry controls
- step log drawer

Common step names include:

| Step | Meaning |
|------|---------|
| `fetch_file_tree` | Fetch source file tree/list |
| `skip_sync` | No changed files were found |
| `upload_files` | Upload changed files to Dify |
| `dify_indexing` | Poll/wait for Dify indexing |
| `retry_failed_indexing` | Re-submit failed Dify documents |
| `cleanup_*` | Delete/reset indexed state |

The log drawer calls `/gateway/logs/sync-job?syncJobId=...&stepName=...`.

## RAG Assistant

Route: `/rag-assistant`

Purpose: chat with one or more Dify-backed knowledge bases.

Capabilities:

- start or resume private discussion threads
- select available KBs
- ask questions through Dify
- display per-KB answers in multi-KB responses
- link back to Knowledge Connector when no KB is ready

Legacy chat routes redirect here.

## Logs

Route: `/logs`

Visibility: admin-only in the sidebar and gateway.

The Logs Explorer supports:

- order/correlation ID filtering
- severity filtering
- source filtering
- message substring filtering
- refresh
- order timeline lookup

Backed API routes:

```text
GET /gateway/logs
GET /gateway/logs/timeline
```

Step-level sync logs use:

```text
GET /gateway/logs/sync-job
```

That route is also available to `useradmin` and `operator` for scoped sync investigation.

## Secrets

Route: `/secrets`

Visibility: admin-only.

The Secrets panel manages Vault-backed platform secrets:

- list catalog and stored secret metadata
- create/update/delete secrets
- read masked metadata
- run the legacy plaintext migration endpoint if needed

Backed API routes include `/gateway/admin/secrets`, `/gateway/admin/secrets/catalog`, `/gateway/admin/secrets/by-path`, and `/gateway/admin/secrets/migrate`.

## Security Health

Route: `/security`

Visibility: admin-only.

The Security Health page uses:

```text
GET /gateway/admin/security/certificates
GET /gateway/admin/security/certificates/events
POST /gateway/admin/security/certificates/:service/renew
```

The gateway monitors default targets for api-gateway, workflow-service, logging-service, and keycloak. Extra targets can be supplied through `CERT_TARGETS`.

## Users

Route: `/users`

Visibility: admin in the sidebar. API routes also include useradmin-specific permissions in the Next.js user admin endpoints.

User management is implemented in the web app through Keycloak admin APIs.

## Profile

Route: `/profile`

Users can view current identity details and change their own password.

## Current Operational Notes

- Prefer `/knowledge-connector` and `/rag-assistant` in new instructions.
- Treat `/integrations` and `/operations-ai*` as compatibility routes.
- Logs are platform-wide and admin-only except sync-job scoped logs.
- Source credentials, OAuth tokens, OAuth app credentials, and Dify API keys are Vault-only.
- Flowise is not a current runtime component.
