# Slack Bot Integration — Developer Notes

## Request Flow

Slack Phase 1 is bot-first and direct-to-workflow-service, not n8n:

```text
Slack DM or /kb
  → nginx /rapidrag/api/slack/events or /rapidrag/api/slack/events/<deploymentId>
  → api-gateway raw proxy
  → workflow-service signature verification
  → Dify
  → Slack reply
```

OAuth installs use the platform-owned RapidRAG Bot and the global `/rapidrag/api/slack/events` URL. The workflow-service resolves the active deployment by Slack `team_id` for the installed workspace.

Manual installs use a customer-owned Slack app, such as `eclass-bot`, and the deployment-specific `/rapidrag/api/slack/events/<deploymentId>` URL. The Slack branding is the customer's bot, but the backend remains RapidRAG.

Shared-channel support is postponed. Channel IDs may still exist in older rows, but Phase 1 does not require or resolve deployments by channel.

## OAuth Install

`GET /slack/oauth/connect?deploymentId=...` creates a signed state with deployment ID, owner ID, nonce, and expiry. The nonce is stored in Redis with a 10 minute TTL.

`GET /slack/oauth/callback` validates the signed state, consumes the Redis nonce once, exchanges the Slack code with `oauth.v2.access`, stores the bot token in Vault, copies the platform signing secret into the deployment Vault path, and updates `SlackDeployment` workspace/bot metadata.

The public callback URL is `/rapidrag/api/slack/oauth/callback`, which nginx rewrites to api-gateway `/slack/oauth/callback`. api-gateway proxies the request to workflow-service with `redirect: "manual"` so workflow-service can return a browser redirect back to `/rapidrag/chat-channels`.

Keep this redirect pass-through explicit:

```typescript
const response = await tlsFetch(tlsRuntime, url, { ...init, redirect: "manual" });
const location = response.headers.get("location");
reply.redirect(location, response.status);
```

Do not let api-gateway follow the workflow-service redirect internally. If it follows the redirect, the gateway may request a UI route from workflow-service and the browser can see a false 502/404 even though the Slack token was already stored successfully.

The RapidRAG Bot requires these scopes:

```text
chat:write
commands
im:history
```

These are `OAuth & Permissions` -> `Scopes` -> `Bot Token Scopes`. Do not use Slack `App-Level Tokens` for this flow.

## Own Company Bot Manual Setup

For a customer-owned bot:

1. The user creates a Slack app from `api.slack.com/apps`.
2. The user adds the required bot scopes under `OAuth & Permissions` -> `Bot Token Scopes`.
3. The user enables `App Home` -> `Messages Tab` and checks `Allow users to send Slash commands and messages from the messages tab`.
4. The user configures Event Subscriptions with the deployment webhook URL.
5. After Slack shows `Verified`, the user clicks `Add Bot User Event`, adds `message.im`, and clicks `Save Changes`.
6. The user creates the `/kb` slash command with the same URL, short description `Query RapidRAG knowledge bases`, and usage hint `[list | use <name> | all | status | help]`.
7. The user installs the Slack app.
8. The user copies the Bot User OAuth Token from `OAuth & Permissions`.
9. The user copies the Signing Secret from `Basic Information`.
10. RapidRAG validates the token with Slack `auth.test` and stores both secrets in Vault.

`/kb` is a RapidRAG platform command, not a per-bot custom command. Every bot should use the same command name and subcommands. If the command contract changes, update `handleSlackCommand()`, the shared usage hint, the Chat Channels wizard, and the Slack app setup docs together.

## Allowlist Onboarding

Allowlist access is enforced only by RapidRAG when Slack sends a DM or slash-command event. Adding a Slack user ID to `allowedSlackUserIds` does not notify Slack and does not invite the user to anything.

The Chat Channels UI therefore provides copyable user instructions for admins. The copied message tells the Slack user to find the bot, open a DM, run `/kb list`, optionally run `/kb use <name>`, and reply with their Slack member ID if authorization fails. For platform OAuth installs the bot name is `RapidRAG Bot`; for customer-owned manual installs the message uses the deployment name.

Future enhancements may add Slack user lookup or automated notification, but that would require additional Slack scopes and product approval.

## Secrets

Per-deployment secrets:

```text
platform/users/{ownerId}/slack/{deploymentId}/bot_token
platform/users/{ownerId}/slack/{deploymentId}/signing_secret
```

Platform OAuth app secrets:

```text
platform/global/slack/oauth/client_id
platform/global/slack/oauth/client_secret
platform/global/slack/oauth/signing_secret
```

## Signature Verification

The api-gateway captures and forwards the exact raw request body bytes. The workflow-service verifies Slack signatures with:

```text
v0:{X-Slack-Request-Timestamp}:{rawBody}
```

Requests older than 5 minutes or with invalid signatures are rejected before Dify work.

## Deduplication

Events API deliveries are deduped by Slack `event_id`:

```text
SET slack:event:{event_id} "1" NX EX 300
```

Slash commands are deduped by a SHA-256 hash of team, user, command, text, and Slack request timestamp. User text is not stored in Redis keys.

If Redis is unavailable, the service logs a warning and processes the request so Slack users still get a reply.

## Dify Flow

Slack user context is stored in `ChannelChatThread` using an external key of:

```text
{teamId}#{userId}
```

Each active KB has a `ChannelChatKbSession` carrying the Dify `conversation_id`.

The Slack message handler reuses:

- `sendToDify()`
- `formatMultiKnowledgeBaseAnswer()`
- `readVaultKv()` / `writeVaultKv()`

If all KB calls fail, Slack receives:

```text
Sorry, I couldn't reach the knowledge base right now. Please try again in a moment.
```

After repeated failures, the deployment is marked `error` for admin visibility.
