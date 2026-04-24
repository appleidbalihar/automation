# Web UI Operations Guide

This guide covers every page in the operator dashboard at `https://<host>/` and how to perform common operational tasks.

---

## Accessing the Platform

**URL**: `https://<host>/` (port 3443 via Nginx ingress)

On first load, if you are not authenticated, the app redirects you to the Keycloak login page.

**Default account** (first deployment):
- Username: `platform-admin`
- Password: `admin123`
- Role: `admin` (full access)

After login you are redirected to the Dashboard.

---

## Navigation Sidebar

The left-side navigation bar is visible on all authenticated pages. Links shown depend on your role.

| Link | Visible to | Destination |
|------|-----------|-------------|
| Dashboard | all | `/dashboard` |
| Operations AI | all | `/operations-ai` |
| Integrations | operator+ | `/integrations` |
| Logs | operator+ | `/logs` |
| Secrets | admin | `/secrets` |
| Security | admin | `/security` |
| Users | admin, useradmin | `/users` |
| Profile | all | `/profile` |

---

## Dashboard — `/dashboard`

**Purpose**: At-a-glance status of the platform and quick links to common tasks.

**What you see**:
- Platform name and status banner
- Quick-action cards: Operations AI, Logs, Integrations, Admin Tools
- Links to recent activity (if any)

**Common actions from this page**:
- Click **Operations AI** to start a chat with the knowledge base
- Click **Integrations** to manage document sources
- Click **Logs** to investigate recent events

---

## Operations AI — `/operations-ai`

**Purpose**: Chat with the platform's knowledge base. The AI answers questions by retrieving relevant documents from the indexed sources.

### Starting a new conversation

1. Click **New Conversation** (top-right of the chat panel)
2. Type your question in the message box at the bottom
3. Press Enter or click **Send**
4. The AI responds with retrieved context from the knowledge base

### Viewing conversation history

Past conversations are listed in the left panel (thread list). Click any thread to resume it.

### Switching knowledge bases

If multiple knowledge bases are configured, a dropdown at the top of the chat panel lets you select which KB to query. The default KB is pre-selected.

### Setup wizard — `/operations-ai/setup`

If no knowledge base is configured yet, the chat page shows a prompt to run the setup wizard. The wizard guides you through:
1. Choosing a source type
2. Entering source credentials
3. Creating the first knowledge base
4. Triggering an initial sync

### Dify chat — `/operations-ai-dify`

An alternate chat interface that connects directly to the Dify backend. Functionally equivalent to the main chat but uses a slightly different layout. New deployments default here; the `/operations-ai` page is kept for continuity.

---

## Integrations — `/integrations`

**Purpose**: Manage knowledge base sources. Each integration is a document source (GitHub repo, GitLab repo, Google Drive folder, or web URL) that is periodically synced into Dify for RAG retrieval.

**Required role**: `operator` or higher

### Viewing existing integrations

The page lists all configured knowledge bases with:
- Source type (GitHub, GitLab, Google Drive, Web)
- Source URL / path
- Last sync status and timestamp
- Active sync job progress (live progress bar if a sync is running)

### Creating a new integration

1. Click **Add Integration** (top-right)
2. Fill in the form:
   - **Name**: A human-readable label
   - **Source type**: GitHub / GitLab / Google Drive / Web
   - **Source URL**: Repository URL, Drive folder ID, or web URL
   - **Branch** (Git sources): Default branch to crawl
   - **Path** (Git sources): Sub-directory to limit scope (optional)
   - **Credentials**: Optionally enter a PAT here — or leave blank and connect via OAuth after creation
3. Click **Create**
4. The integration appears in the list with status `pending`

### Connecting credentials via OAuth (recommended)

Each GitHub / GitLab / Google Drive integration row shows a credential panel with two tabs:

**Connect OAuth tab** (default):
- Click **Connect [Provider]** — you are redirected to the provider's authorization page
- Approve access on the provider's site
- You are returned to `/integrations` with a success toast
- The credential badge updates to show `🔗 OAuth`
- To reconnect (e.g. after token revocation): click **Reconnect**
- To switch back to PAT: click **Disconnect**

**Token (PAT) tab** (fallback / advanced):
- Paste a Personal Access Token and click **Save Token**
- PAT is ignored if an active OAuth token is present — disconnect OAuth first if you want to switch

