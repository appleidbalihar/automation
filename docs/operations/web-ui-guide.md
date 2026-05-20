# Web UI Operations Guide

This guide describes the RapidRAG RAG-as-a-Service web UI under `apps/web`.

## Access

- Public landing page: `https://<host>:3443/`
- Authenticated platform shell: `https://<host>:3443/dashboard`
- API proxy used by the UI: `/gateway/*`

Unauthenticated users see the RapidRAG sign-in/register flow. Authenticated users enter the platform shell with the left navigation sidebar.

## Navigation Sidebar

The sidebar shows items in this order:

**Workspace section:**

| Link | Route | Visibility |
|------|-------|------------|
| Overview | `/dashboard` | all authenticated users |
| AI Agent | `/ai-agent-prompt` | `admin`, `useradmin` |
| Knowledge | `/knowledge-connector` | all authenticated users |
| RAG Assistant | `/rag-assistant` | all authenticated users |
| Chat Channels | `/chat-channels` | `admin`, `useradmin` |

**Account section:**

| Link | Route | Visibility |
|------|-------|------------|
| Profile | `/profile` | all authenticated users |

**Admin section:**

| Link | Route | Visibility |
|------|-------|------------|
| Analytics | `/rag-stats` | `admin` only |
| Sync Analytics | `/sync-analytics` | `admin` only |
| Logs | `/logs` | `admin` only |
| Users | `/users` | `admin` only in sidebar; API supports useradmin-specific operations |
| Secrets | `/secrets` | `admin` only |
| Security | `/security` | `admin` only |
| Dify Config | `/dify-config` | `admin` only |

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
3. The modal opens directly on the **provider picker** — select GitHub, GitLab, Google Drive, or Web URL.
4. For OAuth providers: follow the provider app setup instructions (Client ID + Secret), fill in the source details, and click **Create & Connect**.
5. For PAT/token auth: click **Use Personal Access Token (PAT) instead** at the bottom of the picker, select source type, paste the token, and create.
6. Web URL sources require no authentication — selecting Web URL goes directly to the PAT form with no token field shown.

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
- file counters with a top-level progress bar (files processed / total)
- step table
- error details
- failed Dify document retry controls
- step log drawer

### AI Indexing Progress Bar

For the `dify_indexing` and `retry_failed_indexing` steps, an inline progress bar appears inside the step row. It is 14 px tall with a green gradient fill and a light-green background, making it clearly readable at a glance. The bar shows `completed / total` documents as a percentage. When Dify stats have not yet arrived the bar shows an indeterminate pulsing animation.

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

## Chat Channels

Route: `/chat-channels`

Visibility: `admin`, `useradmin`.

Purpose: create and manage Slack bots, and link your personal Slack identity to accessible bots.

### Page Layout — Two Sections

**Section 1 — My Bots**

Bots you own. Full management: Create, Edit, Members, Deactivate, Delete.

| Column | Description |
|--------|-------------|
| Bot | Deployment name and workspace |
| Status | Active / Pending / Error / Disabled |
| Install | Manual app |
| Access Mode | Verified 🔒 or Open 🌐 |
| Knowledge | Mapped KB names |
| Actions | View, Edit, Members (verified + owner only), Deactivate, Delete |

**Section 2 — My Slack Connections**

All bots you can access — owned bots and bots shared with you. Shows your personal Slack identity link status for each.

| Column | Description |
|--------|-------------|
| Bot | Name and workspace |
| Access Mode | Verified 🔒 or Open 🌐 |
| Your Slack ID | Your linked Slack user ID, or amber "Not linked" |
| Your KBs | Count of KBs you have linked |
| Actions | Connect (not yet linked) or Update (already linked) |

### Create Bot Wizard

**Bot Token, Signing Secret, Client ID, Client Secret** — all four are required. Client ID and Client Secret enable the "Add to Slack" install link and Slack identity OAuth for users.

Click **Validate token** to confirm the workspace before activating.

**Verification toggle**:
- **Verified (default)**: per-user KB isolation. Each user links their Slack ID via OAuth. Unknown Slack users receive a "not connected" message.
- **Open access**: any Slack user gets answers from the bot's default KBs — no registration.

**Share scope**: Private / All RapidRAG users / Specific users.

After activation, the wizard shows:
- **Webhook URL** (copy button) — paste into Slack app Event Subscriptions and /kb slash command.
- **OAuth Redirect URL** (copy button) — paste into Slack app OAuth & Permissions → Redirect URLs.

### Edit Active Bot

When editing an already-active bot, the credentials form is not shown. Only deployment settings (name, share scope, verification mode, KBs) can be updated. To change credentials, deactivate and re-activate.

### Connect Wizard (My Slack Connections)

Clicking **Connect** or **Update** on a bot in Section 2:

1. **Phase 1 — Add to Slack**: click **Add to Slack** to install the bot app to your Slack workspace. Skip if already installed.
2. **Phase 2 — Link your identity**: choose your KBs (own + shared), click **Connect via Slack** → redirected to Slack OAuth → Slack captures your user ID → RapidRAG registers the mapping → green success banner on return.

After connecting, your Slack ID appears in the table and you can DM the bot immediately.

### Members Panel

Available to the deployment owner on verified-mode bots (Members button in Section 1).

| Column | Notes |
|--------|-------|
| RapidRAG User | Username if linked |
| Slack ID | Real Slack user ID, or amber "Not linked" for unlinked placeholder |
| KBs | Assigned knowledge bases |
| Status | Connected / Pending / Not linked |
| Action | Remove |

The owner's own entry starts as "Not linked" (synthetic placeholder) until they complete the Connect flow in Section 2. Manual add form: Slack user ID + optional RapidRAG username + KB selection.

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
