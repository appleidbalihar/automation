# Web UI Operations Guide

This guide describes the RapidRAG RAG-as-a-Service web UI under `apps/web`.

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
| AI Agent Prompt | `/ai-agent-prompt` | `admin`, `useradmin` |
| RAG Stats | `/rag-stats` | `admin` only |
| Logs | `/logs` | `admin` only |
| Users | `/users` | `admin` only in sidebar; API supports useradmin-specific operations |
| Secrets | `/secrets` | `admin` only |
| Security Health | `/security` | `admin` only |

The sidebar is a mobile-friendly drawer controlled by the menu button. It closes after route changes.

Compatibility routes:

- `/integrations` still opens the same Knowledge Connector UI.
- `/operations-ai`, `/operations-ai-dify`, and `/operations-ai/setup` redirect to current routes.

## Dashboard

Route: `/dashboard`

The dashboard gives quick links for chat, source setup, logs, and admin tools.

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
| Upload/manual | Stored as source metadata; no provider OAuth required |

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

## Output Gating

Location: Knowledge Connector → open a KB → **Fine-tune** tab → **Output Gating** collapsible section.

Output gating is a code-level filter that scans both the user's incoming question and the AI's response for sensitive data. It is independent of the system prompt — even if the LLM ignores its instructions, output gating still redacts credentials before they reach the user.

### Always-Blocked panel

Shows as a locked info panel: **Always Blocked 🔒 — 6 categories protected [View]**. Clicking View opens a modal listing all hardcoded categories:

| Category | Examples blocked |
|----------|----------------|
| Credentials | Passwords, default/initial credentials, API keys, tokens |
| Payment | Credit/debit card numbers, IBAN, bank account and routing numbers |
| Government Identity | SSN / national ID, passport numbers, driver's licence numbers |
| Cryptographic Material | PEM private keys (RSA, EC, SSH, PGP), JWT tokens |
| Medical / Health | Patient IDs, MRN, Medicare/Medicaid numbers |
| Other Sensitive | Security question answers |

These cannot be disabled. They apply to every KB regardless of configuration.

### Optional blocks

Two checkboxes, both off by default:

- **Email addresses** — enable if your KB contains personal or internal emails that should not be shown to users. Leave off for support/sales bots that need to share contact emails.
- **Phone numbers** — enable if your KB contains phone numbers that should remain private. Leave off for bots that need to provide support lines.

### Custom patterns

Add your own patterns using a label and a regex string:

1. Enter a **Label** — this appears in the redacted text, e.g. `Employee ID` → `[Employee ID REDACTED]`.
2. Enter a **Regex** — the pattern is validated inline before you can save. Invalid regex shows an error and disables Save.
3. Click **Add**. The pattern appears in the list with an enable/disable toggle and a delete button.

Examples: `EMP-\d{5}` for employee IDs, `\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b` for IP addresses.

Changes take effect on the next chat message — no restart required.

### Note on system prompts and output gating

Output gating is the security enforcement layer. The system prompt (`## Security — Absolute Rules` section) is advisory — it instructs the LLM to avoid revealing credentials, but it can be overridden by retrieved document content. Output gating is deterministic code that cannot be overridden. Both layers work together but output gating is the reliable backstop.

---

## AI Agent Prompt

Route: `/ai-agent-prompt`

Visibility: admin and useradmin.

Purpose: manage reusable system prompt templates for KB agents.

Capabilities:

- view built-in, owned, and shared templates
- create and edit private templates
- duplicate existing templates
- share templates with all users or specific users
- generate or improve prompt text through the backend generator endpoint
- apply a template to a knowledge base from the KB prompt/config flow

Backed API routes:

```text
GET /gateway/rag/prompt-templates
POST /gateway/rag/prompt-templates
GET /gateway/rag/prompt-templates/:id
PATCH /gateway/rag/prompt-templates/:id
DELETE /gateway/rag/prompt-templates/:id
POST /gateway/rag/prompt-templates/:id/duplicate
POST /gateway/rag/prompt-templates/:id/share
DELETE /gateway/rag/prompt-templates/:id/share/:userId
POST /gateway/rag/prompt-templates/generate
POST /gateway/rag/knowledge-bases/:id/apply-template
GET /gateway/rag/knowledge-bases/default-prompt
POST /gateway/rag/knowledge-bases/:id/generate-prompt
```

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

## RAG Stats

Route: `/rag-stats`

Visibility: admin-only.

The page calls:

```text
GET /gateway/rag/stats
```

It summarizes platform-wide RAG response timing from stored discussion/message data.

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