### Triggering a manual sync

1. Find the integration in the list
2. Click the **Sync** button (circular arrow icon)
3. A new sync job starts; the row shows a progress bar
4. Sync steps and file counts update in real time (n8n sends progress callbacks)
5. On completion, status changes to `completed` with timestamp

### Cancelling a running sync

Click the **Cancel** button on the progress bar row. The n8n execution is stopped and the sync job is marked `cancelled`.

### Viewing sync history

Click the **History** icon on any integration row to see a list of past sync jobs with:
- Trigger type (manual, scheduled, webhook)
- Files processed / total
- Chunks processed / total
- Duration
- Error message (if failed)

### Configuring a knowledge base

Click the **Settings** (gear) icon on an integration to open the KB configuration panel:

| Field | Description |
|-------|-------------|
| System prompt | Base instructions given to the LLM for every query |
| LLM model | Which model Dify uses (e.g. gpt-4o, claude-3) |
| Temperature | Response creativity (0 = deterministic, 1 = creative) |
| Response style | Tone: concise, detailed, bullet points |
| Tone instructions | Additional tone directives |
| Restriction rules | Topics the AI should decline to answer |
| Welcome message | Shown when a new conversation starts |

Click **Save** to apply. Changes take effect on the next conversation.

### Setting the default knowledge base

Click **Set as Default** on any integration. The default KB is pre-selected in the Operations AI chat for all operators.

### Deploying a channel (Slack, Telegram, etc.)

1. Open the integration's **Channels** tab
2. Click **Add Channel**
3. Select channel type: Slack / Discord / WhatsApp / Telegram / Google Chat
4. Enter channel name and connection details
5. Click **Deploy**
6. n8n provisions the bot; status shows `active` when ready

### Deleting an integration

Click the **Delete** (trash) icon. This removes the integration record, stops future syncs, and removes the Dify dataset. Running sync jobs are cancelled first.

---

## Logs — `/logs`

**Purpose**: Search, filter, and inspect platform event logs from all services.

**Required role**: `operator` or higher

### Log list view

Logs are displayed newest-first with columns:
- Timestamp
- Severity (INFO, WARN, ERROR)
- Source service (api-gateway, workflow-service, logging-service, web)
- Message summary
- Correlation ID (click to filter by this ID)

### Filtering logs

Use the filter bar at the top:

| Filter | Description |
|--------|-------------|
| Date range | Start and end datetime |
| Severity | INFO / WARN / ERROR / DEBUG |
| Source | Service name |
| Correlation ID | Trace all events for one request |
| Full-text search | Keyword search in message text |

Click **Apply** to refresh results.

### Viewing a log entry detail

Click any row to expand the detail panel:
- Full message text
- Masked payload (sensitive fields replaced with `***`)
- Duration (ms) if applicable
- All metadata fields

### Execution timeline

When filtering by Correlation ID, a **Timeline** tab shows all events for that request in chronological order — useful for tracing a slow sync or failed chat request across services.

### Exporting logs

Click **Export CSV** (top-right) to download the current filtered view as a CSV file.

---

## Secrets — `/secrets`

**Purpose**: Manage platform secrets stored in HashiCorp Vault.

**Required role**: `admin`

### Secret catalog

Secrets are organized by **scope** and **group**:
- **Scope**: `global` (shared across platform) or `user` (per-user)
- **Group**: Logical category (e.g., `dify`, `github`, `keycloak`, `integrations`)

The left panel shows the catalog tree. Click a group to list its secrets.

### Viewing a secret

Click a secret name to see its metadata (key path, last updated). Values are not shown by default.

### Creating a secret

1. Click **New Secret** (top-right)
2. Select scope and group (or type a new group name)
3. Enter key name and value
4. Click **Save**

The secret is written to Vault at `secret/data/platform/{scope}/{group}/{key}`.

### Updating a secret

1. Click the secret name
2. Click **Edit**
3. Update the value
4. Click **Save**

Vault creates a new version; old versions are retained.

### Deleting a secret

Click **Delete** on the secret row. This soft-deletes the latest Vault version.

### Migrating secrets to Vault

If secrets were previously stored as environment variables, use **Admin → Migrate Secrets** (calls `POST /admin/secrets/migrate`) to batch-import them into Vault KV2.

