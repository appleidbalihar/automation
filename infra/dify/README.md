# Dify RAG Stack

Dify is the multi-tenant RAG engine for this platform. Each knowledge base maps
to one Dify App. API keys are stored in Vault — never in env vars or code.

TLS certificates for `dify-api` and `dify-worker` are auto-issued and renewed
by the `dify-api-vault-agent` sidecar, following the same pattern as all other
platform services.

---

## Port Map

| Service     | Internal Port | Host Port | Purpose                          |
|-------------|---------------|-----------|----------------------------------|
| `dify-api`  | 5001          | —         | API server (internal only)       |
| `dify-web`  | 3000          | **3002**  | Admin UI (setup + KB management) |
| `dify-db`   | 5432          | —         | Internal Postgres (isolated)     |
| `dify-redis`| 6379          | —         | Internal Redis (isolated)        |

---

## First-Time Setup

### 1. Seed Vault secrets for Dify

Run this **once** after Vault bootstrap (`vault-bootstrap` container completes):

```bash
# Get the Vault root token from the running vault-bootstrap output or vault-init.json
ROOT_TOKEN=$(docker exec vault-bootstrap cat /vault/file/vault-init.json | jq -r '.root_token')

VAULT_ADDR=http://localhost:8200 VAULT_TOKEN="${ROOT_TOKEN}" \
  bash infra/dify/seed-vault-secrets.sh
```

Copy the output values into your `.env` file:
```
DIFY_SECRET_KEY=<generated>
DIFY_DB_PASSWORD=<generated>
DIFY_REDIS_PASSWORD=<generated>
```

### 2. Start Dify services

```bash
docker compose up -d dify-db dify-redis dify-api-vault-agent dify-api dify-worker dify-sandbox dify-web
```

### 3. Initialize Dify admin account

Open **http://localhost:3002** in your browser and complete the setup wizard:
- Create the admin account
- No external LLM key needed at this step

### 4. Configure an LLM provider in Dify

In the Dify UI → Settings → Model Provider:
- Add **OpenAI** (or any OpenAI-compatible provider)
- Enter your API key (stored in Dify's encrypted settings — not Vault, since Dify manages it internally)
- Set Base URL if using an OpenAI-compatible provider (e.g., `https://api.fuelix.ai/v1`)

### 5. Create a Knowledge Base in Dify

For each tenant knowledge base:

1. In Dify UI → **Knowledge** → **Create Knowledge**
2. Name it (e.g., "Platform Operations Docs")
3. Choose data source:
   - **GitHub**: enter repo URL + branch (n8n will sync this — see infra/n8n/README.md)
   - **GitLab**: same
   - **Google Drive**: authorize via OAuth
   - **Web**: enter URL to crawl
4. Set chunk size: **1800** / overlap: **200** (matches legacy Flowise config)
5. Choose embedding model (same one used for chat)
6. Click **Save and Process** — Dify indexes the docs

### 6. Create a Chat App in Dify and get the API key

1. In Dify UI → **Studio** → **Create App** → **Chat App**
2. In the app settings:
   - **Context**: select the Knowledge Base created above
   - **System Prompt**: paste the technical engineer prompt (see below)
   - **LLM**: select your model (e.g., gpt-4o-mini), temperature 0.2
3. Click **Publish**
4. Go to **API Access** → copy the **API Key** (starts with `app-`)

### 7. Register the Knowledge Base in the platform

Use the platform API to register the KB:

```bash
# Create the KB record in the platform database
curl -X POST https://localhost:4000/rag/knowledge-bases \
  -H "Authorization: Bearer <your-admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Platform Operations Docs",
    "description": "Automation platform operations and developer documentation",
    "sourceUrl": "https://github.com/appleidbalihar/automation",
    "sourceBranch": "master",
    "sourcePath": "docs/",
    "sourceType": "github",
    "difyAppUrl": "http://dify-api:5001",
    "difyApiKey": "app-xxxxxxxxxxxx",
    "isDefault": true
  }'
```

This call writes the API key to Vault automatically — it never stays in the
request or the database.

### 8. Verify the KB works

```bash
# Test a question through the platform
curl -X POST https://localhost:4000/rag/discussions \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"knowledgeBaseId": "<kb-id-from-step-7>"}'

# Then send a message
curl -X POST https://localhost:4000/rag/discussions/<thread-id>/messages \
  -H "Authorization: Bearer <your-token>" \
  -H "Content-Type: application/json" \
  -d '{"content": "How do we register a new user?"}'
```

---

## System Prompt (Technical Engineer)

Use this in your Dify Chat App system prompt:

```
You are the automation platform technical engineer assisting customers from the platform knowledge base.

Rules:
- Answer like a technical support engineer who knows the product and operations docs.
- Prefer concise, practical steps and mention the relevant service, page, endpoint, or document when possible.
- Only answer with information supported by the provided context.
- If the answer is incomplete in the context, say exactly what is known and what is missing.
- If the docs do not contain the answer, say "I can't confirm that from the current documentation." Do not invent details.
```

---

## Vault Secret Paths

| Path | Key | Purpose |
|------|-----|---------|
| `secret/data/platform/global/dify/config` | `secret_key` | Dify internal signing key |
| `secret/data/platform/global/dify/config` | `db_password` | Dify internal DB password |
| `secret/data/platform/global/dify/config` | `redis_password` | Dify internal Redis password |
| `secret/data/platform/global/dify/{kbId}` | `api_key` | Per-KB Dify App API key |
| `secret/data/platform/global/dify/{kbId}` | `n8n_workflow_id` | n8n sync workflow ID for this KB |
| `secret/data/platform/users/{userId}/sources/{kbId}` | `github_token` | GitHub PAT for private repos |
| `secret/data/platform/users/{userId}/sources/{kbId}` | `gitlab_token` | GitLab token for private repos |
| `secret/data/platform/users/{userId}/sources/{kbId}` | `gdrive_token` | Google Drive OAuth access token |

---

## Recovery Note

If Dify containers restart and KB data appears missing:
1. The vector data is persisted in `dify_storage` Docker volume — it survives restarts.
2. The KB metadata is in `dify_db_data` Docker volume — also persisted.
3. Re-sync via the platform UI or `POST /rag/knowledge-bases/:id/sync` if needed.

Resume: `docker compose up -d dify-api dify-worker dify-web`
