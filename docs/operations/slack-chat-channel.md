# Slack Bot Integration — Operations Runbook

## Overview

Slack integration is bot-first. Users talk to RapidRAG through Slack DMs or `/kb` slash commands. A Slack channel is not required.

Every Slack deployment is created through the **Chat Channels** wizard using the Advanced (manual) form. The wizard supports two access models:

| Model | How it works |
|-------|-------------|
| **Verified (per-user isolation)** | Each Slack user links their Slack identity via OAuth. Each user's Slack ID maps to their own set of KBs. Unknown Slack users receive a "not connected" message. |
| **Open access** | Any Slack user who messages the bot gets answers from the bot's default KBs. No registration required. |

---

## Chat Channels Page — Two Sections

The Chat Channels page (`/chat-channels`) is divided into two sections:

### Section 1 — My Bots
Bots you own. Full CRUD: Create, Edit, Members panel, Deactivate, Delete.

- Click **+ Create a bot** to launch the creation wizard.
- The Members button appears for verified-mode deployments (owner only).
- Edit opens the same wizard in edit mode — active bots show a simplified settings-only form (no credential re-entry required).

### Section 2 — My Slack Connections
All bots you can access — both owned bots and bots shared with you.

| Column | Description |
|--------|-------------|
| Bot | Name and workspace |
| Access Mode | Verified 🔒 or Open 🌐 |
| Your Slack ID | Your linked Slack user ID, or amber "Not linked" if not yet connected |
| Your KBs | Count of KBs linked to your Slack identity |
| Actions | Connect (not linked) or Update (already linked) |

Clicking **Connect** or **Update** opens the Connect wizard for that bot.

---

## Public Slack URLs

Register these in your Slack app settings.

Development:
```text
Event Subscriptions URL:  https://dev.rapidrag.ai/api/slack/events/<deploymentId>
Slash Command /kb URL:    https://dev.rapidrag.ai/api/slack/events/<deploymentId>
OAuth Redirect URL:       https://dev.rapidrag.ai/api/slack/oauth/callback
```

Production:
```text
Event Subscriptions URL:  https://rapidrag.ai/api/slack/events/<deploymentId>
Slash Command /kb URL:    https://rapidrag.ai/api/slack/events/<deploymentId>
OAuth Redirect URL:       https://rapidrag.ai/api/slack/oauth/callback
```

The webhook URL (`/api/slack/events/<deploymentId>`) is shown in the wizard at **Step 6 — Register Event Subscriptions** with a copy button. The OAuth Redirect URL is shown at **Step 7** with a copy button.

---

## Creating a Bot

### Step 1 — Create the Slack App

1. Go to `https://api.slack.com/apps` → **Create New App → From scratch**.
2. Enter a name and select your Slack workspace.
3. Go to **OAuth & Permissions → Scopes → Bot Token Scopes** and add:
   ```
   chat:write
   commands
   im:history
   ```
4. Go to **OAuth & Permissions → Scopes → User Token Scopes** and add:
   ```
   openid
   profile
   ```
   (Required for "Connect via Slack" identity linking by users.)

5. Under **OAuth & Permissions → Redirect URLs**, add:
   ```
   https://<domain>/api/slack/oauth/callback
   ```

6. Go to **App Home**, enable the **Messages Tab**, and check:
   ```
   Allow users to send Slash commands and messages from the messages tab
   ```

7. Note your **Client ID** and **Client Secret** from **Basic Information → App Credentials**.

### Step 2 — Activate in RapidRAG

1. Open **Chat Channels → + Create a bot**.
2. Enter deployment name.
3. Fill in **Bot User OAuth Token**, **Signing Secret**, **Client ID**, **Client Secret** (all required).
4. Click **Validate token** — confirms workspace and bot user ID.
5. Set **Share with RapidRAG users**: Private / All / Specific.
6. Set **Require Slack user verification**:
   - **Checked (verified, default)**: per-user KB isolation. Set your own KBs.
   - **Unchecked (open access)**: any Slack user gets answers. Set default KBs.
7. Click **Save & Activate**.

### Step 3 — Register the webhook in Slack

After activation, copy the **Webhook URL** and **OAuth Redirect URL** shown in the wizard:

1. In Slack app → **Event Subscriptions** → enable and paste the webhook URL → wait for Verified.
2. Under **Subscribe to bot events** → add `message.im`.
3. In **Slash Commands** → Create New Command:
   ```
   Command: /kb
   Request URL: <webhook URL>
   Short description: Query RapidRAG knowledge bases
   Usage hint: [list | use <name> | all | status | help]
   ```
4. Click **Save**.

Credentials are stored in Vault at `platform/users/{ownerId}/slack/{deploymentId}/`.

---

## Sharing a Bot

The bot creator sets **Share with RapidRAG users** on the deployment:

| Setting | Effect |
|---------|--------|
| Private | Only the creator sees this bot |
| All RapidRAG users | Any user sees this bot in "My Slack Connections" |
| Specific users | Only listed users see it |

---

## Connecting to a Shared Bot (User Flow)

Users who see a bot in **My Slack Connections** with "Not linked" can click **Connect**:

