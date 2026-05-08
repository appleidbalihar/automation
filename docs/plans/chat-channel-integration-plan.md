# Chat Channel Integration Plan — Phase 1: Slack

## Context

Users currently interact with RAG Knowledge Bases via the web UI chat. This phase introduces a dedicated **"Chat Channels"** section of the platform — a multi-channel hub where admins connect KBs to external messaging platforms. **Slack is the first channel**; Telegram and Google Chat will follow using the same DB/API skeleton.

Admins connect a Slack bot to one or more KBs in ≤2 minutes. Slack users then query KBs via natural language + slash commands directly in their channel, with the same RAG intelligence as the web UI.

---

## Architecture Decisions

### No n8n for real-time Slack events
n8n is optimised for long-running batch sync workflows. Slack requires responses in ≤3 seconds for slash commands. Slack events (messages + `/kb` commands) are handled **directly by the workflow-service** via a public webhook endpoint. The platform verifies Slack's signing secret, runs the Dify query, and posts back via Slack API — using Slack's `response_url` async pattern for slash commands where processing may exceed 3s.

### Slack uses a new direct deployment model
The existing `RagChannelDeployment` model remains the legacy n8n-oriented channel stub and is **not used for Slack Phase 1**. Slack Phase 1 introduces `SlackDeployment` because real-time Slack delivery needs a workspace/channel-specific bot token, signing secret, access mode, and multi-KB mapping. Future channel work can either generalize `SlackDeployment` into a shared direct-channel deployment model or retire the older n8n stub.

### OAuth-first Slack install, manual fallback
Slack setup should be **OAuth-first**: admins click "Add to Slack", Slack returns the workspace bot token via `oauth.v2.access`, and the platform stores it in Vault. This removes bot-token copy/paste from the normal path and keeps setup close to the ≤2 minute goal.

Manual setup remains as an **Advanced: use your own Slack app** fallback for enterprise admins who cannot install the platform-owned Slack app. In that fallback, the admin supplies Bot Token + Signing Secret exactly as described below.

Important distinction: Slack OAuth returns the bot token and workspace metadata, but it does **not** return the app Signing Secret used to verify incoming Slack requests. Therefore:
- OAuth-first path uses a platform-owned Slack app and reads `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_SIGNING_SECRET` from Vault/env.
- Manual fallback stores the customer-provided `signingSecret` per deployment in Vault.

Because a platform-owned Slack app has one fixed Event Subscriptions URL and one fixed Slash Command URL, OAuth installs use a **global** public webhook (`/api/slack/events`) and resolve the deployment from Slack `team_id` + `channel_id`. Manual customer-owned apps keep the deployment-specific webhook (`/api/slack/events/<deploymentId>`) because each customer app can be configured with its own URL.

### Generic chat history model (origin + externalThreadKey)
Rather than Slack-specific conversation tables, we introduce **channel-agnostic history tables** that all future integrations (Telegram, Google Chat, etc.) reuse:
- `origin` — identifies the channel type (`"slack"`, `"telegram"`, `"google_chat"`, `"web"`)
- `externalThreadKey` — deployment-scoped channel-native thread ID (Slack `teamId#channelId#userId`, Telegram `chatId`, etc.)
- `channelDeploymentId` — links to the deployment (Slack today, generic future)

Clearing history from the web UI deletes the `ChannelChatThread` record (cascade deletes messages + KB sessions), which also resets the Dify conversation context for that user.

### Access control — two modes per deployment
Admins choose one of two modes when activating a deployment:
- **`channel`** — any Slack channel member can use the bot; Slack's own channel membership is the gate
- **`allowlist`** — platform maintains an explicit list of Slack User IDs; only those users receive responses

For both modes, the platform still validates that incoming Slack requests match the activated deployment's workspace and channel before doing any Dify work.

---

## Phase Overview

| Phase | Scope |
|-------|-------|
| 1 | DB schema: 5 new models (generic channel history + Slack deployment) |
| 2 | Backend: workflow-service routes + Slack event handler |
| 3 | API Gateway: proxy routes + public event webhook + nginx routing |
| 4 | Contracts: new shared types |
| 5 | Frontend: "Chat Channels" page + ConnectSlack wizard + Slack App setup guide |

---

## Phase 1 — DB Schema (`packages/db/prisma/schema.prisma`)

### 1a. Generic channel history models

Add **after** `RagDiscussionMessage`:

```prisma
// Generic chat history shared across all channel types (Slack, Telegram, Google Chat, Web)
model ChannelChatThread {
  id                  String   @id @default(cuid())
  origin              String   // "slack" | "telegram" | "google_chat" | "web"
  externalThreadKey   String   // deployment-scoped: "T123#C456#U789" (slack), "chat_id" (telegram), etc.
  channelDeploymentId String?  // FK to SlackDeployment.id (nullable for web origin)
  externalUserId      String?  // slack user ID, telegram user ID, etc.
  activeKbIds         String[] @default([])  // current KB selection for this user/thread
  lastMessageAt       DateTime
  expiresAt           DateTime?              // null = no expiry (web origin uses its own expiry)
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  messages            ChannelChatMessage[]
  kbSessions          ChannelChatKbSession[]

  @@unique([origin, channelDeploymentId, externalThreadKey])
  @@index([channelDeploymentId])
  @@index([origin, lastMessageAt])
  @@index([expiresAt])
}

model ChannelChatMessage {
  id        String             @id @default(cuid())
  threadId  String
  thread    ChannelChatThread  @relation(fields: [threadId], references: [id], onDelete: Cascade)
  role      String             // "user" | "assistant"
  content   String
  kbResults Json?              // same shape as RagDiscussionMessage.kbResults
  createdAt DateTime           @default(now())

  @@index([threadId, createdAt])
}

model ChannelChatKbSession {
  id                 String            @id @default(cuid())
  threadId           String
  thread             ChannelChatThread @relation(fields: [threadId], references: [id], onDelete: Cascade)
  knowledgeBaseId    String
  knowledgeBaseName  String            // intentionally frozen snapshot — preserves audit context if KB is later renamed
  difyConversationId String?           // Dify conversation ID for context continuity

  @@unique([threadId, knowledgeBaseId])
  @@index([threadId])
}
```

