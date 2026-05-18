# Production Deployment — Task Tracker

**Target:** First production installation on `rapidrag.ai`
**Reference guide:** [PRODUCTION_MIGRATION.md](../../PRODUCTION_MIGRATION.md)
**Created:** 2026-05-08 based on the dev clean-rebuild session

---

## Status Key

| Symbol | Meaning |
|--------|---------|
| ✅ | Done (verified working) |
| 🔧 | Done in dev — needs to be repeated in prod |
| ⬜ | Not done yet |
| ⚠️ | Partially done / needs attention |

---

## What We Did Today (Dev Rebuild — 2026-05-08)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | `docker compose down -v` — wipe all volumes | ✅ | All 27 volumes removed |
| 2 | Rebuild all images `--no-cache` | ✅ | ~6 min build |
| 3 | Start Vault + vault-bootstrap only | ✅ | PKI bootstrapped |
| 4 | Seed dev secrets via `seed-secrets.dev.sh` | ✅ | 8 paths seeded |
| 5 | Verify secrets via `list-secrets.sh` | ✅ | All 8 paths `[OK]` |
| 6 | Generate `.env.runtime` and start full stack | ✅ | All 34 containers up |
| 7 | **Bug fix:** minio `entrypoint: /bin/sh` in docker-compose.yml | ✅ | Was causing minio exit(1) |
| 8 | **Bug fix:** remove `_users_note` from realm-export.json | ✅ | Was crashing Keycloak on import |
| 9 | Shred `.env.runtime` after stack start | ✅ | |
| 10 | Create Keycloak `platform-admin` user with seed script | ✅ | Role: realm `admin` |
| 11 | n8n owner account created via REST (`/rest/owner/setup`) | ✅ | `admin@platform.local` |
| 12 | Import GitHub → Dify KB Sync workflow (CLI) | ✅ | 18-node template version |
| 13 | Import GitLab → Dify KB Sync workflow (CLI) | ✅ | 14-node template version |
| 14 | Publish workflows via `n8n publish:workflow` CLI | ✅ | Required in n8n 2.x |
| 15 | Activate workflows via REST API | ✅ | Both `active: true` |
| 16 | Restart n8n to register webhook listeners | ✅ | `/webhook/rag-sync-source` HTTP 200 |
| 17 | Save UUID to `github-to-dify-sync.json` template | ✅ | `c81ad5e4-...` |
| 18 | Update `PRODUCTION_MIGRATION.md` to reflect correct n8n CLI steps | ✅ | Steps 8 + 9 rewritten |

---

## Dev Stack — Current Credential Summary

| Service | Access | Username | Password |
|---------|--------|----------|----------|
| Keycloak Admin Console | `https://localhost:8443` | `admin` | `dev-kc-9afWEhNGiSzo9geLx3rxUKi` |
| Keycloak Platform App | `https://localhost:8443` → realm `automation-platform` | `platform-admin` | `OdY3Q4ZRQNWwHQelsjbaYnw5` |
| n8n Editor | `http://localhost:5679` | `admin@platform.local` | `Admin@Platform2026!` |
| MinIO Console | `https://localhost:9001` | `dev-minio-cdc3a4d2f4c96db10221` | from Vault |
| RabbitMQ Mgmt | `https://localhost:15671` | `platform` | from Vault |
| PostgreSQL | `localhost:5432` db=`automation` | `platform` | from Vault |
| Redis | `localhost:6379` | — | from Vault |
| OpenSearch | `https://localhost:9200` | `admin` | `DevImzTeHS0mUQ7limxY2gAa1!` |
| Dify | `http://localhost:3002` | `admin@platform.local` | `Admin@Platform2026!` |
| Vault | `http://localhost:8200` | root token | in `vault-init.json` |

> Retrieve any secret: `ENVIRONMENT=dev SHOW_VALUES=true bash scripts/list-secrets.sh`

---

## What Is Still Outstanding

### DEV — Remaining Setup

| # | Task | Priority | Notes |
|---|------|----------|-------|
| D1 | Dify admin account setup | ✅ Done | Completed via API: `admin@platform.local` / `Admin@Platform2026!` |
| D2 | Dify LLM provider configured | 🔴 High | Settings → Model Providers (use same key as Vault `platform/global/llm`) |
| D3 | Seed LLM credentials into Vault | 🔴 High | `vault kv put secret/platform/global/llm api_key=... model=... base_url=...` |
| D4 | Test full RAG sync (GitHub or GitLab) | 🟡 Medium | Create a Knowledge Source in the UI and trigger a sync |
| D5 | Create Knowledge Source in platform UI | 🟡 Medium | Tests the full pipeline end to end |