1. **Phase 1 — Add to Slack**: click **Add to Slack** to install the bot app to their workspace (if not already installed). Users in the same workspace as the bot can skip this.
2. **Phase 2 — Link your identity**: select KBs, click **Connect via Slack**.
   - RapidRAG redirects to Slack identity OAuth (`user_scope=openid,profile`).
   - Slack returns the user's Slack user ID.
   - RapidRAG creates a `SlackUserKbMapping` entry and redirects back with a success banner.

After connecting, the user's Slack ID appears in the "Your Slack ID" column and they can DM or use `/kb` with the bot.

---

## Members Panel (Owner Only — Verified Mode)

Open **Chat Channels → My Bots → Members** button on a verified-mode deployment.

| Column | Notes |
|--------|-------|
| RapidRAG User | Username if linked |
| Slack ID | Real Slack user ID, or amber "Not linked" if synthetic placeholder |
| KBs | Assigned knowledge bases |
| Status | Connected / Pending / Not linked |
| Action | Remove |

**"Not linked" entries**: the bot owner's entry starts as "Not linked" after activation. The owner clicks **Connect** in Section 2 and completes Slack identity OAuth to replace the placeholder with their real Slack user ID.

**Manual add**: enter Slack user ID + optional RapidRAG username + KB selection → **Add member**. Used for users who cannot complete Slack OAuth (e.g. guest accounts).

---

## Message Routing

When a Slack message arrives at the webhook:

1. Signature verification using `signing_secret` (read from Redis 2-hour cache, or Vault on first hit).
2. Deduplication via Redis (event ID or slash-command hash).
3. Deployment lookup by `deploymentId` URL param.
4. **Slash commands**: `200 "Working on it..."` sent immediately; RAG runs async and posts answer to `response_url`.
5. **Open access**: serve `defaultKbIds` to all users.
6. **Verified**: look up `SlackUserKbMapping` by `slackUserId`. If not found → "not connected" reply. If found → use `userMapping.kbIds`.

---

## Required Slack App Scopes

```text
Bot Token Scopes:   chat:write  commands  im:history
User Token Scopes:  openid  profile
```

---

## Smoke Test

### Open access bot

1. Create bot → open access → set default KBs → activate.
2. In Slack, DM the bot.
3. Ask a question → confirm answer from default KBs.
4. Run `/kb list` → see mapped KBs.

### Verified bot

1. Create bot → verified mode → activate.
2. In Chat Channels → My Slack Connections → click Connect → complete Slack identity OAuth.
3. Confirm your Slack ID appears in Section 2 and in the Members panel.
4. DM the bot — confirm answers from your KBs.
5. Try from a different Slack user not in Members → confirm "not connected" message.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `/kb failed because the app did not respond` | Slack 3-second timeout exceeded | Check Redis connectivity (signing secret cache); service was recently restarted — first request hits Vault, subsequent are fast |
| Invalid Slack signature | Wrong signing secret or raw body not forwarded | Verify signing secret in Vault; confirm nginx passes raw body |
| "You are not connected" | User's Slack ID not in SlackUserKbMapping | User should complete Connect flow in My Slack Connections |
| Bot does not reply to DMs | `message.im` bot event not subscribed, or wrong webhook URL | In Slack app → Event Subscriptions → Subscribe to bot events → Add Bot User Event → add `message.im` → Save Changes → reinstall if prompted. Also confirm Request URL matches the webhook URL in View. |
| Duplicate replies | Redis dedup keys not being set | Check Redis connectivity |
| Sync: "App not found (404)" | Stale Dify app ID (app was deleted in Dify) | Sync auto-recovers: confirms app is gone, creates new app, retries |
| Sync: "App not found (404)" persists | Dify was temporarily unreachable during sync | The service confirms the app exists before recreating — if app exists and Dify is flaky, re-try sync once Dify is healthy |
| Dify GUI not accessible | `dify-web` container not running | `scripts/platform-containers.sh dev restart dify-web` |
| OAuth callback rejected | Client ID/secret mismatch or redirect URL not registered | Verify redirect URL `https://<domain>/api/slack/oauth/callback` is in Slack app OAuth settings |
| Bot shows "Not linked" for owner | Owner hasn't completed identity OAuth | Click Connect in My Slack Connections and complete Slack OAuth |

---

## Redis Cache Keys

| Key | TTL | Cleared by |
|-----|-----|-----------|
| `slack:signing_secret:{deploymentId}` | 2 hours | activate, update, deactivate, delete |
| `slack:bot_token:{deploymentId}` | 1 hour | activate, update, deactivate, delete |
| `slack:event:{event_id}` | 5 minutes | expires naturally |
| `slack:command:{hash}` | 5 minutes | expires naturally |
| `slack:oauth:identity:{nonce}` | 10 minutes | consumed on callback |

---

## Rollback

1. Deactivate affected Slack deployments in Chat Channels.
2. Disable Slack app Event Subscriptions or slash command if needed.
3. Prisma migration `20260519000000_slack_multiuser` added `SlackUserKbMapping` and fields on `SlackDeployment` — roll back with `prisma migrate resolve` if needed.

---

## nginx Public Routes

```text
/api/slack/oauth/callback
/api/slack/events
/api/slack/events/<deploymentId>
```

Webhook routes must preserve raw request bodies. Do not log Slack request bodies (slash commands include `response_url`).