Slack must always create `ChannelChatThread.channelDeploymentId` with a non-null `SlackDeployment.id`. If a future `web` origin reuses these tables, add a concrete web deployment/sentinel ID or a separate uniqueness rule because PostgreSQL unique indexes do not treat nullable columns as equal.

### 1b. Slack deployment models

Add **after** `RagChannelDeployment`:

Also update the existing `RagChannelDeployment` comment to state that it is the legacy n8n-oriented channel stub and is not used for real-time Slack Phase 1. This avoids future confusion between the old single-KB n8n deployment model and the new direct Slack deployment model.

```prisma
model SlackDeployment {
  id                  String   @id @default(cuid())
  ownerId             String
  deploymentName      String                        // user label: "Eng Support Bot"
  installMode         String   @default("oauth")    // "oauth" | "manual"
  slackWorkspaceId    String?                       // populated after token validation
  slackWorkspaceName  String?
  slackBotUserId      String?                       // populated after OAuth install/auth.test
  slackChannelId      String?                       // populated after channel setup
  slackChannelName    String?                       // "#engineering-help"
  status              String   @default("pending")  // pending|active|error|disabled
  accessMode          String   @default("channel")  // "channel" | "allowlist"
  allowedSlackUserIds String[] @default([])
  errorMessage        String?
  createdAt           DateTime @default(now())
  updatedAt           DateTime @updatedAt

  kbMappings          SlackDeploymentKb[]

  @@index([ownerId])
  @@index([slackWorkspaceId])
  @@index([status])
}

model SlackDeploymentKb {
  id              String           @id @default(cuid())
  deploymentId    String
  deployment      SlackDeployment  @relation(fields: [deploymentId], references: [id], onDelete: Cascade)
  knowledgeBaseId String
  knowledgeBase   RagKnowledgeBase @relation(fields: [knowledgeBaseId], references: [id], onDelete: Cascade)

  @@unique([deploymentId, knowledgeBaseId])
  @@index([deploymentId])
  @@index([knowledgeBaseId])
}
```

### 1c. Existing model updates

Add to **`RagKnowledgeBase`**:
```prisma
slackMappings  SlackDeploymentKb[]
```

Run:
```
npx prisma migrate dev --name chat_channel_integration
npx prisma generate
```

---

## Phase 2 — Workflow-Service (`apps/workflow-service/src/main.ts`)

### Dependency

```
pnpm add @slack/web-api ioredis --filter workflow-service
```

Use `WebClient` from `@slack/web-api` for all Slack API calls (`auth.test`, `conversations.list`, `conversations.create`, `chat.postMessage`).
Use `ioredis` in workflow-service for Slack webhook deduplication with the existing `REDIS_URL`.

### 2a. Vault Path Helper

```typescript
function slackDeploymentSecretPath(ownerId: string, deploymentId: string): string {
  return `platform/users/${ownerId}/slack/${deploymentId}`;
}
// Keys: bot_token, signing_secret
```

### 2b. Slack Deployment CRUD

Add after the existing `/rag/channels` stub (lines ~3895):

```
GET    /slack/deployments               — list (with kbMappings), filtered by ownerId
POST   /slack/deployments               — create record (name + installMode=oauth|manual, status=pending)
GET    /slack/deployments/:id           — single with kbMappings
PUT    /slack/deployments/:id           — update name, kbIds, accessMode, allowedSlackUserIds
DELETE /slack/deployments/:id           — delete (cascade kbMappings; also clears ChannelChatThread records for this deployment)
```

### 2c. Slack OAuth Install Actions

OAuth install is the primary day-one path. It uses one platform-owned Slack app configured once by operations. Required platform secrets:

```
platform/global/slack/oauth/client_id
platform/global/slack/oauth/client_secret
platform/global/slack/oauth/signing_secret
```

Environment fallback names are allowed for local development only:
`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`.

Routes:

```
GET /slack/oauth/connect?deploymentId=xxx
  → authenticated admin/useradmin route
  → verify deployment belongs to requester and installMode="oauth"
  → create signed state { deploymentId, ownerId, nonce, exp }
  → store nonce in Redis: SET slack:oauth:state:<nonce> "1" NX EX 600
  → return { url } for https://slack.com/oauth/v2/authorize
  → scopes: chat:write,commands,channels:read,app_mentions:read (+channels:manage if create-channel is enabled)

GET /slack/oauth/callback?code=xxx&state=yyy
  → public callback from Slack
  → verify signed state + single-use Redis nonce
  → call Slack oauth.v2.access with client_id/client_secret/code/redirect_uri
  → store returned bot token in Vault at slackDeploymentSecretPath(ownerId, deploymentId)
  → copy platform signing secret into same deployment Vault path as signing_secret
  → update SlackDeployment: installMode=oauth, slackWorkspaceId/team.id, slackWorkspaceName/team.name, slackBotUserId/bot_user_id, status=pending
  → redirect to Chat Channels page with slack_connected=true&deploymentId=...
```

