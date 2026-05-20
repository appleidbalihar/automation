# Slack Bot Integration — Developer Notes

## Request Flow

Slack is bot-first and direct-to-workflow-service, not n8n:

```text
Slack DM or /kb slash command
  → nginx /api/slack/events/<deploymentId>
  → api-gateway raw proxy
  → workflow-service: signing secret verification (Redis-cached)
  → routing decision (open access vs verified)
  → Dify chat API (async, after 200 reply)
  → Slack reply via response_url (slash commands) or chat.postMessage (DMs)
```

All bots use the Advanced (manual) form. There is no hardcoded platform RapidRAG Bot OAuth flow — platform admins create bots via the same wizard as everyone else and share them with all users via `shareScope = "all"`.

---

## Deployment Model

Each `SlackDeployment` row has:

| Field | Purpose |
|-------|---------|
| `shareScope` | `"private"` / `"all"` / `"specific"` — who can see this bot in My Slack Connections |
| `sharedWithUserIds` | rapidrag userIds when `shareScope = "specific"` |
| `requireUserVerification` | `true` = per-user KB isolation; `false` = open access |
| `defaultKbIds` | KBs served to all Slack users in open-access mode |

---

## Message Routing

When a Slack webhook event arrives:

1. Fetch signing secret from Redis (2-hour cache) or Vault on first hit.
2. Signature verification: `HMAC-SHA256("v0:{timestamp}:{rawBody}", signing_secret)` — requests older than 5 minutes are rejected.
3. Deduplication via Redis: events by `event_id`, slash commands by `sha256(team+user+command+text+ts)`.
4. Deployment lookup by `deploymentId` path param (manual) or `team_id` (OAuth-style).
5. **Slash commands**: send `200 { response_type: "ephemeral", text: "Working on it..." }` immediately, then process asynchronously.
6. **Open access** (`requireUserVerification = false`): serve `deployment.defaultKbIds` to any Slack user.
7. **Verified** (`requireUserVerification = true`): look up `SlackUserKbMapping` where `deploymentId = deployment.id AND slackUserId = userId AND status = "connected"`. If not found, reply "not connected". If found, use `userMapping.kbIds`.
8. Pass resolved KB IDs to `handleSlackMessage()`, which bypasses deployment-level `kbMappings`.

Access control is 100% internal — Slack delivers all messages regardless of user. RapidRAG routes based on the `user_id` in every Slack event.

---

## Data Models

### SlackDeployment

```prisma
model SlackDeployment {
  id                      String   @id
  deploymentName          String
  installMode             String   // "manual" | "oauth"
  ownerId                 String
  status                  String   // "pending" | "active" | "disabled" | "error"
  shareScope              String   @default("private")   // "private" | "all" | "specific"
  sharedWithUserIds       String[] @default([])
  requireUserVerification Boolean  @default(true)
  defaultKbIds            String[] @default([])          // open-access mode KBs
  slackWorkspaceId        String?
  slackWorkspaceName      String?
  slackBotUserId          String?
  kbMappings              SlackDeploymentKb[]
}
```

### SlackUserKbMapping

Per-user Slack ID → KB mapping for verified-mode deployments:

```prisma
model SlackUserKbMapping {
  id               String   @id @default(cuid())
  deploymentId     String
  deployment       SlackDeployment @relation(fields: [deploymentId], references: [id])
  rapidragUserId   String?
  rapidragUsername String?
  slackUserId      String          // real Slack U_XXXXXXX — or "rapidrag:{ownerId}" placeholder
  kbIds            String[]
  status           String   @default("connected")  // "connected" | "pending"
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt

  @@unique([deploymentId, slackUserId])
}
```

**Synthetic placeholder**: on activation in verified mode, the activate endpoint creates a `SlackUserKbMapping` with `slackUserId = "rapidrag:{ownerId}"` and `status = "pending"`. This marks the owner as needing to link their real Slack ID. The Members panel detects entries where `slackUserId.startsWith("rapidrag:")` and shows "Not linked" (amber badge) instead of displaying the synthetic ID. When the owner completes Slack identity OAuth, the callback upserts their real Slack user ID and deletes the synthetic placeholder.

---

## API Endpoints (workflow-service)

