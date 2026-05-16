# n8n Workflow Automation

n8n is the sync and channel delivery engine for this platform. It orchestrates:

1. **Document Sync**: GitHub / GitLab / Google Drive / Web → Dify Knowledge Base
2. **Channel Delivery**: Slack / Discord / Telegram / WhatsApp → Dify RAG → response back to channel

All credentials (source tokens, channel tokens, API keys) are stored in Vault.
n8n's own encryption key comes from Vault. TLS certs for n8n are auto-issued and
renewed by the `n8n-vault-agent` sidecar.

---

## Port Map

| Service  | Internal Port | Host Port | Purpose                          |
|----------|---------------|-----------|----------------------------------|
| `n8n`    | 5678          | **5679**  | Admin UI + webhook receiver      |
| `n8n-db` | 5432          | —         | Internal Postgres (isolated)     |

---

## First-Time Setup

### 1. Seed Vault secrets for n8n

Run this **once** after Vault bootstrap:

```bash
ROOT_TOKEN=$(docker exec vault-bootstrap cat /vault/file/vault-init.json | jq -r '.root_token')

VAULT_ADDR=http://localhost:8200 VAULT_TOKEN="${ROOT_TOKEN}" \
  bash infra/n8n/seed-vault-secrets.sh
```

Copy the output values into your `.env` file:
```
N8N_ENCRYPTION_KEY=<generated>
N8N_DB_PASSWORD=<generated>
N8N_WEBHOOK_TOKEN=<generated>
```

### 2. Start n8n services

```bash
docker compose up -d n8n-db n8n-vault-agent n8n
```

### 3. Open n8n Admin UI

Open **http://localhost:5679** in your browser.

> **Workflow import is automatic.** `infra/n8n/init-workflows.sh` runs on every
> container start and imports + activates `source-to-dify-sync.json` so the
> `rag-sync-source` webhook is always present. No manual import needed.

### 4. Configure n8n credentials for each source type

In n8n UI → **Credentials** → **Add credential**:

- **GitHub API**: Personal Access Token (stored encrypted in n8n)
- **GitLab API**: Private Token
- **Google Drive OAuth**: OAuth2 app credentials
- **Dify API**: HTTP Header Auth with the Dify App API key

> Note: The n8n credential store is encrypted with the `N8N_ENCRYPTION_KEY` from
> Vault. Individual user source tokens are also stored in Vault at
> `secret/data/platform/users/{userId}/sources/{kbId}/`.
> The sync workflows retrieve them from Vault before calling the source API.

---

## How Document Sync Works

```
Platform API  →  POST /rag/knowledge-bases/:id/sync
                    │
                    ▼
             workflow-service
                    │  reads kbId, sourceUrl, sourceType from DB
                    │  reads n8n_workflow_id from Vault
                    │
                    ▼
              n8n API: activate + run workflow
                    │
                    ▼
           n8n fetches docs from source
           (GitHub/GitLab/GDrive/Web)
                    │
                    ▼
           n8n sends docs to Dify KB API
           (chunked, embedded, indexed)
                    │
                    ▼
           n8n webhooks progress back to:
           POST /rag/knowledge-bases/:id/sync-progress
           (workflow-service updates RagKbSyncJob)
                    │
                    ▼
             Frontend polls sync status
             GET /rag/knowledge-bases/:id/sync-status
             → shows progress bar to user
```

---

## Sync Schedule

Users can configure a sync schedule per knowledge base (stored in `RagKnowledgeBase.syncSchedule`):

- `null` = manual sync only
- `"0 */6 * * *"` = every 6 hours
- `"0 2 * * *"` = daily at 2am
- `"0 2 * * 0"` = weekly on Sunday at 2am

The schedule is stored in Dify KB settings and the n8n workflow cron trigger.

## Generic Source Sync Workflow

`infra/n8n/templates/source-to-dify-sync.json` is the preferred workflow for
GitHub, GitLab, and Google Drive. It exposes one webhook:

```text
POST /webhook/rag-sync-source
```

The workflow keeps provider-specific work at the front of the flow:

- GitHub: parse owner/repo, list the git tree, and fetch raw files.
- GitLab: parse project path, list the repository tree with pagination, and
  fetch raw files.
- Google Drive: list a folder recursively with OAuth, download binary files,
  and export Google Docs/Sheets/Slides to Dify-supported Office formats.

After file listing, all providers use the same normalized item contract:

```json
{
  "provider": "github | gitlab | googledrive",
  "filePath": "docs/runbook.md",
  "fileSha": "provider-specific-change-id",
  "fileExt": "md",
  "fileIndex": 1,
  "totalFiles": 10,
  "isUpdate": false,
  "difyDocumentId": null
}
```

The remaining pipeline is shared: sync diff, skipped-file reporting, Dify
create/update, tracker callbacks, indexing polling, final status reporting, and
error callback handling.

Legacy provider-specific workflows remain available as fallback templates while
the generic workflow is rolled out.

---

## Vault Secret Paths for n8n

| Path | Key | Purpose |
|------|-----|---------|
| `secret/data/platform/global/n8n/config` | `encryption_key` | n8n credentials encryption key |
| `secret/data/platform/global/n8n/config` | `db_password` | n8n internal DB password |
| `secret/data/platform/global/n8n/config` | `webhook_token` | n8n webhook auth token |
| `secret/data/platform/users/{userId}/sources/{kbId}` | `github_token` | GitHub PAT (private repos) |
| `secret/data/platform/users/{userId}/sources/{kbId}` | `gitlab_token` | GitLab private token |
| `secret/data/platform/users/{userId}/sources/{kbId}` | `gdrive_token` | Google Drive OAuth token |
| `secret/data/platform/users/{userId}/sources/{kbId}` | `gdrive_refresh` | Google Drive refresh token |
| `secret/data/platform/users/{userId}/channels/{type}/{deploymentId}` | `bot_token` | Slack/Discord/Telegram bot token |

---

## Recovery Note

If n8n restarts, all workflow states are preserved in `n8n_db_data` volume.
Credentials are preserved in the encrypted n8n database.

Resume: `docker compose up -d n8n`

If encryption key was changed (do NOT change it after first run), credentials
need to be re-entered. Always keep the same `N8N_ENCRYPTION_KEY` across restarts.