Slack OAuth response handling:
- Store `access_token` as `bot_token`.
- Store `team.id`, `team.name`, and `bot_user_id` on `SlackDeployment`.
- Do not store OAuth codes or raw OAuth response bodies in logs.
- If the Slack app is reinstalled for an existing deployment, overwrite the bot token and workspace metadata after verifying state ownership.

### 2d. Slack-Specific Actions

```
POST /slack/validate-token
  body: { botToken }
  → call Slack auth.test API
  → return { workspaceId, workspaceName, botUserId }

POST /slack/workspace-channels
  body for OAuth install: { deploymentId }
  body for manual install: { botToken }
  → OAuth install: read bot_token from Vault after verifying deployment owner
  → call Slack conversations.list
  → return [{ id, name }]

POST /slack/create-channel
  body for OAuth install: { deploymentId, channelName }
  body for manual install: { botToken, channelName }
  → OAuth install: read bot_token from Vault after verifying deployment owner
  → call Slack conversations.create
  → return { channelId, channelName }

POST /slack/deployments/:id/activate
  body for OAuth install: { slackChannelId, slackChannelName, knowledgeBaseIds, accessMode, allowedSlackUserIds? }
  body for manual install: { botToken, signingSecret, slackChannelId, slackChannelName, knowledgeBaseIds, accessMode, allowedSlackUserIds? }
  → OAuth install: require bot_token + signing_secret already present in Vault from OAuth callback
  → Manual install: validate token with auth.test, then write bot_token + signing_secret to Vault
  → OAuth install: reject activation if another active OAuth SlackDeployment already uses the same slackWorkspaceId + slackChannelId
  → upsert SlackDeploymentKb records for knowledgeBaseIds
  → update deployment: slackWorkspaceId, slackWorkspaceName, slackBotUserId, slackChannelId, slackChannelName, accessMode, allowedSlackUserIds, status=active
  → return absolute webhook URLs using forwarded host/proto when available:
     OAuth:  { webhookUrl: "https://<domain>/api/slack/events" }
     Manual: { webhookUrl: "https://<domain>/api/slack/events/:id" }

POST /slack/deployments/:id/deactivate
  → set status=disabled
```

Consistency checks:
- Activation must fail if required active fields would be missing: `slackWorkspaceId`, `slackWorkspaceName`, `slackBotUserId`, `slackChannelId`, `slackChannelName`, and at least one KB mapping.
- `GET /slack/deployments/:id` should surface an `error` status or consistency warning if `status="active"` but any required active field is null.

Token safety: bot tokens, signing secrets, OAuth client secrets, OAuth codes, and Slack `response_url` values must never appear in query strings, response payloads, logs, or browser history. Validation and manual channel creation routes accept tokens in request bodies only, and activation writes them to Vault immediately. At the API gateway level, disable request body logging for Slack token/OAuth routes to prevent secrets from appearing in gateway access logs.

### 2e. Chat History Endpoints

```
GET  /channels/history/:deploymentId?limit=50&cursor=<lastMessageAt_or_threadId>
  → return ChannelChatThread list for this deployment (summary, no messages)
  → order by lastMessageAt desc, cap limit at 100, return nextCursor for lazy loading

GET  /channels/history/:deploymentId/thread/:threadId
  → return single thread with messages + kbSessions

DELETE /channels/history/:deploymentId/thread/:threadId
  → delete ChannelChatThread (cascade: messages + kbSessions)
  → also resets Dify conversation context for that user

DELETE /channels/history/:deploymentId
  → delete ALL ChannelChatThread records for this deployment
```

### 2f. Public Slack Event Webhook

```
POST /slack/events                  — public OAuth/platform-app webhook, NO Keycloak auth
POST /slack/events/:deploymentId    — public manual/customer-app webhook, NO Keycloak auth
```

Slack sends two different payload formats to the same endpoint:
- **Events API JSON**: `type`, `team_id`, `event_id`, and nested `event`
- **Slash command form body**: `command`, `text`, `user_id`, `channel_id`, `team_id`, and `response_url`

Flow:
1. Choose signing secret source:
   - `/slack/events` OAuth path: read the platform Slack signing secret from `platform/global/slack/oauth/signing_secret`.
   - `/slack/events/:deploymentId` manual path: load `SlackDeployment` by `deploymentId`, then read that deployment's Vault `signing_secret`. Use `deployment.ownerId` — **not** `requesterUserId()` — as the `ownerId` segment; auth headers are absent on this route.