### PRODUCTION — First Deployment

| # | Task | Status | Reference |
|---|------|--------|-----------|
| P1 | Configure Docker data root on `/home` | ⬜ | PROD_MIG Step 1 |
| P2 | Clone repo to `/home/bali/09_rapidrag` | ⬜ | PROD_MIG Step 2 |
| P3 | Create `.env.production` (non-secret values only) | ⬜ | PROD_MIG Step 3 |
| P4 | Mount tmpfs at `/run/platform-secrets` | ⬜ | PROD_MIG Step 4.1 |
| P5 | Start Vault + bootstrap | ⬜ | PROD_MIG Step 4.2 |
| P6 | Get root token + seed prod secrets | ⬜ | PROD_MIG Step 4.3–4.4 |
| P7 | Verify all 8 secret paths `[OK]` | ⬜ | PROD_MIG Step 4.5 |
| P8 | Revoke root token immediately | ⬜ | PROD_MIG Step 4.6 |
| P9 | Optionally generate `/run/platform-secrets/.env.prod.runtime` for inspection, then shred it | ⬜ | PROD_MIG Step 4.7 |
| P10 | Build images `--no-cache` (Alpine-based: web ~240 MB, db-migrate ~315 MB, service-base ~1.1 GB) | ⬜ | PROD_MIG Step 5 |
| P10a | Prune old images + build cache after build: `docker image prune -a -f && docker builder prune -a -f` | ⬜ | Frees ~400+ GB of old layers |
| P11 | Start full stack with `/home/bali/09_rapidrag/scripts/platform-containers.sh prod start` | ⬜ | PROD_MIG Step 6 |
| P12 | Confirm no `/run/platform-secrets/.env.prod*` runtime env file remains after start | ⬜ | PROD_MIG Step 6 |
| P13 | Verify: `db-migrate` Exited(0), `dify-migrate` Exited(0) | ⬜ | PROD_MIG Step 6 |
| P14 | Run `ENVIRONMENT=prod bash scripts/seed-keycloak-platform-admin.sh` for `platform-admin` | ⬜ | PROD_MIG Step 7 |
| P15 | n8n: create owner account via REST API | ⬜ | PROD_MIG Step 8.1 |
| P16 | n8n: verify `rag-sync-source` webhook is live (auto-imported on start) | ⬜ | PROD_MIG Step 8.2 |
| P20 | Dify: create admin account via API (`POST /console/api/setup`) | ⬜ | PROD_MIG Step 9.1 |
| P21 | Dify: configure LLM provider (Settings → Model Providers) | ⬜ | PROD_MIG Step 9.2 |
| P22 | Seed Dify config to Vault (`platform/global/dify/config`) — `default_app_url`, `console_password`, `model_api_base`, `model_api_key`, `chat_model`, `embedding_model` | ⬜ | PROD_MIG Step 10.1 |
| P23 | Seed LLM config to Vault (`platform/global/llm`) — `api_key`, `model`, `base_url` (used by AI Agent Prompt page) | ⬜ | PROD_MIG Step 10.2 |
| P24 | Configure OAuth callback URLs (GitHub, GitLab, Google) | ⬜ | PROD_MIG Step 11 |
| P25 | Install Let's Encrypt cert for `rapidrag.ai` | ⬜ | PROD_MIG Step 12 |
| P26 | Configure and reload outer nginx | ⬜ | PROD_MIG Step 13 |
| P27 | Run all smoke tests | ⬜ | PROD_MIG Step 14 |
| P28 | Enable certbot auto-renewal cron | ⬜ | PROD_MIG Step 15 |
| P29 | Generate service credentials document from Vault | ⬜ | `ENVIRONMENT=prod bash scripts/generate-credentials-doc.sh` → `/root/platform-credentials-prod.md` |
| P30 | Apply Slack bot integration Prisma migration + regenerate Prisma client | ⬜ | `docs/plans/chat-channel-integration-plan.md` Phase 1 |
| P31 | Create production RapidRAG Bot Slack app | ⬜ | App name `RapidRAG Bot`; scopes `chat:write`, `commands`, `im:history`; enable Messages Tab; subscribe to `message.im` |
| P32 | Seed platform Slack OAuth app secrets in Vault/env: client ID, client secret, signing secret | ⬜ | `platform/global/slack/oauth/*` |
| P33 | Configure production Slack app URLs | ⬜ | Redirect: `/rapidrag/api/slack/oauth/callback`; Events + `/kb`: `/rapidrag/api/slack/events` |
| P34 | Add/reload nginx Slack public routes | ⬜ | `/rapidrag/api/slack/oauth/callback`, `/rapidrag/api/slack/events`, `/rapidrag/api/slack/events/<deploymentId>` |
| P35 | Set Slack rate-limit/backpressure values | ⬜ | `SLACK_WEBHOOK_RATE_LIMIT_PER_MINUTE`, `SLACK_WEBHOOK_RATE_LIMIT_BURST`, `SLACK_DIFY_CONCURRENCY_PER_DEPLOYMENT`; enable nginx `limit_req` only after staging validation |
| P36 | Slack smoke test | ⬜ | OAuth install, activate without channel, copy allowlist onboarding instructions, DM bot, `/kb list`, `/kb use`, invalid signature, retry dedup |

