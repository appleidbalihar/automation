# RapidRAG — Production Migration Guide

**Dev → Production: `dev.eclassmanager.com/rapidrag/` → `theaitools.ca/rapidrag/`**

> The architecture is identical between dev and production. Only the domain name and SSL certificates change.

---

## URL Mapping

| Service | Dev | Production |
|---------|-----|------------|
| Landing page | `https://dev.eclassmanager.com/rapidrag/` | `https://theaitools.ca/rapidrag/` |
| Dashboard | `https://dev.eclassmanager.com/rapidrag/dashboard` | `https://theaitools.ca/rapidrag/dashboard` |
| API gateway | `https://dev.eclassmanager.com/rapidrag/ap/` | `https://theaitools.ca/rapidrag/ap/` |
| n8n editor | `https://dev.eclassmanager.com/n8n/` | `https://theaitools.ca/n8n/` |
| n8n webhooks | `https://dev.eclassmanager.com/n8n/webhook/<id>` | `https://theaitools.ca/n8n/webhook/<id>` |
| Dify | `https://dev.eclassmanager.com/dify/` | `https://theaitools.ca/dify/` (if deployed) |
| OAuth callbacks | `.../rapidrag/ap/oauth/callback/{github,gitlab,google}` | Same path, different domain |

---

## Pre-flight Checklist

Before starting, confirm:

- [ ] Production server has Docker + Docker Compose installed
- [ ] `theaitools.ca` DNS A record points to the production server's public IP
- [ ] Port 80 and 443 are open in the server firewall
- [ ] Port 3443 (inner Docker nginx) is **not** publicly exposed (firewall closed)
- [ ] Certbot is installed: `sudo yum install certbot python3-certbot-nginx` (RHEL/CentOS) or `sudo apt install certbot python3-certbot-nginx` (Ubuntu)
- [ ] The production server has at least 4 GB RAM (n8n + Dify + Keycloak are memory-heavy)
- [ ] You have the GitLab registry access token for pulling Docker images

---

## Step 1 — Clone the Repository

```bash
# On the production server
git clone https://gitlab.com/appleid.balihar-group/automation.git /opt/rapidrag
cd /opt/rapidrag
```

---

## Step 2 — Create Production `.env`

```bash
cp .env.production.example .env.production
```

Edit `.env.production` and fill in **every `CHANGE_ME_` value**:

```bash
nano .env.production
```

### Key values to set:

| Variable | Value |
|----------|-------|
| `POSTGRES_PASSWORD` | Strong random password |
| `KEYCLOAK_ADMIN_PASSWORD` | Strong random password |
| `KEYCLOAK_CLIENT_SECRET` | From Keycloak admin console |
| `PLATFORM_OAUTH_SECRET` | `openssl rand -hex 32` |
| `N8N_WEBHOOK_TOKEN` | `openssl rand -hex 32` |
| `SECURITY_DIAGNOSTICS_TOKEN` | `openssl rand -hex 32` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | From GitHub OAuth App |
| `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` | From GitLab Application |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From Google Cloud Console |
| `KEYCLOAK_URL` | `https://theaitools.ca:8443` |
| `PLATFORM_URL` | `https://theaitools.ca/rapidrag` |
| `OAUTH_CALLBACK_BASE_URL` | `https://theaitools.ca/rapidrag/ap` |
| `OAUTH_POST_CONNECT_REDIRECT` | `https://theaitools.ca/rapidrag/integrations` |
| `NEXT_PUBLIC_API_BASE_URL` | `https://theaitools.ca/rapidrag/gateway` |

---

## Step 3 — Configure OAuth Provider Callback URLs

Update each OAuth provider to use the production callback URLs:

### GitHub
- Go to: github.com → Settings → Developer Settings → OAuth Apps → Your App
- **Homepage URL**: `https://theaitools.ca/rapidrag`
- **Authorization callback URL**: `https://theaitools.ca/rapidrag/ap/oauth/callback/github`

### GitLab
- Go to: gitlab.com → User Settings → Applications → Your App
- **Redirect URI**: `https://theaitools.ca/rapidrag/ap/oauth/callback/gitlab`

### Google
- Go to: console.cloud.google.com → Credentials → Your OAuth 2.0 Client ID
- **Authorised redirect URI**: `https://theaitools.ca/rapidrag/ap/oauth/callback/google`

---

## Step 4 — Pull Docker Images

```bash
# Login to GitLab registry
docker login registry.gitlab.com -u <your-gitlab-username> -p <your-token>

# Pull all images
docker compose --env-file .env.production pull
```

---

## Step 5 — Start Docker Services