2. **Signature verification first**: HMAC-SHA256 over the exact raw request body with the selected `signing_secret`, `X-Slack-Signature`, and `X-Slack-Request-Timestamp`. Reject if invalid or if timestamp skew is older than 5 minutes.
3. **URL verification challenge**: after signature verification, if JSON body `type === "url_verification"` → return `{ challenge: body.challenge }`.
4. Resolve and validate deployment before any Dify work:
   - OAuth path: after parsing the verified body, find one active `SlackDeployment` with `installMode="oauth"`, matching `slackWorkspaceId=team_id`, and matching `slackChannelId=channel_id` or nested `event.channel`. If none, ignore with `200 OK`; if multiple, log a configuration error and ignore.
   - Manual path: use the deployment loaded from `deploymentId`.
   - `SlackDeployment.status === "active"`
   - incoming `team_id` matches `slackWorkspaceId`
   - incoming `channel_id` or nested `event.channel` matches `slackChannelId`
   - ignore bot messages, unsupported message subtypes, and events from other channels
5. Apply retry/idempotency protection:
   > **What this cache is for:** Slack retries the same webhook delivery (same `event_id`) if it doesn't receive `200 OK` within 3 seconds. Without dedup, a slow Dify response would cause Slack to retry → the bot queries Dify a second time and posts a duplicate reply. This cache only prevents that. **It does NOT cache Dify answers.** If a user sends the same question twice, each message has a unique `event_id` — both are processed normally and receive independent Dify responses.
   - detect `X-Slack-Retry-Num`
   - cache processed `event_id` for Events API requests — use the existing Redis instance (`REDIS_URL`) with atomic single-writer semantics: `SET slack:event:<event_id> "1" NX EX 300` (5-minute TTL); if Redis returns null, skip processing because another delivery already claimed it
   - cache a short-lived slash-command dedup key from `team_id`, `channel_id`, `user_id`, `command`, `text`, and Slack request timestamp — hash the composite value first so user text is not stored in the Redis key; use the same `SET ... NX EX 300` pattern
   - do **not** include `X-Slack-Retry-Num` in the dedup key, because retries must hit the same key. Expect Slack retries to preserve the request timestamp and payload.
   - if Redis is unavailable, log a warning and process the request without dedup rather than dropping Slack messages
   - do not call Dify or post duplicate Slack replies for already-processed requests
6. **Return `200 OK` immediately** for Events API callbacks after validation (Slack requires ack within 3s). For slash commands, return a quick acknowledgement or use `response_url` for async output.
7. **Async handler** (fire-and-forget, does NOT block the 200 response):
   a. Use the already-loaded `SlackDeployment` + `kbMappings`
   b. Access check based on `accessMode`:
      - `"channel"` → allow all (Slack channel membership is the gate)
      - `"allowlist"` → verify `event.user` is in `allowedSlackUserIds`; if not, post a polite "not authorised" reply
   c. Detect payload kind: slash command (`command === "/kb"`) → `handleSlackCommand()`, Events API `app_mention` → `handleSlackMessage()`
   d. For Slack Phase 1, do **not** answer every `message.channels` event. Subscribe to `message.channels` only if needed for future channel-message mode or operational visibility; otherwise the bot replies only to `/kb` and direct `@bot` mentions to avoid noisy channel-wide responses.

### 2g. Slash Command Handler (`handleSlackCommand`)

```
/kb list    → query DB for deployment kbMappings, reply with KB names
/kb use <n> → upsert ChannelChatThread.activeKbIds = [matched KB id]; reply confirmation
/kb all     → upsert ChannelChatThread.activeKbIds = all deployment KB ids; reply confirmation
/kb status  → reply: current active KB(s) for this user in this channel
/kb help    → reply: command reference card
```

Commands update `ChannelChatThread` (origin=slack) via upsert on `[origin, channelDeploymentId, externalThreadKey]`.
For Slack, compute `externalThreadKey` as `${teamId}#${channelId}#${userId}`. If Phase 2 adds Slack thread support, append `thread_ts` only after explicitly deciding whether each Slack thread should have separate Dify context.

### 2h. Message Handler (`handleSlackMessage`)