---

## Security — `/security`

**Purpose**: Monitor TLS certificate health across all platform services and review rotation history.

**Required role**: `admin`

### Certificate status panel

A card is shown for each service certificate:

| Field | Description |
|-------|-------------|
| Service | Service name |
| Expiry date | Certificate expiry |
| Days remaining | Countdown |
| Status | `ok` / `warning` / `critical` / `expired` |
| Last renewed | When Vault Agent last issued a new certificate |

Status thresholds (configurable in `.env`):
- `ok`: > 7 days remaining
- `warning`: 3–7 days remaining
- `critical`: < 3 days remaining
- `expired`: Past expiry

### Alert history

The **Alerts** tab lists certificate alerts that have been emitted to RabbitMQ, with timestamp, service name, and severity.

### Manual rotation trigger

For emergency rotation, click **Rotate** on any service card. This signals the `cert-rotation-controller` to request a new certificate from Vault and restart the service.

---

## Users — `/users`

**Purpose**: Manage operator accounts in Keycloak.

**Required role**: `admin` or `useradmin`

### User list

All Keycloak users in the `automation-platform` realm are listed with:
- Username
- Email
- Assigned roles
- Status (enabled / disabled)

### Creating a user

1. Click **New User**
2. Fill in:
   - Username (required)
   - Email
   - First / Last name
   - Initial password (user must change on first login)
3. Select roles to assign
4. Click **Create**

### Editing a user

Click a username to open the edit panel. You can:
- Update email, name
- Enable / disable the account
- Reset password (sends reset email or sets directly)
- Add or remove roles

### Deleting a user

Click **Delete** on the user row. This permanently removes the Keycloak account.

### Role guide

| Role | Purpose |
|------|---------|
| admin | Platform-wide admin, secrets, users, certs |
| useradmin | Manage users (cannot access secrets/certs) |
| operator | Day-to-day operations: integrations, chat, logs |
| approver | Approve workflow steps |
| viewer | Read-only access to dashboard and logs |

---

## Profile — `/profile`

**Purpose**: View and update your own account settings.

**Accessible by**: all authenticated users

### What you can do

- View your username, email, and assigned roles
- Update display name and email
- Change your password
- View active sessions

---

## Common Operational Tasks

### Onboarding a new operator

1. Go to **Users** (`/users`)
2. Click **New User**, fill in details, assign role `operator`
3. Share the temporary password — user logs in and changes it
4. User visits `/operations-ai` and starts using the platform

### Setting up a new knowledge source (end-to-end)

1. Go to **Secrets** (`/secrets`) and store source credentials (GitHub token, etc.) in the appropriate Vault group
2. Go to **Integrations** (`/integrations`) and click **Add Integration**
3. Select source type, enter URL, reference the stored credential
4. Click **Create**, then **Sync** to run the first ingestion
5. Monitor sync progress on the integrations page
6. Once sync completes, go to **Operations AI** (`/operations-ai`) and verify the knowledge base answers questions correctly

### Investigating a failed sync

1. On **Integrations** page, find the integration with `failed` status
2. Click **History** to see the failed sync job
3. Note the error message and n8n execution ID
4. Go to **Logs** (`/logs`) and filter by Correlation ID or source `workflow-service` around the failure timestamp
5. If n8n-related, log into n8n UI at `http://<host>:5678` and find the execution by ID for detailed step output

### Tracing a slow or failed chat request

1. From the Operations AI page, note the time of the problematic request
2. Go to **Logs** (`/logs`)
3. Filter by date range around that time, source `api-gateway` or `workflow-service`, severity `WARN` or `ERROR`
4. Find the log entry for the message, copy the Correlation ID
5. Re-filter by Correlation ID to see the full request trace across services

### Checking certificate health

1. Go to **Security** (`/security`)
2. Review the certificate status cards
3. Any `warning` or `critical` services should be investigated
4. If a certificate has not auto-renewed (Vault Agent issue), click **Rotate** for the affected service

### Rotating a service secret (e.g., Dify API key)

1. Go to **Secrets** (`/secrets`)
2. Navigate to `global → dify`
3. Click the secret for the affected knowledge base
4. Click **Edit**, paste the new value, click **Save**
5. Trigger a new sync on the affected integration to verify the new key works
