# OAuth2 Connect Integration

## Overview

Knowledge sources can be connected with OAuth or with a personal access token (PAT). OAuth is the preferred UI path for GitHub, GitLab, and Google Drive. Web URL sources do not require OAuth.

The current implementation stores OAuth app credentials and provider tokens in Vault. Database rows keep only non-secret source metadata.

## Supported Providers

| Source type | OAuth provider route | Provider scopes |
|-------------|----------------------|-----------------|
| `github` | `github` | `repo` |
| `gitlab` | `gitlab` | `read_repository`, `read_api` |
| `googledrive` | `google` | `drive.readonly` |

The UI source type is `googledrive`; the OAuth route provider is `google`.

## Current Callback URLs

The web modal builds callback URLs from:

- `NEXT_PUBLIC_PLATFORM_URL`, default `https://dev.eclassmanager.com/rapidrag`
- `NEXT_PUBLIC_OAUTH_CALLBACK_BASE_URL`, default `https://dev.eclassmanager.com/rapidrag/connect`

Default callback URLs shown in the UI:

```text
https://dev.eclassmanager.com/rapidrag/connect/oauth/callback/github
https://dev.eclassmanager.com/rapidrag/connect/oauth/callback/gitlab
https://dev.eclassmanager.com/rapidrag/connect/oauth/callback/google
```

The API gateway receives callbacks at:

```text
GET /oauth/callback/:provider
```

Production deployments should set `OAUTH_CALLBACK_BASE_URL`, `OAUTH_POST_CONNECT_REDIRECT`, `NEXT_PUBLIC_PLATFORM_URL`, and `NEXT_PUBLIC_OAUTH_CALLBACK_BASE_URL` consistently with the external reverse proxy path.

## Runtime Flow

```text
User opens Knowledge Connector
  |
  | Create & Connect with OAuth
  v
web creates /gateway/rag/integrations
  |
  | optional per-integration OAuth app credentials
  v
PATCH /gateway/rag/integrations/:id/oauth-app-credentials
  |
  v
GET /gateway/oauth/connect/:provider?kbId=<id>&json=1
  |
  | api-gateway signs state and returns provider authorize URL
  v
Browser redirects to GitHub/GitLab/Google
  |
  v
Provider redirects to /oauth/callback/:provider with code + state
  |
  v
api-gateway verifies state and exchanges code
  |
  v
workflow-service stores tokens in Vault via /internal/oauth-token/:kbId
  |
  v
Browser returns to OAUTH_POST_CONNECT_REDIRECT
```

`json=1` is used by the Next.js UI so it can receive `{ "url": "..." }` and assign `window.location.href`. Without `json=1`, the gateway can redirect directly.

## Secret Storage

Source tokens are stored under the owner/source path:

```text
secret/data/platform/users/{ownerId}/sources/{kbId}
```

Typical fields:

| Field | Purpose |
|-------|---------|
| `github_token` | GitHub access token or PAT |
| `gitlab_token` | GitLab access token or PAT |
| `gitlab_refresh` | GitLab OAuth refresh token |
| `gdrive_token` | Google Drive access token |
| `gdrive_refresh` | Google Drive refresh token |
| `token_expiry` | ISO expiry timestamp for expiring OAuth providers |
| `auth_method` | `oauth` or `pat` |

OAuth app client credentials can be saved per integration through:

```text
PATCH /rag/integrations/:id/oauth-app-credentials
```

Gateway-level env credentials (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, etc.) still exist as fallback/configuration, but the UI supports per-integration app registration.

## API Routes

### api-gateway

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| `GET` | `/oauth/connect/:provider?kbId=...` | `admin`, `useradmin`, `operator` | Build or return provider authorization URL |
| `GET` | `/oauth/callback/:provider` | state-protected | Exchange code and store token |
| `DELETE` | `/oauth/token/:provider?kbId=...` | `admin`, `useradmin`, `operator` | Disconnect OAuth |
| `PATCH` | `/rag/integrations/:id/oauth-app-credentials` | `admin`, `useradmin`, `operator` | Store OAuth app client credentials |

### workflow-service internal

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/internal/oauth-token/:kbId` | Store OAuth token fields in Vault |
| `DELETE` | `/internal/oauth-token/:kbId` | Remove OAuth token fields |
| `GET` | `/internal/oauth-credentials/:provider` | Return stored OAuth app credentials to the gateway |

## Security Properties

- OAuth state is HMAC-signed with `PLATFORM_OAUTH_SECRET`.
- Redis nonce storage is used when available for single-use state validation.
- Provider access tokens are stored only in Vault.
- Client secrets are never sent to the browser except as user-entered form values during setup.
- Post-connect redirect is controlled by `OAUTH_POST_CONNECT_REDIRECT`.

## UI Behavior

The Knowledge Connector page (`/knowledge-connector`, with `/integrations` kept as a compatibility route) supports:

- create with OAuth
- create with PAT
- reconnect OAuth
- disconnect OAuth
- update PAT
- store per-integration OAuth app credentials
- create unauthenticated web URL sources

After a successful callback, the browser is redirected with `?connected=true&provider=...`; the UI shows a success message and then removes the callback query parameters from the address bar.