```typescript
async function handleSlackMessage(deployment, slackTeamId, slackUserId, slackChannelId, text, responseUrl) {
  const externalThreadKey = `${slackTeamId}#${slackChannelId}#${slackUserId}`;

  // 1. Upsert ChannelChatThread (origin="slack", externalThreadKey, channelDeploymentId)
  //    Default activeKbIds = all deployment KB ids if first message
  //    Update lastMessageAt + expiresAt (24h from now)

  // 2. Resolve active KBs from thread.activeKbIds

  // 3. For each active KB: call sendToDify() — reuse existing function
  //    Pass difyConversationId from ChannelChatKbSession if exists

  // 4. Persist ChannelChatMessage (role=user) + ChannelChatMessage (role=assistant, kbResults=[...])

  // 5. Upsert ChannelChatKbSession with new difyConversationId per KB

  // 6. Format with formatMultiKnowledgeBaseAnswer() — reuse existing function

  // 7. POST formatted response to Slack via response_url or chat.postMessage

  // Error handling: if sendToDify() throws or returns an empty answer for ALL active KBs,
  // post a user-facing error to Slack: "Sorry, I couldn't reach the knowledge base right now.
  // Please try again in a moment." Log the error internally; never expose stack traces or
  // Vault paths in the Slack reply.
  // If a deployment has 3 Dify failures within 5 minutes, set SlackDeployment.status="error"
  // and populate errorMessage so admins see the issue in Chat Channels.
}
```

**Reused functions** (already in `workflow-service/src/main.ts`):
- `sendToDify()` — Dify query, returns `{ answer, conversationId }`
- `formatMultiKnowledgeBaseAnswer()` — merges answers across KBs
- `readVaultKv()` / `writeVaultKv()` — Vault helpers

### 2i. Conversation Expiry

Add `pruneExpiredChannelChatThreads()` — mirrors `pruneExpiredRagDiscussions()`.
Criteria: `expiresAt IS NOT NULL AND expiresAt < now()`.
Run it from a lightweight background interval every 15 minutes. To avoid large delete spikes, delete in batches by first selecting up to 1000 expired thread IDs ordered by `expiresAt`, then deleting those IDs. Keeping a best-effort per-message prune call is acceptable only if it is throttled so high Slack traffic does not repeatedly scan expired rows.

---

## Phase 3 — API Gateway (`apps/api-gateway/src/main.ts`)

Add after the existing `/rag/channels` proxy block:

```typescript
// Slack deployments — admin/useradmin only
for (const [method, path] of [
  ["GET",    "/slack/deployments"],
  ["POST",   "/slack/deployments"],
  ["GET",    "/slack/deployments/:id"],
  ["PUT",    "/slack/deployments/:id"],
  ["DELETE", "/slack/deployments/:id"],
  ["GET",    "/slack/oauth/connect"],
  ["POST",   "/slack/deployments/:id/activate"],
  ["POST",   "/slack/deployments/:id/deactivate"],
  ["POST",   "/slack/validate-token"],
  ["POST",   "/slack/workspace-channels"],
  ["POST",   "/slack/create-channel"],
  ["GET",    "/channels/history/:deploymentId"],
  ["GET",    "/channels/history/:deploymentId/thread/:threadId"],
  ["DELETE", "/channels/history/:deploymentId/thread/:threadId"],
  ["DELETE", "/channels/history/:deploymentId"],
]) {
  app[method.toLowerCase()](path, { preHandler: requireAnyRole(["admin","useradmin"]) }, proxyToWorkflow);
}

// Public Slack OAuth callback — Slack redirects the installing admin here.
app.get("/slack/oauth/callback", async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/slack/oauth/callback");
});

// Public Slack platform-app webhook — OAuth installs use fixed Slack app URLs.
app.post("/slack/events", async (request, reply) => {
  // Must forward the exact raw body and Slack headers; do not JSON reserialize.
  await proxyRawSlackRequest(request, reply, config.workflowServiceUrl, "/slack/events");
});

// Public Slack deployment-specific webhook — manual customer-owned apps use this.
app.post("/slack/events/:deploymentId", async (request, reply) => {
  // Must forward the exact raw body and Slack headers; do not JSON reserialize.
  await proxyRawSlackRequest(request, reply, config.workflowServiceUrl,
    `/slack/events/${(request.params as any).deploymentId}`);
});
```

Public Slack webhook gateway requirements:
- Do not run Keycloak auth on `/slack/events` or `/slack/events/:deploymentId`.
- Preserve the exact raw request body bytes so workflow-service can verify Slack signatures.
- Forward `X-Slack-Signature`, `X-Slack-Request-Timestamp`, `X-Slack-Retry-Num`, `X-Slack-Retry-Reason`, and `Content-Type`.
- Support both `application/json` and `application/x-www-form-urlencoded`.
- Never log the raw request body because slash command payloads include `response_url`.
- Add explicit Fastify raw-body/content-type parser handling in both api-gateway and workflow-service. Default parsed JSON/form bodies are not sufficient for Slack signature verification because verification must use the exact original bytes.

Public Slack OAuth callback gateway requirements:
- Do not run Keycloak auth on `/slack/oauth/callback`; the signed OAuth state identifies the deployment owner.
- Preserve query parameters exactly when proxying to workflow-service.
- Do not log the `code` or `state` query values.

### nginx routing (`infra/nginx/web-https.conf`)

Add a location block so Slack's outbound requests can reach the API gateway. Without this the public webhook is unreachable:

```nginx
# Public Slack OAuth callback — no auth, query passthrough
location = /api/slack/oauth/callback {
    proxy_pass              https://api-gateway:4000;
    proxy_ssl_verify        off; # internal service certs are handled by platform mTLS runtime
    proxy_set_header        Host              $host;
    proxy_set_header        X-Real-IP         $remote_addr;
    proxy_set_header        X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header        X-Forwarded-Proto $scheme;
}

# Public Slack platform-app webhook — OAuth installs use this fixed URL
location = /api/slack/events {
    proxy_pass              https://api-gateway:4000;
    proxy_ssl_verify        off; # internal service certs are handled by platform mTLS runtime
    proxy_set_header        Host              $host;
    proxy_set_header        X-Real-IP         $remote_addr;
    proxy_set_header        X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header        X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    # optional flood protection once validated in staging:
    # limit_req zone=slack_webhook burst=10 nodelay;
}

# Public Slack deployment-specific webhook — manual installs use this URL
location ~ ^/api/slack/events/ {
    proxy_pass              https://api-gateway:4000;
    proxy_ssl_verify        off; # internal service certs are handled by platform mTLS runtime
    proxy_set_header        Host              $host;
    proxy_set_header        X-Real-IP         $remote_addr;
    proxy_set_header        X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header        X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    # optional flood protection once validated in staging:
    # limit_req zone=slack_webhook burst=10 nodelay;
}
```

If nginx rate limiting is enabled, define the shared `limit_req_zone` at the `http` level and start conservatively in staging. Rate limits must still allow Slack retries and normal `/kb` bursts; do not enable them blindly in the first production rollout.

---

## Phase 4 — Contracts (`packages/contracts/src/index.ts`)

Append:

```typescript
// ── Chat Channel (generic, all channel types) ──────────────────────────
export type ChannelOrigin = "slack" | "telegram" | "google_chat" | "web";

