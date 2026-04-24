# OAuth2 Connect Integration

## Overview

The platform supports two credential methods for knowledge source integrations — **OAuth2 Connect** (recommended) and **Personal Access Token (PAT)** (fallback). Both methods store tokens in the same Vault paths, so the sync pipeline (n8n) never needs to know which method was used.

---

## Supported Providers

| Provider | OAuth App Type | Scopes | Refresh Token |
|----------|---------------|--------|---------------|
| GitHub | GitHub OAuth App | `repo` | No (tokens don't expire) |
| GitLab | GitLab OAuth Application | `read_repository read_api` | Yes (2h expiry — auto-refreshed) |
| Google Drive | Google OAuth2 (Cloud Console) | `drive.readonly` | Yes (auto-refreshed) |

---

## Public Callback URLs (register with each provider)

```
https://dev.eclassmanager.com/ap/oauth/callback/github
https://dev.eclassmanager.com/ap/oauth/callback/gitlab
https://dev.eclassmanager.com/ap/oauth/callback/google
```

---

## Full Routing Chain

```
Browser
  │  GET /gateway/oauth/connect/github?kbId=xxx  (via web proxy)
  ▼
api-gateway :4000
  │  Generates HMAC-signed state → stores in Redis (10 min TTL)
  │  302 → https://github.com/login/oauth/authorize?...
  ▼
GitHub / GitLab / Google (user approves)
  │  302 → https://dev.eclassmanager.com/ap/oauth/callback/github?code=xxx&state=xxx
  ▼
Cloudflare (DNS proxy)
  ▼
External Nginx /etc/nginx/sites-enabled/dev-eclassmanager
  │  location /ap/  →  proxy_pass https://localhost:4000/
  ▼
api-gateway :4000  GET /oauth/callback/github
  │  1. Verify HMAC signature of state
  │  2. Delete Redis key (single-use)
  │  3. Decode userId + kbId from state payload
  │  4. Exchange code → access_token (using client_secret from env)
  │  5. POST /internal/oauth-token/:kbId → workflow-service
  │  6. 302 → https://dev.eclassmanager.com/integrations?connected=true&provider=github
  ▼
workflow-service :4001  POST /internal/oauth-token/:kbId
  │  Writes token to Vault: platform/users/{userId}/sources/{kbId}
  │  Sets auth_method = "oauth"
  ▼
Vault KV2 (token stored)
```

---

## Vault Token Storage

Both OAuth and PAT tokens land in the same Vault path — n8n sync payload is unchanged.

```
Path: secret/data/platform/users/{userId}/sources/{kbId}

  github_token    → GitHub access token
  gitlab_token    → GitLab access token
  gitlab_refresh  → GitLab refresh token (OAuth only)
  gdrive_token    → Google Drive access token
  gdrive_refresh  → Google Drive refresh token
  token_expiry    → ISO timestamp (GitLab/Google OAuth only)
  auth_method     → "oauth" | "pat"
```

---

## Token Refresh (GitLab & Google)

Before every sync trigger in `workflow-service`, if `auth_method === "oauth"` and `token_expiry` is within 5 minutes:

1. Calls provider's token refresh endpoint with `refresh_token`
2. Updates Vault with fresh `access_token` and new `token_expiry`
3. If refresh fails and no valid token exists → sync job marked `failed` with message: `"OAuth access token expired. Please reconnect the integration."`

---

## Security Model

| Threat | Mitigation |
|--------|-----------|
| CSRF on callback | `state` is HMAC-SHA256 signed, Redis single-use, 10 min TTL |
| Code injection / replay | OAuth codes are provider-bound to `redirect_uri`; state is single-use |
| State tampering | HMAC-SHA256 with `PLATFORM_OAUTH_SECRET` — any bit flip → rejected |
| Client secret exposure | Stored only in api-gateway environment (`docker-compose.yml` → `.env`), never in browser |
| Token in DB | Tokens never touch the database — Vault only |
| Open redirect | Post-callback redirect is hardcoded in api-gateway (`OAUTH_POST_CONNECT_REDIRECT`) |

---

## Environment Variables

Set in `.env` (or via `docker-compose.yml` environment section for api-gateway):

```bash
# Required: random 32-byte hex secret
PLATFORM_OAUTH_SECRET=<openssl rand -hex 32>

# Public base URL for callbacks (must match redirect_uri registered with providers)
OAUTH_CALLBACK_BASE_URL=https://dev.eclassmanager.com/ap

# Where browser lands after successful OAuth
OAUTH_POST_CONNECT_REDIRECT=https://dev.eclassmanager.com/integrations

# GitHub OAuth App
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# GitLab OAuth Application
GITLAB_CLIENT_ID=
GITLAB_CLIENT_SECRET=

# Google OAuth2 Client
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
```

---

## API Routes (api-gateway)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/oauth/connect/:provider?kbId=xxx` | JWT required | Redirects browser to provider authorization page |
| GET | `/oauth/callback/:provider` | None (state-protected) | Receives code, exchanges token, stores in Vault |
| DELETE | `/oauth/token/:provider?kbId=xxx` | JWT required | Disconnects OAuth, reverts auth_method to "pat" |

### Internal Routes (workflow-service, called by api-gateway only)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/internal/oauth-token/:kbId` | `x-internal-secret` header | Stores OAuth tokens in Vault |
| DELETE | `/internal/oauth-token/:kbId` | `x-internal-secret` header | Removes OAuth tokens from Vault |

---

## Nginx Configuration

Block added to `/etc/nginx/sites-enabled/dev-eclassmanager`:

```nginx
location /ap/ {
    proxy_pass          https://localhost:4000/;
    proxy_set_header    Host               $host;
    proxy_set_header    X-Real-IP          $remote_addr;
    proxy_set_header    X-Forwarded-For    $proxy_add_x_forwarded_for;
    proxy_set_header    X-Forwarded-Proto  $scheme;
    proxy_ssl_verify    off;   # api-gateway uses internal Vault CA cert
}
```

The trailing slash on `proxy_pass` strips the `/ap/` prefix before forwarding to api-gateway.

---

## Registering OAuth Apps (One-Time Setup per Provider)

### GitHub
1. Go to github.com → Settings → Developer Settings → OAuth Apps → New OAuth App
2. **Authorization callback URL**: `https://dev.eclassmanager.com/ap/oauth/callback/github`
3. Copy Client ID and Client Secret → set `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in `.env`

### GitLab
1. Go to gitlab.com → User Settings → Applications → Add new application
2. **Redirect URI**: `https://dev.eclassmanager.com/ap/oauth/callback/gitlab`
3. **Scopes**: `read_repository`, `read_api`
4. Copy Application ID and Secret → set `GITLAB_CLIENT_ID` / `GITLAB_CLIENT_SECRET` in `.env`

### Google Drive
1. Go to console.cloud.google.com → APIs & Services → Credentials → Create OAuth 2.0 Client ID
2. **Application type**: Web application
3. **Authorized redirect URI**: `https://dev.eclassmanager.com/ap/oauth/callback/google`
4. Enable **Google Drive API** in the project
5. Copy Client ID and Client Secret → set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`

After updating `.env`, restart api-gateway: `docker compose up -d api-gateway`

---

## UI Behaviour

On the Integrations page (`/integrations`), each source row now shows a credential panel with two tabs:

**Connect OAuth tab** (shown first):
- If `authMethod === "oauth"`: shows ✅ connected badge + **Reconnect** + **Disconnect** buttons
- If not connected: shows **Connect [Provider]** button → triggers the OAuth flow
- If provider env vars not set: shows "OAuth not configured — contact admin"

**Token (PAT) tab** (fallback):
- Existing password input field — unchanged behaviour
- If OAuth is active: shows a notice that PAT is ignored until OAuth is disconnected

After successful OAuth connection, browser is redirected back to `/integrations?connected=true` and a success toast is shown.