```bash
# Start infrastructure services first (Vault, Postgres, Redis, etc.)
docker compose --env-file .env.production up -d \
  vault postgres redis rabbitmq keycloak minio n8n dify-api dify-web

# Wait ~60 seconds for Vault to bootstrap, then start application services
sleep 60

docker compose --env-file .env.production up -d \
  api-gateway logging-service workflow-service web web-ingress

# Verify all containers are up
docker ps --format "table {{.Names}}\t{{.Status}}"
```

---

## Step 6 — Install SSL Certificate (Let's Encrypt)

```bash
# Issue certificate for theaitools.ca
sudo certbot certonly --standalone -d theaitools.ca

# Certificates will be at:
# /etc/letsencrypt/live/theaitools.ca/fullchain.pem
# /etc/letsencrypt/live/theaitools.ca/privkey.pem
```

---

## Step 7 — Install Outer Nginx Config

```bash
# Copy the production nginx config from the repo
sudo cp /opt/rapidrag/infra/nginx/rapidrag-production.conf \
        /etc/nginx/sites-available/theaitools-rapidrag

# Enable it
sudo ln -s /etc/nginx/sites-available/theaitools-rapidrag \
           /etc/nginx/sites-enabled/theaitools-rapidrag

# Test config
sudo nginx -t

# Reload nginx
sudo nginx -s reload
```

---

## Step 8 — Update n8n Webhook URLs

n8n workflow webhooks must be updated from the dev domain to production:

1. Open the n8n editor: `https://theaitools.ca/n8n/`
2. Go to each workflow that uses Webhook nodes
3. Update the webhook URL from:
   - `https://dev.eclassmanager.com/n8n/webhook/<id>`
   - → `https://theaitools.ca/n8n/webhook/<id>`
4. Save and re-activate each workflow

**n8n environment variable** — also update in `.env.production`:
```env
N8N_WEBHOOK_BASE_URL=https://theaitools.ca/n8n
```

---

## Step 9 — Smoke Tests

Run these tests to verify everything is working:

```bash
# 1. Landing page loads
curl -I https://theaitools.ca/rapidrag/
# Expected: HTTP/2 200

# 2. Dashboard redirects to login if not authenticated
curl -I https://theaitools.ca/rapidrag/dashboard
# Expected: HTTP/2 200 or 302

# 3. API gateway health check
curl -k https://theaitools.ca/rapidrag/ap/health
# Expected: {"status":"ok"} or similar

# 4. n8n is accessible
curl -I https://theaitools.ca/n8n/
# Expected: HTTP/2 200

# 5. Old /ap/ path redirects to /rapidrag/
curl -I https://theaitools.ca/ap/
# Expected: HTTP/3 301 Location: /rapidrag/
```

---

## Step 10 — Enable Auto-Renewal for SSL

```bash
# Test renewal (dry run)
sudo certbot renew --dry-run

# Add to crontab (runs twice daily)
echo "0 0,12 * * * root certbot renew --quiet && nginx -s reload" | \
  sudo tee /etc/cron.d/certbot-renewal
```

---

## Rollback Procedure

If the production deployment has issues:

```bash
# 1. Stop all services
docker compose --env-file .env.production down

# 2. Remove the nginx config
sudo rm /etc/nginx/sites-enabled/theaitools-rapidrag
sudo nginx -s reload

# 3. Diagnose: check logs
docker compose --env-file .env.production logs web
docker compose --env-file .env.production logs api-gateway
```

---

## Architecture Reference

```
Internet (Cloudflare → theaitools.ca)
    │
    ▼
Host Nginx (port 80/443) — /etc/nginx/sites-enabled/theaitools-rapidrag
    │
    ├── /rapidrag/      ──→  https://localhost:3443/rapidrag/  (inner Docker nginx)
    │                            │
    │                            └──→  http://web:3000  (Next.js container)
    │
    ├── /rapidrag/ap/   ──→  https://localhost:4000/  (api-gateway container)
    │
    ├── /n8n/           ──→  http://localhost:5679/  (n8n container)
    │
    └── / (other paths) ──→  other applications (no conflict)
```

---

## Key Differences Between Dev and Production

| Aspect | Dev | Production |
|--------|-----|------------|
| Domain | `dev.eclassmanager.com` | `theaitools.ca` |
| SSL | Cloudflare proxy + self-signed inner | Let's Encrypt public cert |
| `.env` file | `.env` | `.env.production` |
| Docker compose command | `docker compose up -d` | `docker compose --env-file .env.production up -d` |
| Nginx config | `/etc/nginx/sites-available/dev-eclassmanager` | `/etc/nginx/sites-available/theaitools-rapidrag` |
| n8n webhook base | `https://dev.eclassmanager.com/n8n` | `https://theaitools.ca/n8n` |
| OAuth callbacks | `.../rapidrag/ap/oauth/callback/...` | Same path, different domain |
| `PLATFORM_URL` | `https://dev.eclassmanager.com/rapidrag` | `https://theaitools.ca/rapidrag` |