export interface ChannelChatThreadSummary {
  id: string;
  origin: ChannelOrigin;
  externalThreadKey: string;
  externalUserId?: string;
  activeKbIds: string[];
  lastMessageAt: string;
  expiresAt?: string;
  messageCount?: number;
}

export interface ChannelChatHistoryResponse {
  threads: ChannelChatThreadSummary[];
  nextCursor?: string;
}

export interface ChannelChatMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  kbResults?: RagDiscussionKbResult[];   // reuse existing type
  createdAt: string;
}

// ── Slack Deployment ────────────────────────────────────────────────────
export type SlackDeploymentStatus = "pending" | "active" | "error" | "disabled";
export type SlackAccessMode = "channel" | "allowlist";

export interface SlackDeploymentKbSummary {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
}

export interface SlackDeployment {
  id: string;
  deploymentName: string;
  installMode: "oauth" | "manual";
  slackWorkspaceId?: string;
  slackWorkspaceName?: string;
  slackBotUserId?: string;
  slackChannelId?: string;
  slackChannelName?: string;
  status: SlackDeploymentStatus;
  accessMode: SlackAccessMode;
  allowedSlackUserIds: string[];
  kbMappings: SlackDeploymentKbSummary[];
  webhookUrl?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackDeploymentActivateRequest {
  botToken?: string;        // required only for manual installMode
  signingSecret?: string;   // required only for manual installMode
  slackChannelId: string;
  slackChannelName: string;
  knowledgeBaseIds: string[];
  accessMode: SlackAccessMode;
  allowedSlackUserIds?: string[];
}

export interface SlackOAuthConnectResponse {
  url: string;
}

export interface SlackTokenValidateResponse {
  workspaceId: string;
  workspaceName: string;
  botUserId: string;
}

export interface SlackWorkspaceChannelsRequest {
  deploymentId?: string; // OAuth install path
  botToken?: string;     // manual install path
}

export interface SlackCreateChannelRequest {
  deploymentId?: string; // OAuth install path
  botToken?: string;     // manual install path
  channelName: string;
}

export interface SlackWorkspaceChannelSummary {
  id: string;
  name: string;
}
```

---

## Phase 5 — Frontend

### 5a. Page naming rationale

The page is named **"Chat Channels"** — not "Slack Channels" — because it will house all future messaging integrations (Telegram, Google Chat, etc.) under one roof. Each channel type gets its own tab or card group within the page.

### 5b. Navigation (`apps/web/src/app/navigation-sidebar.tsx`)

Add to admin/useradmin block (after "AI Agent Prompt"):
```typescript
{ href: "/chat-channels", label: "Chat Channels" }
```

### 5c. New Page

**File:** `apps/web/src/app/(platform)/chat-channels/page.tsx`
Thin wrapper rendering `<ChatChannelsPage />` (same pattern as integrations page).

### 5d. New Component Directory: `apps/web/src/app/chat-channels/`

**`types.ts`** — local UI state types, imports from contracts.

**`ChatChannelsPage.tsx`** — top-level page:
- Header: "Chat Channels" with sub-title "Connect your knowledge bases to Slack and other messaging platforms"
- Channel type tabs or filter: `All | Slack | Telegram (coming soon) | Google Chat (coming soon)`
- "Connect Slack" button → opens `ConnectSlackWizard`
- Renders `SlackDeploymentCard` per deployment

**`SlackDeploymentCard.tsx`** — card per deployment:
- Shows: deployment name, workspace name, `#channel-name`, status badge, KB count badge
- "History" link → opens `ChatHistoryDrawer`
- Actions: Edit, Activate/Deactivate, Delete

**`ConnectSlackWizard.tsx`** — 5-step modal (follows `ops-modal-overlay` + `ops-modal-panel` pattern):

| Step | Content |
|------|---------|
| 1 — Install Slack App | Primary button: "Add to Slack" → create pending deployment with `installMode="oauth"` if needed → `GET /api/slack/oauth/connect?deploymentId=...` → redirect to Slack. Also show collapsed "Advanced: use your own Slack app" for manual mode. |
| 2 — Connected Workspace | OAuth return shows workspace name + bot user. Manual fallback shows Bot Token + Signing Secret fields → `POST /api/slack/validate-token` → workspace name ✓ |
| 3 — Pick Channel | OAuth path reads bot token from Vault via deployment; manual path uses pasted token until activation. Dropdown from `POST /api/slack/workspace-channels` + "Create new channel" option → `POST /api/slack/create-channel`. The "Create new channel" option requires `channels:manage` scope — if the token lacks it, show the option greyed-out with tooltip: "Requires `channels:manage` scope — reinstall your Slack app with that scope to enable this." |
| 4 — Map KBs | Multi-select checkbox list from `GET /api/rag/knowledge-bases` |
| 5 — Access & Activate | Radio: "Channel membership (all members)" / "Allowlist (specific Slack User IDs)". If Allowlist: textarea one ID per line. "Activate" → `POST /api/slack/deployments/:id/activate`. OAuth activation does not send bot token/signing secret; manual activation does. On success: show webhook URL + copy button + post-activation setup instructions (see §5f). |

**`ManageSlackDeploymentModal.tsx`** — edit post-activation:
- Re-map KBs
- Change access mode / update allowlist
- Allowlist helper text: "Find a Slack user ID from the user's profile → More → Copy member ID." Do not add a channel-member picker in Phase 1 because that requires extra Slack scopes such as `users:read`.
- Copy webhook URL

**`ChatHistoryDrawer.tsx`** — slide-in panel per deployment:
- Lists paginated `ChannelChatThreadSummary` records (per-user conversations)
- Shows: external user ID, KB(s) active, last message time, message count
- Lazy-loads older threads with `nextCursor` as the user scrolls
- "Clear" button per thread → `DELETE /api/channels/history/:deploymentId/thread/:threadId` → confirm dialog → removes thread + resets Dify context for that user
- "Clear All" → `DELETE /api/channels/history/:deploymentId`

**`api.ts`** — typed fetch wrappers:
```typescript
fetchSlackDeployments()
createSlackDeployment()
startSlackOAuthConnect()
activateSlackDeployment()
validateSlackToken()
fetchSlackWorkspaceChannels()
createSlackChannel()
updateSlackDeployment()
deleteSlackDeployment()
fetchChannelHistory()
clearChannelThread()
clearAllChannelHistory()
```

### 5e. Wizard Step 1 — Required Bot Token Scopes

Display this scope table in Step 1 of the wizard. OAuth path requests these scopes automatically from the platform-owned Slack app. Manual fallback shows them as setup instructions for the customer's own Slack app:

| Scope | Purpose |
|-------|---------|
| `chat:write` | Post messages to channels |
| `commands` | Receive `/kb` slash commands |
| `channels:read` | List channels for wizard picker |
| `channels:history` | Optional for future all-channel-message mode; not required for Phase 1 if responding only to `/kb` and `app_mention` |
| `channels:manage` | Create new channels from wizard _(optional — wizard degrades gracefully without it)_ |
| `app_mentions:read` | Respond to @mentions |

### 5f. Wizard Step 5 — Post-Activation Setup Instructions

Display after successful activation (alongside webhook URL + copy button):

For OAuth installs, the Event Subscriptions and Slash Command URLs are configured once on the platform-owned Slack app. The user only needs to invite the bot to the target channel:

**Platform-owned Slack app URLs configured once by operations:**
```
Event Subscriptions Request URL: https://<your-platform-domain>/api/slack/events
Slash Command /kb Request URL: https://<your-platform-domain>/api/slack/events
```

```
/invite @<bot-name>
```

For manual installs using a customer-owned Slack app, show these setup instructions:

**Event Subscriptions → Request URL:**
```
https://<your-platform-domain>/api/slack/events/<deploymentId>
```
Subscribe to: `app_mention`

Optional future mode: add `message.channels` only if the product intentionally enables replying to normal channel messages without an explicit `/kb` command or `@bot` mention.

**Slash Commands → New Command:**
- Command: `/kb`
- Request URL: same URL as above
- Short description: "Query knowledge bases"
- Usage hint: `[list | use <name> | all | status | help]`

Then: `/invite @<bot-name>` in the target Slack channel.

---

## Critical File Paths

| File | Change |
|------|--------|
| `packages/db/prisma/schema.prisma` | +5 new models (`ChannelChatThread`, `ChannelChatMessage`, `ChannelChatKbSession`, `SlackDeployment`, `SlackDeploymentKb`), +relation on `RagKnowledgeBase` |
| `apps/workflow-service/package.json` | `+@slack/web-api`, `+ioredis` dependencies |
| `apps/workflow-service/src/main.ts` | +~500 lines: Slack routes, OAuth install/callback, event handler, command/message handlers, history endpoints |
| `apps/api-gateway/src/main.ts` | +~50 lines: proxy routes, public OAuth callback, public event webhook |
| `infra/nginx/web-https.conf` | +public Slack webhook location block |
| `packages/contracts/src/index.ts` | +~60 lines: channel + Slack types |
| `apps/web/src/app/navigation-sidebar.tsx` | +1 nav item |
| `apps/web/src/app/(platform)/chat-channels/page.tsx` | NEW |
| `apps/web/src/app/chat-channels/ChatChannelsPage.tsx` | NEW |
| `apps/web/src/app/chat-channels/SlackDeploymentCard.tsx` | NEW |
| `apps/web/src/app/chat-channels/ConnectSlackWizard.tsx` | NEW |
| `apps/web/src/app/chat-channels/ManageSlackDeploymentModal.tsx` | NEW |
| `apps/web/src/app/chat-channels/ChatHistoryDrawer.tsx` | NEW |
| `apps/web/src/app/chat-channels/api.ts` | NEW |
| `apps/web/src/app/chat-channels/types.ts` | NEW |
| `docker-compose.yml` | no changes needed (Redis, Vault, Dify all already wired) |

---

## Key Reused Patterns (Do Not Rewrite)

| Pattern | Source location |
|---------|----------------|
| `sendToDify()` | `workflow-service/src/main.ts` |
| `formatMultiKnowledgeBaseAnswer()` | `workflow-service/src/main.ts` |
| `readVaultKv()` / `writeVaultKv()` | `workflow-service/src/main.ts` |
| `pruneExpiredRagDiscussions()` | `workflow-service/src/main.ts` (mirror for channels) |
| `requesterUserId()` | `workflow-service/src/main.ts` — **do not call on the public webhook**; use `deployment.ownerId` instead |
| `RagDiscussionKbResult` type | `packages/contracts/src/index.ts` (reuse for `kbResults` JSON) |
| `ops-modal-overlay` / `ops-modal-panel` CSS | `apps/web/src/app/globals.css` |
| `requireAnyRole()` middleware | `api-gateway/src/main.ts` |
| `proxy()` helper | `api-gateway/src/main.ts` for authenticated JSON routes only |
| `proxyRawSlackRequest()` | new helper in `api-gateway/src/main.ts` for the public Slack webhook |
| OAuth state helpers | mirror `api-gateway/src/main.ts` state signing/Redis nonce pattern, but use Slack-specific state payload and keys |

---

## Vault Secret Layout

```
platform/users/{ownerId}/slack/{deploymentId}/bot_token
platform/users/{ownerId}/slack/{deploymentId}/signing_secret
```
OAuth-first installs read shared Slack app credentials from:
```
platform/global/slack/oauth/client_id
platform/global/slack/oauth/client_secret
platform/global/slack/oauth/signing_secret
```
Future channels follow the same pattern:
```
platform/users/{ownerId}/telegram/{deploymentId}/bot_token
platform/users/{ownerId}/google_chat/{deploymentId}/service_account
```

---

## End-to-End Verification

1. `npx prisma migrate dev` — 5 new tables created ✓
2. Platform → Chat Channels → "Connect Slack" wizard
3. OAuth path: click "Add to Slack" → Slack authorization page opens with expected scopes ✓
4. OAuth callback: Slack returns `code` + `state` → platform stores bot token in Vault and shows workspace name ✓
5. Manual fallback: paste valid Bot Token + Signing Secret → workspace name appears ✓
6. Step 3: pick a channel from dropdown ✓
7. Optional create-channel path works only when `channels:manage` is granted; otherwise the UI disables it clearly ✓
8. Step 4: select 2 KBs ✓
9. Step 5: choose "Channel membership" → Activate → webhook URL shown ✓
10. OAuth install activation sends no bot token/signing secret in request body ✓
11. Manual install activation writes pasted bot token/signing secret to Vault and does not log either value ✓
12. OAuth `state` replay attempt → rejected, no token stored ✓
13. OAuth callback with wrong/expired state → rejected, no token stored ✓
14. OAuth token exchange failure → deployment remains pending/error with user-facing retry message ✓
15. OAuth path: user only needs `/invite @bot-name` in the target Slack channel ✓
16. Manual path: user configures Event Subscriptions + Slash Command URL, then invites bot ✓
17. OAuth platform app uses fixed `/api/slack/events` URL and resolves deployment by Slack workspace/channel ✓
18. Manual app uses `/api/slack/events/<deploymentId>` URL and resolves deployment from path ✓
19. Paste webhook URL into Slack App Event Subscriptions → Slack sends challenge → platform returns `{challenge}` ✓
20. Configure `/kb` slash command in Slack App ✓
21. `/invite @bot-name` in Slack channel ✓
22. Send a message → bot replies with merged Dify answer ✓
23. `/kb list` → KB names listed ✓
24. `/kb use <name>` → confirmation + subsequent messages use that KB ✓
25. `/kb all` → merged response from all KBs ✓
26. Platform UI: Chat Channels page shows deployment as "active" ✓
27. History drawer: shows conversation for user, with message count ✓
28. Clear one thread → Dify context reset → next message starts fresh ✓
29. Switch deployment to "Allowlist" mode → add one user ID → message from other user → no response ✓
30. Invalid Slack signature → 403, no Dify call ✓
31. Old Slack timestamp (>5 minutes skew) → 403, no Dify call ✓
32. Valid signature but wrong Slack workspace or channel → ignored, no Dify call ✓
33. Slack retry with same `event_id` or slash-command key → no duplicate Dify call or duplicate reply ✓
34. Bot message or unsupported Slack subtype → ignored ✓
35. Bot token never appears in URLs, browser history, or application logs ✓
36. Restart workflow-service mid-conversation → Slack retry with same `event_id` → Redis cache prevents duplicate Dify call ✓
37. POST to `/slack/events/:deploymentId` with missing `X-Slack-Signature` or timestamp → 403 before Vault read; invalid signature → Vault signing-secret read allowed, but no Dify call attempted ✓
38. Dify outage simulation → bot posts user-facing error message to Slack; no internal stack trace or Vault path exposed ✓
39. Three Dify failures within 5 minutes → deployment status becomes `error` with admin-visible `errorMessage` ✓
40. Invalid manual bot token during activation → activation fails and deployment remains pending/error, with no token stored ✓
41. Redis unavailable during Slack delivery → request still processes, warning is logged, and duplicate protection is temporarily disabled ✓
42. History drawer loads first page only, then fetches older threads with `nextCursor` ✓
43. Active deployment consistency check catches missing workspace/channel/bot fields before returning a healthy active card ✓
44. `botToken`, Slack OAuth `code`, and Slack OAuth `state` are absent from nginx access log and API gateway request log ✓