---

## Slack Bot Production Migration Details

Slack Phase 1 is **bot-first**. Production setup should not require a Slack channel. Users install RapidRAG Bot, map KBs, activate, then talk to the bot in a Slack DM or use `/kb`.

### P31 — Create Production RapidRAG Bot

Create one platform-owned Slack app:

```text
App name: RapidRAG Bot
Production workspace: <operator Slack workspace>
```

Configure Slack app settings:

| Slack App Area | Production Value |
|----------------|------------------|
| OAuth Redirect URL | `https://rapidrag.ai/api/slack/oauth/callback` |
| Event Subscriptions Request URL | `https://rapidrag.ai/api/slack/events` |
| App Home Messages Tab | On; allow users to send slash commands and messages |
| Bot event subscription | `message.im` |
| Slash command | `/kb` |
| Slash command Request URL | `https://rapidrag.ai/api/slack/events` |
| Slash command description | `Query RapidRAG knowledge bases` |
| Slash command usage hint | `[list \| use <name> \| all \| status \| help]` |

Required bot scopes:

```text
chat:write
commands
im:history
```

Add scopes under `OAuth & Permissions` -> `Scopes` -> `Bot Token Scopes`. Do not use `App-Level Tokens`.

Do not add channel scopes for Phase 1 unless shared-channel mode is intentionally enabled later.

### P32 — Seed Slack OAuth Secrets

After creating the Slack app, store these values in Vault:

```text
platform/global/slack/oauth/client_id
platform/global/slack/oauth/client_secret
platform/global/slack/oauth/signing_secret
```

Production runtime must expose these to workflow-service through the normal Vault/runtime env generation flow. Do not place Slack client secrets in `.env.production`, logs, browser URLs, or screenshots.

### P33/P34 — Public Routes

Ensure both inner and outer nginx route these public Slack paths to api-gateway:

```text
/rapidrag/api/slack/oauth/callback
/rapidrag/api/slack/events
/rapidrag/api/slack/events/<deploymentId>
```

Requirements:

- `/rapidrag/api/slack/oauth/callback` is public and preserves query parameters.
- api-gateway must proxy the OAuth callback with redirect following disabled and forward workflow-service `Location` headers to the browser. Verify the compiled gateway uses `reply.redirect(location, response.status)`.
- `/rapidrag/api/slack/events` and `/rapidrag/api/slack/events/<deploymentId>` are public and preserve exact raw request body bytes.
- Root `/api/...` must not be used for Slack routes on shared domains because it can belong to other applications.
- Do not log Slack request bodies because slash commands include `response_url`.
- OAuth installs use `/rapidrag/api/slack/events`.
- Advanced customer-owned bot installs use `/rapidrag/api/slack/events/<deploymentId>`.

### P35 — Rate Limit Policy

Prefer workflow-service/app-level rate limiting first because it can still acknowledge Slack and send:

```text
I'm receiving too many requests right now. Please try again in a minute.
```

Use nginx `limit_req` only after staging validation for abusive floods. If nginx rejects Slack before the app sees the request, Slack may retry and the user may not receive a friendly Slack message.

### P36 — Slack Smoke Test

Run after production deploy:

1. Open `https://rapidrag.ai/chat-channels`.
2. Click `Connect Slack`.
3. Enter a deployment name.
4. Click `Add RapidRAG Bot to Slack`.
5. Complete Slack OAuth.
6. Confirm the OAuth popup/window returns to RapidRAG without Cloudflare 502/404 and workspace name fills automatically.
7. Select at least one KB.
8. Activate without selecting a channel.
9. Confirm Slack App Home Messages Tab is enabled and users can send slash commands/messages from the messages tab.
10. If using allowlist mode, add a Slack user ID and click `Copy user instructions`.
11. Paste the copied text into a scratch file and confirm it includes bot name, Slack DM steps, `/kb list`, `/kb use <name>`, and Slack member ID recovery instructions.
12. Open Slack DM with RapidRAG Bot.
13. Run `/kb list`.
14. Run `/kb use 1`.
15. Ask a KB question in DM and confirm a Dify-backed answer.
16. Confirm Chat Channels history shows the Slack user conversation.
17. Send invalid Slack signature request and confirm `403` before Dify.
18. Replay the same Slack event ID and confirm no duplicate Dify call/reply.

### Rollback

If Slack integration causes production issues:

1. Deactivate affected Slack deployments in Chat Channels.
2. Disable Event Subscriptions and `/kb` in the Slack app if needed.
3. Disable public Slack nginx routes only for severe abuse or security incidents.
4. Keep the Prisma migration rollback decision explicit; do not drop Slack tables while production data may be needed for audit/history.

---

## Critical Lessons from Dev Rebuild (Apply to Prod)

### 1. MinIO entrypoint (already fixed in code)
`docker-compose.yml` now has `entrypoint: /bin/sh` on the minio service.
No action needed — the fix is in the repo.

### 2. Keycloak realm-export (already fixed in code)
`infra/keycloak/realm-export.json` no longer has `_users_note`.
No action needed — the fix is in the repo.

### 3. n8n workflows need CLI import, not UI import
The browser "Settings → Import" does NOT correctly publish workflows for webhook activation in n8n 2.x.
**Always use the CLI steps in PRODUCTION_MIGRATION.md Step 8.**

### 4. Restart containers only through the platform wrapper
The wrapper generates a short-lived runtime env from Vault, runs Docker Compose with the production override, then shreds the runtime env file:
```bash
/home/bali/09_rapidrag/scripts/platform-containers.sh prod restart <service-name>
```
After any start or restart, verify no runtime env file remains under `/run/platform-secrets`.

### 5. Dify setup can be done via API (no browser required)
`POST http://<host>:5001/console/api/setup` creates the admin account directly. Use `GET /console/api/setup` first to confirm `{"step": "not_started"}`. See PRODUCTION_MIGRATION.md Step 9.1 for the full commands.

### 6. Keycloak users live in `keycloak_data`
The `automation-platform` realm import is bootstrap-only. Production must keep the inherited `keycloak_data:/opt/keycloak/data` volume so users and credentials survive restarts and recreates. Use the seed script instead of one-off REST commands:
```bash
ENVIRONMENT=prod bash scripts/seed-keycloak-platform-admin.sh
```
The script includes the required email, first name, last name, password reset, and realm role assignment.

### 7. `platform/global/dify/config` requires `model_api_base` and `model_api_key`
Two fields are required for Dify to provision LLM providers when creating Knowledge Bases:
- `model_api_base` — the LLM API base URL (e.g. `https://api.fuelix.ai`)
- `model_api_key` — the LLM API key Dify uses internally

These are **separate** from `platform/global/llm` (which powers the AI Agent Prompt page).
Both paths are visible and editable in the UI at `/rapidrag/secrets` after seeding.
See PRODUCTION_MIGRATION.md Step 10.1.

---

## n8n Webhook Reference

All source types (GitHub, GitLab, Google Drive) use a single unified webhook:

| Webhook path | Workflow | Sources |
|-------------|----------|---------|
| `POST /webhook/rag-sync-source` | Generic Source to Dify Sync | GitHub, GitLab, Google Drive |

Production URL (once nginx is up):
- `https://rapidrag.ai/n8n/webhook/rag-sync-source`

The workflow is imported and activated automatically by `infra/n8n/init-workflows.sh`
on every container start — no manual import needed.

---

## Dify Knowledge Base Flow

Knowledge bases are **not created manually in Dify**. The platform handles provisioning:

```
User creates Knowledge Source (platform UI)
    ↓
workflow-service calls Dify API → creates dataset
    ↓
Dify dataset ID + API key stored in Vault: secret/platform/global/dify/{kbId}
    ↓
User triggers sync
    ↓
api-gateway posts to n8n webhook (rag-sync-source)
    ↓
n8n detects sourceType (github/gitlab/googledrive) → fetches files
    ↓
n8n uploads to Dify → polls indexing → reports status back
```

**Required before any sync works:**
- Dify admin account exists (Step 9.1)
- Dify LLM provider configured (Step 9.2) — without embedding model, indexing fails
- n8n webhooks active (Steps 8.1–8.2)
