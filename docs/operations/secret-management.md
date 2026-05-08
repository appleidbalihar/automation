# Secret Management — Operations Guide

> **Single source of truth** for how credentials are stored, accessed, rotated, and audited on this platform. Bookmark this document.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Vault Secret Paths](#vault-secret-paths)
3. [First-Time Setup (Dev)](#first-time-setup-dev)
4. [First-Time Setup (Production)](#first-time-setup-production)
5. [How to View Configured Secrets](#how-to-view-configured-secrets)
6. [Daily Deploy Flow](#daily-deploy-flow)
7. [How to Update / Rotate a Secret](#how-to-update--rotate-a-secret)
8. [Rolling Back a Secret](#rolling-back-a-secret)
9. [Adding a New Secret](#adding-a-new-secret)
10. [Rotating TLS Certificates](#rotating-tls-certificates)
11. [If Vault Is Sealed](#if-vault-is-sealed)
12. [Security Rules](#security-rules)
13. [Production Hardening Checklist](#production-hardening-checklist)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                   HashiCorp Vault                    │
│  ┌──────────────────────┐  ┌──────────────────────┐ │
│  │  KV v2 (secrets)     │  │  PKI (certificates)  │ │
│  │  platform/dev/*      │  │  Root CA             │ │
│  │  platform/prod/*     │  │  Intermediate CA     │ │
│  └──────────────────────┘  │  Leaf certs (30 days)│ │
│                             └──────────────────────┘ │
└────────────────────┬────────────────────────────────┘
                     │ AppRole auth (per service)
        ┌────────────┴──────────────────────────┐
        │         deploy-dev / deploy-prod       │
        │         AppRole (read-only)            │
        └────────────┬──────────────────────────┘
                     │
              scripts/generate-runtime-env.sh
                     │ writes to tmpfs
                     ▼
              .env.runtime  (chmod 600, deleted after start)
                     │
              docker compose --env-file .env.runtime
                     │
        ┌────────────┴─────────────┐
        │  Container environment   │
        │  (in-memory only)        │
        └──────────────────────────┘
```

**Key principle:** Credentials never sit on disk. They live in Vault, are read into memory at deploy time, and are deleted from disk immediately after `docker compose up`.

---

## Vault Secret Paths

All secrets follow the pattern: `secret/data/platform/{env}/{category}/{service}/config`

### Dev paths (`platform/dev/`)

| Vault path | Fields stored | Used by |
|---|---|---|
| `platform/dev/infra/postgres/config` | `user`, `password`, `db` | postgres, all app services, dify-api, dify-worker |
| `platform/dev/infra/redis/config` | `password` | redis, api-gateway, workflow-service |
| `platform/dev/infra/rabbitmq/config` | `username`, `password` | rabbitmq, api-gateway, workflow-service, logging-service |
| `platform/dev/infra/opensearch/config` | `admin_password` | opensearch, workflow-service |
| `platform/dev/infra/minio/config` | `access_key`, `secret_key` | minio |
| `platform/dev/infra/keycloak/config` | `admin_password`, `client_secret`, `platform_oauth_secret` | keycloak, api-gateway, workflow-service, web |
| `platform/dev/app/dify/config` | `secret_key`, `db_password`, `redis_password` | dify-api, dify-worker, dify-db, dify-redis |
| `platform/dev/app/n8n/config` | `encryption_key`, `db_password`, `webhook_token` | n8n, n8n-db |

### Prod paths (`platform/prod/`)

Same structure — replace `dev` with `prod`.

### Per-user / per-KB paths (managed by workflow-service at runtime)

| Vault path pattern | Fields | Purpose |
|---|---|---|
| `platform/global/dify/{kb-id}` | `api_key` | Per-knowledge-base Dify API key |
| `platform/users/{username}/{integration}` | provider-specific | OAuth tokens per user |
| `platform/global/llm` | `api_key`, `model`, `base_url` | LLM credentials for AI prompt generation |

---

## First-Time Setup (Dev)

> Run once on a fresh checkout. Safe to re-run — creates new KV versions without affecting running containers.

### Step 1 — Start Vault

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  --env-file .env up -d vault vault-bootstrap
sleep 20
```

### Step 2 — Get the root token

```bash
VAULT_DATA_DIR=$(docker volume inspect "$(basename $(pwd))_vault_data" \
  --format '{{.Mountpoint}}')
VAULT_ROOT_TOKEN=$(sudo jq -r '.root_token' "${VAULT_DATA_DIR}/vault-init.json")
```

### Step 3 — Seed dev secrets

```bash
VAULT_ADDR=http://localhost:8200 \
VAULT_TOKEN="${VAULT_ROOT_TOKEN}" \
bash infra/vault/seed-secrets.dev.sh
```

### Step 4 — Verify

```bash
ENVIRONMENT=dev bash scripts/list-secrets.sh
# Expected: [OK] for all 8 paths
```

### Step 5 — Generate runtime env and start everything

```bash
ENVIRONMENT=dev bash scripts/generate-runtime-env.sh

docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  --env-file .env --env-file .env.runtime up -d

shred -u .env.runtime
```

---

## First-Time Setup (Production)

> Run once on the production server. See also [PRODUCTION_MIGRATION.md](../../PRODUCTION_MIGRATION.md) for full context.

### Step 1 — OS preparation (one-time)

```bash
# Create tmpfs mount for the ephemeral runtime env file
sudo mkdir -p /run/platform-secrets
sudo mount -t tmpfs -o size=4m,noexec,nosuid,nodev tmpfs /run/platform-secrets

# Persist across reboots
echo "tmpfs /run/platform-secrets tmpfs size=4m,noexec,nosuid,nodev 0 0" | sudo tee -a /etc/fstab

# Add Docker daemon security settings
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "data-root": "/home/docker-data",
  "no-new-privileges": true,
  "icc": false,
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
```

### Step 2 — Start Vault only

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production up -d vault vault-bootstrap
sleep 30
```

### Step 3 — Seed production secrets

```bash
VAULT_DATA_DIR=$(docker volume inspect "$(basename $(pwd))_vault_data" --format '{{.Mountpoint}}')
VAULT_ROOT_TOKEN=$(sudo jq -r '.root_token' "${VAULT_DATA_DIR}/vault-init.json")

VAULT_ADDR=http://localhost:8200 \
VAULT_TOKEN="${VAULT_ROOT_TOKEN}" \
bash infra/vault/seed-secrets.prod.sh
```

### Step 4 — Verify all secrets are present

```bash
ENVIRONMENT=prod bash scripts/list-secrets.sh
```

### Step 5 — Revoke root token immediately

```bash
docker exec -e VAULT_TOKEN="${VAULT_ROOT_TOKEN}" \
  $(docker ps -qf name=vault) \
  vault token revoke "${VAULT_ROOT_TOKEN}"

unset VAULT_ROOT_TOKEN
echo "Root token revoked."
```

### Step 6 — Generate runtime env and start everything

```bash
ENVIRONMENT=prod \
OUTPUT_FILE=/run/platform-secrets/.env.runtime \
bash scripts/generate-runtime-env.sh

docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production \
  --env-file /run/platform-secrets/.env.runtime \
  up -d

shred -u /run/platform-secrets/.env.runtime
```

### Step 7 — Create first Keycloak admin user

1. Open `https://theaitools.ca:8443` in a browser
2. Log in as `admin` using the password from Vault:
   ```bash
   ENVIRONMENT=prod SHOW_VALUES=true PATH_FILTER=infra/keycloak bash scripts/list-secrets.sh
   ```
3. Switch to realm **automation-platform** → Users → Add User
4. Username: `platform-admin`, assign realm role `admin`
5. Set a strong password in the Credentials tab (temporary: off)

---

## How to View Configured Secrets

### List all paths (no values shown — safe to run anywhere)

```bash
ENVIRONMENT=dev  bash scripts/list-secrets.sh
ENVIRONMENT=prod bash scripts/list-secrets.sh
```

**Output example:**
```
=== Vault Secrets Inventory (env: prod) ===
[OK] platform/prod/infra/postgres/config   — fields: user, password, db
[OK] platform/prod/infra/redis/config      — fields: password
[OK] platform/prod/infra/rabbitmq/config   — fields: username, password
[OK] platform/prod/infra/opensearch/config — fields: admin_password
[OK] platform/prod/infra/minio/config      — fields: access_key, secret_key
[OK] platform/prod/infra/keycloak/config   — fields: admin_password, client_secret, platform_oauth_secret
[OK] platform/prod/app/dify/config         — fields: secret_key, db_password, redis_password
[OK] platform/prod/app/n8n/config          — fields: encryption_key, db_password, webhook_token
```

### Show values for a specific path

```bash
# Show all fields for one path
ENVIRONMENT=prod \
SHOW_VALUES=true \
PATH_FILTER=infra/postgres \
bash scripts/list-secrets.sh

# Show Keycloak admin password specifically
ENVIRONMENT=prod \
SHOW_VALUES=true \
PATH_FILTER=infra/keycloak \
bash scripts/list-secrets.sh
```

### Read directly via Vault CLI (inside Vault container)

```bash
# Exec into the vault container
docker exec -it $(docker ps -qf name=vault) sh

# Read a path (requires VAULT_TOKEN)
VAULT_TOKEN=$(cat /vault/file/vault-init.json | jq -r .root_token)
vault kv get secret/platform/prod/infra/postgres/config
vault kv get -field=password secret/platform/prod/infra/postgres/config
```

---

## Daily Deploy Flow

Every time you restart or redeploy services, you need a fresh `.env.runtime`. The tokens are short-lived and the file is deleted after use.

### Dev

```bash
ENVIRONMENT=dev bash scripts/generate-runtime-env.sh

docker compose -f docker-compose.yml -f docker-compose.dev.yml \
  --env-file .env --env-file .env.runtime up -d

shred -u .env.runtime
```

### Production

```bash
ENVIRONMENT=prod \
OUTPUT_FILE=/run/platform-secrets/.env.runtime \
bash scripts/generate-runtime-env.sh

docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production \
  --env-file /run/platform-secrets/.env.runtime \
  up -d

shred -u /run/platform-secrets/.env.runtime
```

---

## How to Update / Rotate a Secret

Vault KV v2 retains the **last 10 versions** of every secret. Rotating creates a new version; old versions are kept for rollback.

### Rotate a single field

```bash
# Example: rotate the Postgres password in production
ENVIRONMENT=prod \
SECRET_PATH=infra/postgres/config \
SECRET_FIELD=password \
bash scripts/rotate-secret.sh
```

The script will:
1. Generate a new strong random value
2. Write it to Vault with `kv patch` (only updates that field, leaves others intact)
3. Print manual DB steps if the credential requires updating the database itself

### Rotate all fields in one path

```bash
ENVIRONMENT=prod \
SECRET_PATH=infra/keycloak/config \
bash scripts/rotate-secret.sh
```

### Rotate ALL secrets at once (full rotation)

```bash
ENVIRONMENT=prod ROTATE_ALL=true bash scripts/rotate-secret.sh
```

### After rotating — redeploy affected services

```bash
# Regenerate runtime env with new values
ENVIRONMENT=prod \
OUTPUT_FILE=/run/platform-secrets/.env.runtime \
bash scripts/generate-runtime-env.sh

# Restart only the affected service (example: postgres password change)
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.production \
  --env-file /run/platform-secrets/.env.runtime \
  up -d --force-recreate postgres api-gateway workflow-service logging-service

shred -u /run/platform-secrets/.env.runtime
```

### Services affected by each secret

| Secret path | Services to restart after rotation |
|---|---|
| `infra/postgres/config.password` | postgres (+ `ALTER USER`), api-gateway, workflow-service, logging-service, dify-api, dify-worker |
| `infra/redis/config.password` | redis (+ `CONFIG SET requirepass`), api-gateway, workflow-service |
| `infra/rabbitmq/config.password` | rabbitmq (+ `rabbitmqctl`), api-gateway, workflow-service, logging-service |
| `infra/opensearch/config.admin_password` | opensearch, workflow-service |
| `infra/minio/config` | minio |
| `infra/keycloak/config.admin_password` | keycloak |
| `infra/keycloak/config.client_secret` | api-gateway, workflow-service, web |
| `infra/keycloak/config.platform_oauth_secret` | api-gateway, workflow-service |
| `app/dify/config.db_password` | dify-db (`ALTER USER`), dify-api, dify-worker, dify-migrate |
| `app/dify/config.redis_password` | dify-redis, dify-api, dify-worker |
| `app/dify/config.secret_key` | dify-api, dify-worker |
| `app/n8n/config.db_password` | n8n-db (`ALTER USER`), n8n |
| `app/n8n/config.encryption_key` | n8n (WARNING: rotating this invalidates all stored n8n credentials) |
| `app/n8n/config.webhook_token` | n8n, api-gateway |

### Manual database password updates (required after rotating DB passwords)

When a database password is rotated in Vault, the database itself must also be updated because databases store their own credential copy:

```bash
# PostgreSQL (platform DB) — run inside postgres container
docker exec -it $(docker ps -qf name='^postgres$') \
  psql -U platform -c "ALTER USER platform WITH PASSWORD '<new-password-from-Vault>';"

# Dify DB — run inside dify-db container
docker exec -it $(docker ps -qf name=dify-db) \
  psql -U dify -c "ALTER USER dify WITH PASSWORD '<new-password-from-Vault>';"

# n8n DB — run inside n8n-db container
docker exec -it $(docker ps -qf name=n8n-db) \
  psql -U n8n -c "ALTER USER n8n WITH PASSWORD '<new-password-from-Vault>';"

# Redis — update running instance (no restart needed)
docker exec -it $(docker ps -qf name='^redis$') \
  redis-cli -a '<old-password>' CONFIG SET requirepass '<new-password-from-Vault>'
```

> Get the new password first: `ENVIRONMENT=prod SHOW_VALUES=true PATH_FILTER=infra/postgres bash scripts/list-secrets.sh`

---

## Rolling Back a Secret

If a rotation causes problems, roll back to the previous version:

```bash
# Check version history
docker exec -e VAULT_TOKEN=$(sudo jq -r .root_token \
  $(docker volume inspect "$(basename $(pwd))_vault_data" --format '{{.Mountpoint}}')/vault-init.json) \
  $(docker ps -qf name=vault) \
  vault kv metadata get secret/platform/prod/infra/postgres/config

# Roll back to version N
docker exec -e VAULT_TOKEN=... \
  $(docker ps -qf name=vault) \
  vault kv rollback -version=2 secret/platform/prod/infra/postgres/config
```

Then re-run `generate-runtime-env.sh` and restart services.

---

## Adding a New Secret

1. **Add the path to the seed scripts** (`infra/vault/seed-secrets.dev.sh` and `infra/vault/seed-secrets.prod.sh`):

   ```bash
   # Example: adding a Slack webhook token
   SLACK_WEBHOOK="$(openssl rand -hex 32)"   # replace with real value if known
   vault_write "app/slack/config" \
     "{\"webhook_url\": \"${SLACK_WEBHOOK}\"}"
   ```

2. **Add the path to `scripts/list-secrets.sh`** — add to the `PATHS=()` array:

   ```bash
   "app/slack/config"
   ```

3. **Add the field to `scripts/generate-runtime-env.sh`** — read and export the value:

   ```bash
   SLACK_WEBHOOK="$(vault_field "app/slack/config" "webhook_url")"
   ```

   And add to the output block:
   ```bash
   SLACK_WEBHOOK_URL=${SLACK_WEBHOOK}
   ```

4. **Add the env var to `docker-compose.yml`** in `x-shared-env` or the specific service:

   ```yaml
   SLACK_WEBHOOK_URL: ${SLACK_WEBHOOK_URL}
   ```

5. **Seed the value** for each environment:

   ```bash
   # Dev
   VAULT_TOKEN=<root-token> VAULT_ADDR=http://localhost:8200 \
     vault kv put secret/platform/dev/app/slack/config \
     webhook_url="https://hooks.slack.com/services/..."

   # Prod
   docker exec -e VAULT_TOKEN=<root-token> \
     $(docker ps -qf name=vault) \
     vault kv put secret/platform/prod/app/slack/config \
     webhook_url="https://hooks.slack.com/services/..."
   ```

---

## Rotating TLS Certificates

Certificates are issued automatically by Vault PKI Agent sidecars with a **30-day TTL**. They auto-renew before expiry. You rarely need to manually rotate them.

### Check certificate expiry

```bash
# Via the API gateway monitoring endpoint
curl -sk -H "Authorization: Bearer <token>" https://localhost:4000/security/tls | jq .

# Or check the cert file directly
docker exec -it $(docker ps -qf name=api-gateway-vault-agent) \
  openssl x509 -in /tls/cert.pem -noout -dates
```

### Force-renew a specific service certificate

```bash
# Trigger renewal via the API gateway admin endpoint
curl -sk -X POST \
  -H "Authorization: Bearer <admin-token>" \
  https://localhost:4000/admin/security/certificates/api-gateway/renew
```

### Force-renew all certificates (restart the Vault Agent sidecars)

```bash
docker compose restart \
  api-gateway-vault-agent \
  workflow-service-vault-agent \
  logging-service-vault-agent \
  postgres-vault-agent \
  redis-vault-agent \
  rabbitmq-vault-agent \
  keycloak-vault-agent \
  minio-vault-agent \
  web-vault-agent \
  web-ingress-vault-agent \
  dify-api-vault-agent \
  n8n-vault-agent
```

### Change the certificate TTL (default: 720h / 30 days)

```bash
# In .env (dev) or .env.production (prod):
TLS_CERT_TTL=720h    # 30 days  (recommended minimum for production)
PKI_LEAF_TTL=720h
```

---

## If Vault Is Sealed

Vault seals itself on restart if the container was stopped. The `vault-bootstrap` container automatically unseals it using the stored unseal key.

### Manual unseal (if vault-bootstrap is not running)

```bash
VAULT_DATA_DIR=$(docker volume inspect "$(basename $(pwd))_vault_data" --format '{{.Mountpoint}}')
UNSEAL_KEY=$(sudo jq -r '.unseal_keys_b64[0]' "${VAULT_DATA_DIR}/vault-init.json")

docker exec $(docker ps -qf name=vault) \
  vault operator unseal "${UNSEAL_KEY}"
```

### Check seal status

```bash
docker exec $(docker ps -qf name=vault) vault status | grep Sealed
```

---

## Security Rules

1. **Never put passwords in `.env`, `.env.production`, or any committed file.** These files contain only URLs, feature flags, and non-secret configuration.

2. **Never print secrets in scripts or logs.** The seed scripts do not echo generated values. Use `list-secrets.sh` with `SHOW_VALUES=true` if you need to see a value.

3. **Delete `.env.runtime` immediately after `docker compose up`.** The deploy scripts use `shred -u` which overwrites before deleting.

4. **Revoke the Vault root token after seeding.** The root token is needed only for initial seeding. All runtime operations use short-lived AppRole tokens.

5. **Never commit `vault-init.json`.** It contains the unseal key and root token. It is in `.gitignore` as part of the `vault_data` Docker volume.

6. **Rotate secrets after a team member leaves.** Use `ENVIRONMENT=prod ROTATE_ALL=true bash scripts/rotate-secret.sh`.

7. **The Vault port (8200) is never exposed in production.** It is exposed in `docker-compose.dev.yml` only, for local seed scripts.

8. **Audit log is always on.** Every Vault read/write is recorded to `/vault/file/audit.log` inside the vault container (persisted in `vault_data` volume).

---

## Production Hardening Checklist

Run through this before going live:

- [ ] `ENVIRONMENT=prod bash scripts/list-secrets.sh` — all 8 paths `[OK]`
- [ ] Root token revoked (`vault token revoke <token>`)
- [ ] Port 8200 is NOT open in the host firewall (`sudo firewall-cmd --list-ports | grep 8200` should return nothing)
- [ ] Ports 5432, 6379, 5671, 9200 are NOT open in the host firewall
- [ ] Only ports 80, 443, 8443 are publicly accessible
- [ ] `/run/platform-secrets/.env.runtime` does NOT exist (should be deleted by deploy script)
- [ ] `docker inspect <service> | grep -i env` shows no plaintext passwords in any running container
- [ ] `grep -rE "(guest:guest|platformredis|DevAdmin123|minioadmin|admin123)" docker-compose.yml` returns nothing
- [ ] All containers are using `docker-compose.prod.yml` (check via `docker inspect <container> | grep -i labels`)
- [ ] Vault audit log is active: `docker exec $(docker ps -qf name=vault) vault audit list`
- [ ] Certificate TTL is 720h (30 days): check `TLS_CERT_TTL=720h` in `.env.production`
- [ ] Docker daemon has `"no-new-privileges": true` in `/etc/docker/daemon.json`
- [ ] nginx security headers are set in `infra/nginx/web-https.conf` (Strict-Transport-Security, X-Frame-Options, X-Content-Type-Options)