### Deployment management

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/slack/deployments` | any role | List owned deployments |
| `POST` | `/slack/deployments` | any role | Create deployment |
| `PUT` | `/slack/deployments/:id` | owner | Update settings; clears Redis token cache |
| `DELETE` | `/slack/deployments/:id` | owner | Delete deployment; clears Redis token cache |
| `POST` | `/slack/deployments/:id/activate` | owner | Activate with credentials; clears Redis token cache |
| `POST` | `/slack/deployments/:id/deactivate` | owner | Deactivate; clears Redis token cache |

### Member management

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/slack/deployments/shared` | any role | List deployments shared with user |
| `GET` | `/slack/deployments/member-of` | any role | List deployments where user has a real (non-synthetic) SlackUserKbMapping |
| `GET` | `/slack/deployments/my-connections` | any role | List user's own SlackUserKbMapping entries (excludes synthetic `rapidrag:` entries) |
| `GET` | `/slack/deployments/:id/members` | owner | List all SlackUserKbMapping rows for a deployment |
| `POST` | `/slack/deployments/:id/members` | owner | Manually add a member |
| `DELETE` | `/slack/deployments/:id/members/:slackUserId` | owner | Remove a member |
| `POST` | `/slack/deployments/:id/members/self` | any role | Self-register Slack ID + KBs |

### OAuth helpers

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| `GET` | `/slack/deployments/:id/members/self/oauth` | any role | Get Slack identity OAuth URL (`user_scope=openid,profile`) for linking Slack ID |
| `GET` | `/slack/deployments/:id/install-url` | any role | Get Slack bot install OAuth URL for adding the app to a workspace |
| `GET` | `/slack/oauth/connect` | owner | Start bot install OAuth (deprecated in favour of install-url) |
| `GET` | `/slack/oauth/callback` | public | OAuth callback — handles both `purpose: "install"` and `purpose: "identity"` |
| `POST` | `/slack/validate-token` | any role | Validate a bot token against Slack auth.test |

All endpoints above are proxied through api-gateway.

---

## Activate Endpoint

`POST /slack/deployments/:id/activate` accepts:

```ts
{
  botToken: string;         // required
  signingSecret: string;    // required
  clientId: string;         // required — enables install-url and identity OAuth
  clientSecret: string;     // required — enables install-url and identity OAuth
  knowledgeBaseIds: string[];        // owner's KBs (verified mode)
  defaultKbIds?: string[];           // KBs for open-access mode
  requireUserVerification?: boolean; // default: true
  shareScope?: "private" | "all" | "specific";
  sharedWithUserIds?: string[];
}
```

`clientId` and `clientSecret` are required in the activation form. Without them, users cannot install the bot to their Slack workspace and the identity OAuth flow is unavailable.

In verified mode, activate auto-creates a `SlackUserKbMapping` entry for the owner with `slackUserId = "rapidrag:{ownerId}"` (synthetic placeholder, status `"pending"`). This disappears from the Members panel "Not linked" state once the owner completes Slack identity OAuth.

---

## Slack Identity OAuth Flow

When a user wants to link their Slack identity to a bot:

1. Frontend calls `GET /slack/deployments/:id/members/self/oauth?kbIds=id1,id2`.
2. Workflow-service reads `client_id` + `client_secret` from Vault.
3. Builds Slack OAuth URL with `user_scope=openid,profile` (no bot `scope`).
4. Signs state: `{ purpose: "identity", deploymentId, rapidragUserId, kbIds, nonce, redirectUri, exp }`.
5. Stores nonce in Redis (`slack:oauth:identity:{nonce}` EX 600).
6. Returns `{ oauthAvailable: true, url }`.
7. Frontend redirects: `window.location.href = url`.
8. Slack identity OAuth completes → callback at `/slack/oauth/callback`.
9. Callback peeks state `purpose`, loads per-deployment secrets, verifies signature.
10. Extracts `authed_user.id` from Slack response.
11. Upserts `SlackUserKbMapping` with real Slack user ID + status `"connected"`.
12. Deletes synthetic `rapidrag:{ownerId}` placeholder if present.
13. Redirects to `/chat-channels?slack_identity=true`.
14. Frontend shows green success banner, reloads data.

---

## Bot Install OAuth Flow

When a user needs to install the bot app to their Slack workspace:

1. Frontend calls `GET /slack/deployments/:id/install-url`.
2. Workflow-service reads `client_id` from Vault.
3. Builds Slack OAuth URL with `scope=chat:write,im:history,users:read,commands`.
4. Returns `{ installAvailable: true, url, botUserId }`.
5. Frontend opens URL in new tab or redirects.

---

