# Production Deployment — Task Tracker

**Target:** First production installation on `theaitools.ca`
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
| 10 | Create Keycloak `platform-admin` user via REST API | ✅ | Role: realm `admin` |
| 11 | n8n owner account created via REST (`/rest/owner/setup`) | ✅ | `admin@platform.local` |
| 12 | Import GitHub → Dify KB Sync workflow (CLI) | ✅ | 18-node template version |
| 13 | Import GitLab → Dify KB Sync workflow (CLI) | ✅ | 14-node template version |
| 14 | Publish workflows via `n8n publish:workflow` CLI | ✅ | Required in n8n 2.x |
| 15 | Activate workflows via REST API | ✅ | Both `active: true` |
| 16 | Restart n8n to register webhook listeners | ✅ | `/webhook/rag-sync-github` HTTP 200 |
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
| P9 | Generate `.env.runtime` to tmpfs | ⬜ | PROD_MIG Step 4.7 |
| P10 | Build images `--no-cache` | ⬜ | PROD_MIG Step 5 |
| P11 | Start full stack with `--env-file .env.runtime` | ⬜ | PROD_MIG Step 6 |
| P12 | Shred `.env.runtime` immediately after up | ⬜ | PROD_MIG Step 6 |
| P13 | Verify: `db-migrate` Exited(0), `dify-migrate` Exited(0) | ⬜ | PROD_MIG Step 6 |
| P14 | Create Keycloak `platform-admin` via REST API | ⬜ | PROD_MIG Step 7 |
| P15 | n8n: create owner account via REST API | ⬜ | PROD_MIG Step 8.1 |
| P16 | n8n: import GitHub + GitLab workflows via CLI | ⬜ | PROD_MIG Step 8.2 |
| P17 | n8n: publish workflows via CLI | ⬜ | PROD_MIG Step 8.3 |
| P18 | n8n: activate workflows via REST API | ⬜ | PROD_MIG Step 8.4 |
| P19 | n8n: restart to register webhooks, test `/webhook/rag-sync-github` | ⬜ | PROD_MIG Step 8.5 |
| P20 | Dify: create admin account via API (`POST /console/api/setup`) | ⬜ | PROD_MIG Step 9.1 |
| P21 | Dify: configure LLM provider (Settings → Model Providers) | ⬜ | PROD_MIG Step 9.2 |
| P22 | Seed Dify config to Vault (`platform/global/dify/config`) — `default_app_url`, `console_password`, `model_api_base`, `model_api_key`, `chat_model`, `embedding_model` | ⬜ | PROD_MIG Step 10.1 |
| P23 | Seed LLM config to Vault (`platform/global/llm`) — `api_key`, `model`, `base_url` (used by AI Agent Prompt page) | ⬜ | PROD_MIG Step 10.2 |
| P24 | Configure OAuth callback URLs (GitHub, GitLab, Google) | ⬜ | PROD_MIG Step 11 |
| P25 | Install Let's Encrypt cert for `theaitools.ca` | ⬜ | PROD_MIG Step 12 |
| P26 | Configure and reload outer nginx | ⬜ | PROD_MIG Step 13 |
| P27 | Run all smoke tests | ⬜ | PROD_MIG Step 14 |
| P28 | Enable certbot auto-renewal cron | ⬜ | PROD_MIG Step 15 |
| P29 | Generate service credentials document from Vault | ⬜ | `ENVIRONMENT=prod bash scripts/generate-credentials-doc.sh` → `/root/platform-credentials-prod.md` |

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

### 4. Delete `.env.runtime` BEFORE restarting any container
If a container is recreated (e.g., to fix minio) after `.env.runtime` is deleted, the new container starts without credentials. If this happens, regenerate runtime env:
```bash
ENVIRONMENT=prod OUTPUT_FILE=/run/platform-secrets/.env.runtime bash scripts/generate-runtime-env.sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production --env-file /run/platform-secrets/.env.runtime \
  up -d <service-name>
shred -u /run/platform-secrets/.env.runtime
```

### 5. Dify setup can be done via API (no browser required)
`POST http://<host>:5001/console/api/setup` creates the admin account directly. Use `GET /console/api/setup` first to confirm `{"step": "not_started"}`. See PRODUCTION_MIGRATION.md Step 9.1 for the full commands.

### 6. Keycloak user creation must include email, firstName, lastName
Keycloak 24+ enforces User Profile validation. A user created with only `username` will fail login with `"Account is not fully set up"` even with `requiredActions: []`. Always include `"email"`, `"firstName"`, `"lastName"` in the create payload. Fixed in PRODUCTION_MIGRATION.md Step 7.

### 7. `platform/global/dify/config` requires `model_api_base` and `model_api_key`
Two fields are required for Dify to provision LLM providers when creating Knowledge Bases:
- `model_api_base` — the LLM API base URL (e.g. `https://api.fuelix.ai`)
- `model_api_key` — the LLM API key Dify uses internally

These are **separate** from `platform/global/llm` (which powers the AI Agent Prompt page).
Both paths are visible and editable in the UI at `/rapidrag/secrets` after seeding.
See PRODUCTION_MIGRATION.md Step 10.1.

---

## n8n Webhook Reference

| Webhook path | Workflow | Trigger |
|-------------|----------|---------|
| `POST /webhook/rag-sync-github` | GitHub → Dify KB Sync | Called by api-gateway when a GitHub KB sync is triggered |
| `POST /webhook/rag-sync-gitlab` | GitLab → Dify KB Sync | Called by api-gateway when a GitLab KB sync is triggered |

Production URLs (once nginx is up):
- `https://theaitools.ca/n8n/webhook/rag-sync-github`
- `https://theaitools.ca/n8n/webhook/rag-sync-gitlab`

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
api-gateway posts to n8n webhook (rag-sync-github or rag-sync-gitlab)
    ↓
n8n fetches files → uploads to Dify → polls indexing → reports status back
```

**Required before any sync works:**
- Dify admin account exists (Step 9.1)
- Dify LLM provider configured (Step 9.2) — without embedding model, indexing fails
- n8n webhooks active (Steps 8.1–8.5)