## OAuth Callback — Peek-and-Branch Pattern

The single `/slack/oauth/callback` handler supports multiple purposes. It decodes the state JWT **without verifying** first to read `purpose`, then loads the correct secrets and verifies:

```ts
// Peek without verifying
const [encoded] = state.split(".");
const peeked = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
const purpose = peeked.purpose; // "identity" | "install" | undefined

if (purpose === "identity") {
  // Load per-deployment secrets, verify state, upsert SlackUserKbMapping
} else if (purpose === "install") {
  // Load per-deployment secrets, verify state, store bot_token in Vault
} else {
  // Legacy global-secret flow
}
```

---

## Secrets and Caching

### Vault paths (per-deployment)

```text
platform/users/{ownerId}/slack/{deploymentId}/bot_token
platform/users/{ownerId}/slack/{deploymentId}/signing_secret
platform/users/{ownerId}/slack/{deploymentId}/client_id
platform/users/{ownerId}/slack/{deploymentId}/client_secret
```

### Redis cache

| Key | TTL | Purpose |
|-----|-----|---------|
| `slack:signing_secret:{deploymentId}` | 2 hours | Avoids Vault hit on every inbound message |
| `slack:bot_token:{deploymentId}` | 1 hour | Avoids Vault hit on every DM reply |

**Cache invalidation**: `clearSlackDeploymentCache(deploymentId)` deletes both keys and is called on every `activate`, `PUT`, `deactivate`, and `DELETE` operation. Secrets in Vault are always the source of truth; Redis is a performance layer only.

### When each secret is used

| Secret | Used for | Frequency |
|--------|----------|-----------|
| `signing_secret` | Verify HMAC-SHA256 signature of every inbound Slack request | Every message |
| `bot_token` | `chat.postMessage` API calls for DM replies | Only for DMs (slash commands use `response_url`) |
| `client_id` / `client_secret` | Build Slack OAuth URLs for bot install and identity linking | On demand |

---

## Slash Command Timeout Fix

Slack requires a response within 3 seconds for slash commands. The handler:

1. Fetches deployment + signing secret **in parallel** (parallel Promise.all).
2. Signing secret is read from Redis cache (2-hour TTL) — Vault only on cache miss.
3. Sends `200 { response_type: "ephemeral", text: "Working on it..." }` immediately after signature verification.
4. Runs RAG query + posts answer asynchronously via `response_url`.

---

## Dify App 404 Auto-Recovery

If a Dify app is deleted (stale `app_id` in Vault), the sync `configureDifyApp` call returns 404. The recovery logic:

1. Catches the `:404:` error from `configureDifyApp`.
2. Makes a GET request to `/apps/{appId}` to confirm the app is truly gone.
3. If confirmed missing → creates a new Dify app, retries `configureDifyApp`, continues sync.
4. If app exists (transient Dify outage) → re-throws the error; does **not** recreate.
5. On network error during the confirmation check → assumes app exists (fail-safe), re-throws.

---

## Deduplication

- Events: `SET slack:event:{event_id} "1" NX EX 300`
- Slash commands: `SET slack:command:{sha256(team+user+command+text+ts)} "1" NX EX 300`

If Redis is unavailable, the service processes the request without dedup so users still get a reply.

---

## Dify Thread Continuity

`ChannelChatThread` uses external key `{teamId}#{userId}` for per-user conversation continuity. Each active KB has a `ChannelChatKbSession` with a Dify `conversation_id`. The message handler passes `userKbIds` to scope which KBs are queried. After repeated Dify failures the deployment is marked `error` for admin visibility.

---

## Bot Setup Checklist (Developer Summary)

1. Create Slack app at `api.slack.com/apps`.
2. Add **Bot Token Scopes**: `chat:write`, `commands`, `im:history`.
3. Add **User Token Scopes**: `openid`, `profile` (enables Slack identity OAuth for users).
4. Enable **App Home → Messages Tab** + allow slash commands from messages tab.
5. Add **Redirect URL**: `https://<domain>/api/slack/oauth/callback`.
6. Enable **Event Subscriptions** → set Request URL to `https://<domain>/api/slack/events/<deploymentId>`.
7. Subscribe to bot event: `message.im`.
8. Configure slash command `/kb` with the same Request URL.
9. Install app to workspace.
10. Copy Bot User OAuth Token, Signing Secret, Client ID, Client Secret.
11. Activate via RapidRAG Chat Channels UI.
