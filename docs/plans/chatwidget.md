# Website Chat Widget V1 Plan

This is a planning/specification document only. It describes the recommended Website Chat Widget V1 design and does not represent an implemented feature yet.

## Summary

RapidRAG will provide a plug-and-play website chat widget that customers configure entirely from the RapidRAG frontend. Customers create or sync one or more knowledge bases, create a widget deployment, choose a widget mode, bind KBs, verify domains, customize appearance and timers, then copy an embed script into their website.

V1 supports two customer-selectable widget modes:

- **Lead-capture widget**: asks for name, email, agreement, and Cloudflare Turnstile before chat starts.
- **Quick-start widget**: does not ask for name, email, or captcha by default; visitor clicks **Start Chat** and asks questions immediately.

Both modes answer only from the KBs mapped to that widget. All RAG calls stay backend-only; no Dify keys, OAuth tokens, or secret API keys are exposed in browser code.

Every widget shows a **"Powered by RapidRAG"** attribution footer. This attribution is non-removable in V1 and serves as both honest disclosure (AI-generated answers) and platform branding. The footer link points to rapidrag.ai. Future paid tiers may offer white-label removal.

**API-First Architecture Principle:** Every widget capability — session creation, messaging, lead retrieval, config, streaming — is implemented as a versioned REST API first. The widget frontend, the dashboard, and future integrations such as MCP are all consumers of the same API layer. No logic lives only in the frontend.

## Alignment with Existing Platform Architecture

The widget is **not a new container**. It is implemented as new routes and service logic inside the two existing application containers: `api-gateway` (HTTP endpoints) and `workflow-service` (RAG orchestration). All existing infrastructure — Vault, Redis, PostgreSQL, RabbitMQ, mTLS, logging-service, n8n — is reused as-is.

### Widget Frontend Bundle — Where It Lives

The visitor-facing widget (the JS that runs inside customer websites) is a **separate build artifact** from the Next.js web app. It lives in its own workspace package:

```
apps/widget/
  src/
    loader.ts          ← tiny entry point, derives apiBase from script.src, lazy-loads bundle
    widget.ts          ← full chat UI entry point (lazy loaded by loader)
    components/        ← chat UI components (message list, input, lead form, etc.)
    styles/            ← self-contained CSS, no dependency on @platform/ui-kit
  package.json
  vite.config.ts       ← builds two outputs: loader.min.js and widget.bundle.[hash].js
```

Built with **Vite** (already in the repo ecosystem for fast builds and tree-shaking). Outputs:
- `dist/loader.min.js` — tiny loader, short CDN TTL (5 min), content-hashed separately
- `dist/widget.bundle.[contenthash].js` — full chat UI, long CDN TTL (immutable), hash in filename for automatic cache busting

The loader lazy-loads the bundle by injecting a `<script>` tag pointing to `{apiBase}/widget/v1/bundle.{hash}.js`. The hash is baked into the loader at build time — customers never need to update the embed code when the bundle changes.

**Static file serving**: The api-gateway serves the widget dist files via `@fastify/static` mounted at `/widget/v1/`. In production, nginx ingress caches these files with the appropriate TTLs. A CDN can be placed in front of the nginx ingress without any code change — just point `WIDGET_CDN_BASE_URL` to the CDN origin.

### Framework: Fastify (not Express)

The platform uses **Fastify** throughout. All route registrations, middleware hooks, and request/reply patterns must follow the Fastify API. The module structure in this document uses Fastify plugin registration (`fastify.register()`), Fastify hooks (`fastify.addHook('preHandler', ...)`), and Fastify schema validation — not Express middleware or `app.use()`.

### Shared Packages to Use

All widget backend code must use the existing shared packages from `/packages/`. Do not re-implement anything these packages already provide.

| Package | What to use it for |
|---|---|
| `@platform/auth` | Admin dashboard API auth — `requireAnyRole()` middleware for all `/widgets/deployments/*` admin routes, same as all other authenticated routes |
| `@platform/db` | All database operations via Prisma. Widget schema entities (`WidgetDeployment`, `WidgetSession`, etc.) are added to the shared Prisma schema in this package |
| `@platform/contracts` | Add widget TypeScript types here. Add `"widget"` to the existing `ChannelOrigin` union type so widget threads are tracked alongside Slack threads |
| `@platform/observability` | Distributed tracing on all widget service methods via `createTraceHook()` — same pattern used in workflow-service |
| `@platform/tls-runtime` | Already handles mTLS for all inter-service calls. The api-gateway already accepts TLS from public browsers on widget routes and uses mTLS internally to workflow-service |
| `@platform/ui-kit` | Reuse existing React components for all dashboard UI. Do not introduce a second component library |

### Authentication Model

- **Admin dashboard routes** (`/widgets/deployments/*`): Keycloak JWT + `requireAnyRole(['admin', 'useradmin', 'operator'])` — identical to all other protected routes.
- **Public widget routes** (`/widget/v1/*`): No Keycloak JWT. Protected by widget public key, verified origin CORS, opaque session token, Turnstile (lead-capture mode), replay nonce, and Redis rate limits.
- The api-gateway already handles both patterns. Public widget routes are registered without the JWT `preHandler` hook.

### mTLS and TLS Boundaries

The platform enforces mTLS between all internal services. The widget follows the same boundary:

```
Browser (TLS only, no client cert)
    ↓ HTTPS
api-gateway  ← public TLS termination (already handles this for all routes)
    ↓ mTLS (Vault-managed certs via @platform/tls-runtime)
workflow-service  ← widget RAG calls go here
    ↓ mTLS
Dify API
```

No new TLS configuration is needed. The existing Vault agent sidecars (`api-gateway-vault-agent`, `workflow-service-vault-agent`) already inject and rotate the certificates.

### Existing Chat Infrastructure to Reuse

The platform already has:
- `ChannelChatThread` table and API — widget threads are created with `origin: "widget"`.
- `ChannelChatMessage` table — all messages are stored here regardless of channel.
- `ChannelChatKbSession` — per-KB Dify conversation ID mapping, reused for widget.
- Input guard, output gate, zero-retrieval handling, hallucination guard — all live in workflow-service and are called by all channels. Widget calls the same guard chain.

### RabbitMQ Events

Widget events are published to RabbitMQ for downstream consumers (analytics, email triggers, n8n workflows) using the existing event bus pattern already used by other services.

Events to publish:
- `widget.lead.created` — when a lead-capture session starts (triggers optional email notification via n8n).
- `widget.session.started` — for any new visitor session.
- `widget.message.sent` — for RAG usage analytics per deployment.

### n8n Integration

- **Lead email notification**: A new n8n workflow subscribes to `widget.lead.created` RabbitMQ events and sends a notification email to the widget owner when a new lead is captured.
- **Retention cleanup**: A scheduled n8n workflow runs nightly, finds `WidgetLead` records past their retention window, anonymizes/deletes them.
- Both workflows follow the same pattern as existing n8n sync workflows. They are seeded via `infra/n8n/init-workflows.sh`.

### Logging and Observability

Widget API logs go through the existing **logging-service** (port 4005) and are stored in **OpenSearch**, exactly as all other platform logs. The `X-Request-Id` correlation header is already injected by the api-gateway's existing `preHandler` hook — no new setup needed for the widget. Widget-specific slow request and error logs use `logInfo()` from `@platform/observability` with `component: "widget"` context.

### Navigation Sidebar

The widget management pages are added to the **Workspace Section** of the existing navigation sidebar (`apps/web/src/app/navigation-sidebar.tsx`), alongside the existing `/chat-channels` (Slack) entry:

```
Workspace Section (admin/useradmin only):
  /ai-agent-prompt     — Prompt templates (existing)
  /chat-channels       — Slack deployments (existing)
  /widgets             — Website Chat Widget (new)
```

### Prisma Schema

All new widget database entities are added to the existing Prisma schema in `@platform/db`. Migrations follow the existing migration naming and run automatically via the existing `db-migrate` container in Phase 4 of the phased startup. No new migration runner or separate database is needed.

---

## API-First and MCP-Ready Design

The widget is built on a service layer that is deliberately consumer-agnostic. The same RAG query pipeline serves the widget, the platform web chat, Slack, and future consumers such as MCP servers or third-party integrations.

```
Consumer layer       Widget JS | Dashboard | Slack | MCP Server | Future
                          |          |          |        |
API Gateway layer    /widget/v1/* | /api/* | /slack/* | /mcp/* (future)
                          |          |          |        |
Service layer        RagQueryService  SessionService  LeadService
                          |
Dify / KB layer      Dify API  KnowledgeBaseStore
```

### Why This Matters for MCP

MCP (Model Context Protocol) allows external AI agents such as Claude to call tools and read resources. When RapidRAG adds MCP support, the MCP server will be a thin adapter that translates MCP tool calls into the same internal service calls the widget already uses.

Planned MCP tools (V2 scope, designed now):

- `rapidrag.query_kb` — query one or more knowledge bases with a question, returns answer and sources.
- `rapidrag.list_deployments` — list active widget deployments and their KB mappings.
- `rapidrag.create_session` — open a chat session on a deployment.
- `rapidrag.send_message` — send a message within a session, returns streamed or blocking answer.
- `rapidrag.get_lead_history` — retrieve conversation history for a session.

MCP resources:

- `rapidrag://kb/{kb_id}` — a knowledge base as a readable resource.
- `rapidrag://deployment/{deployment_id}/leads` — lead and transcript data.

For this to work cleanly, every service method called by the widget API must also be callable without HTTP context (i.e., as a plain function/service call that the MCP adapter can invoke directly).

### API Versioning

All public and admin endpoints are versioned under `/v1/`. Breaking changes require a new version prefix. The widget embed code pins to a major version of the loader (`/widget/v1/loader.js`) so existing customer embeds are never broken by platform upgrades.

---

## Environment Promotion: Zero Code Change to Production

**Rule: Moving from development to staging to production requires only domain and environment variable changes. No code changes, no config file edits, no manual SQL.**

This is enforced by the following architectural decisions.

### Widget Self-Referential API Origin

The widget loader derives its API base URL from the `src` attribute of the script tag itself — it never contains a hardcoded domain string.

```js
// Inside loader.js — derived at runtime, not hardcoded
const apiBase = new URL(document.currentScript.src).origin;
```

This means the same compiled `loader.js` works on `dev.rapidrag.ai`, `staging.rapidrag.ai`, and `rapidrag.ai` without recompilation. The only thing that changes is which domain serves the file.

The generated embed code is templated from `PLATFORM_BASE_URL`:

```html
<!-- Generated by dashboard — PLATFORM_BASE_URL is injected at generation time -->
<script
  async
  crossorigin="anonymous"
  src="https://{PLATFORM_BASE_URL}/widget/v1/loader.js"
  integrity="sha384-{SRI_HASH}"
  data-widget-key="pub_wdg_xxxxx"
  data-theme="light">
</script>
```

Customers copy this once. If their `PLATFORM_BASE_URL` was `dev.rapidrag.ai` during testing and later moves to `rapidrag.ai`, they regenerate the embed code from the dashboard — a single copy-paste. The widget code itself is unchanged.

### Environment Files Per Environment

The project already has separate env files per environment. **No new env files are needed for the widget.**

```
.env                    ← dev non-secret config (already exists)
.env.example            ← committed template, no secrets (already exists)
.env.production         ← prod non-secret config (already exists)
.env.production.example ← committed prod template (already exists)
.env.runtime            ← ephemeral, auto-generated from Vault, never committed
```

**Secrets are never stored in env files.** All credentials (signing keys, Turnstile keys, database passwords, Redis passwords, etc.) live in HashiCorp Vault under `platform/dev/*` and `platform/prod/*`. The runtime env file is generated from Vault by `scripts/generate-runtime-env.sh`, written to `/run/platform-secrets/` with `chmod 600`, and shredded immediately after `docker compose up` starts.

Widget-specific non-secret config (URLs, feature flags, domain settings) goes into `.env` for dev and `.env.production` for prod, following the existing pattern already used by all other services.

### All Environment-Specific Config via Environment Variables

No domain, URL, secret, or environment-specific value is hardcoded in source code or committed config files.

Required environment variables:

| Variable | Purpose |
|---|---|
| `PLATFORM_BASE_URL` | Base domain, e.g. `rapidrag.ai`. Used in embed code generation, CORS policy, CSP headers, and email links. |
| `WIDGET_SIGNING_SECRET` | HMAC secret for opaque session token signing. Rotate without code change. |
| `REDIS_URL` | Session store, rate limit counters, nonce replay store. |
| `DATABASE_URL` | Primary database connection. |
| `DIFY_API_URL` | Dify API base URL. Point to different Dify instance per environment. |
| `DIFY_API_KEY` | Dify API key. Different key per environment. |
| `TURNSTILE_SITE_KEY` | Public Cloudflare Turnstile key (safe to expose). |
| `TURNSTILE_SECRET_KEY` | Server-side Turnstile validation key. |
| `TURNSTILE_FALLBACK_SITE_KEY` | Platform fallback Turnstile site key for customers without their own. |
| `TURNSTILE_FALLBACK_SECRET_KEY` | Platform fallback Turnstile secret key. |
| `WIDGET_CDN_BASE_URL` | CDN origin for widget static assets. Defaults to `PLATFORM_BASE_URL` if not set. |
| `SESSION_IDLE_TIMEOUT_MINUTES` | Default idle timeout. Overridden per widget deployment. |
| `SESSION_MAX_LIFETIME_HOURS` | Default max session lifetime. Overridden per widget deployment. |
| `RATE_LIMIT_IP_MESSAGES_PER_MINUTE` | Default per-IP message rate limit. |
| `RATE_LIMIT_SESSION_MESSAGES_PER_MINUTE` | Default per-session message rate limit. |
| `LOG_LEVEL` | `debug` in development, `info` in production. |
| `NODE_ENV` | `development`, `staging`, or `production`. Controls localhost domain allowance and debug headers. |

### Database Migrations Run Automatically

Migrations run as a pre-start step in the container entrypoint, not manually. No deploy checklist item says "remember to run migrations."

```dockerfile
# Entrypoint runs migrations then starts the server
CMD ["sh", "-c", "npm run migrate && npm run start"]
```

Migration files are committed to the repo. They are backwards-compatible so rolling deploys work without downtime. No destructive drops in V1 migrations.

### No Localhost Hardcoding

`localhost` and `127.0.0.1` are only permitted as widget domains when `NODE_ENV=development`. The code path checks the environment variable, not a hardcoded string. Setting `NODE_ENV=production` automatically disallows localhost domains without any code change.

### CORS Policy Derived from Verified Domains

CORS `Access-Control-Allow-Origin` is never hardcoded. It is resolved at request time by looking up the requesting origin against verified domains stored in the database. Adding a new production domain means adding and verifying it in the dashboard, not editing any config file or code.

### SRI Hash Generated at Build Time

The widget bundle SRI hash is computed during the CI build and written to a build artifact file. The API reads this file to serve the correct `integrity` attribute in generated embed codes. No manual hash update is needed on deploy.

### Promotion Checklist (Domain + Env Vars Only)

When promoting to a new environment the only steps are:

1. Set environment variables for the new environment (table above).
2. Point DNS for the new domain to the deployment.
3. Verify TLS certificate.
4. Deploy the same container image that passed staging.
5. Confirm `GET /widget/v1/health` returns 200.
6. Done — no code changes, no SQL scripts, no config file edits.

---

## Recommended Launch Approach

These are the day-one decisions for implementation:

- **Use opaque server-side session tokens**, not large self-contained JWTs.
  - Browser receives only a random opaque token.
  - Redis/DB stores deployment ID, visitor ID, thread ID, origin domain, mode, idle expiry, max expiry, and status.
  - This gives smaller requests, simpler idle timeout handling, and instant revocation when a session or deployment is disabled.

- **Use Cloudflare Turnstile for lead-capture mode**.
  - Default captcha provider is Turnstile because it is low-friction and privacy-friendly.
  - Allow customer-provided Turnstile keys, with platform fallback keys for simple setup.
  - Do not ask for captcha again inside the same active session unless future risk mode requires it.

- **Use streaming responses for the widget message path**.
  - Prefer SSE (`text/event-stream`) for the public widget message endpoint.
  - Show typing indicator immediately, then render answer chunks as they arrive.
  - Keep existing web chat and Slack paths blocking unless/until they are migrated separately.
  - If Dify streaming fails, fall back to a friendly error or blocking fallback where safe.

- **Keep quick-start mode low-friction**.
  - No name, email, or captcha by default.
  - Apply stricter per-IP and per-deployment rate limits than lead-capture mode.
  - Add risk-based challenge later only if abuse appears.

- **Build observability into launch**.
  - Every public widget API response includes `X-Request-Id`.
  - Dashboard shows recent widget errors, response latency, rate-limit hits, and domain verification status.
  - Browser debug logs can be enabled with `localStorage.setItem("rapidrag_debug", "true")`.

## Customer Setup Flow

1. Customer logs in to RapidRAG using existing dashboard authentication.
2. Customer creates or syncs the KBs they want to expose, such as product FAQ, shipping policy, or warranty KB.
3. Customer opens the Website Widget setup area.
4. Customer creates a widget deployment and gives it a name.
5. Customer chooses widget mode: lead-capture or quick-start.
6. Customer selects one or more KBs to attach to the widget.
7. Customer adds one or more allowed website domains.
8. Customer verifies each domain.
9. Customer configures appearance, header text, icon, privacy policy URL where needed, and session timers.
10. Customer previews the widget in the dashboard.
11. Customer activates the widget.
12. RapidRAG shows embed code and CSP guidance.
13. Customer pastes the embed code before the closing `</body>` tag.
14. Customer publishes the website and sends a test question.

Example embed code (generated by the dashboard — customers copy and paste this):

```html
<script
  async
  crossorigin="anonymous"
  src="https://rapidrag.ai/widget/v1/loader.js"
  integrity="sha384-<generated-at-build-time>"
  data-widget-key="pub_wdg_xxxxx"
  data-theme="light">
</script>
```

The embed code is generated in the RapidRAG dashboard with the correct versioned URL, SRI hash, and widget key already filled in. Customers do not edit the embed code manually. When the platform domain changes (e.g. moving from dev to production), customers regenerate the embed code from the dashboard — one copy-paste, no other changes.

## Widget Modes

### Lead-Capture Widget

Use this mode when the customer wants sales/support leads and visitor identity before answering.

Visitor flow:

1. Visitor opens the widget.
2. Widget displays lead form.
3. Visitor enters name and email.
4. Visitor checks agreement/privacy consent checkbox.
5. Visitor completes Cloudflare Turnstile.
6. Backend creates lead, chat thread, and opaque session token.
7. Visitor can send messages.
8. RapidRAG answers from assigned KBs only.

Requirements:

- Name and email are required.
- Agreement checkbox is required.
- Privacy policy URL should be configured by the customer.
- Consent timestamp is stored with the lead/session.
- Turnstile is validated once at session creation.

### Quick-Start Widget

Use this mode when the customer wants the fastest support experience and does not need name/email before chat.

Visitor flow:

1. Visitor opens the widget.
2. Widget shows a **Start Chat** button.
3. Visitor clicks **Start Chat**.
4. Backend creates anonymous visitor session, chat thread, and opaque session token.
5. Visitor asks questions immediately.
6. RapidRAG answers from assigned KBs only.

Requirements:

- Do not require name or email.
- Do not show captcha by default.
- Still enforce verified domain, opaque session token, exact CORS origin, replay protection, and Redis rate limits.
- Store the visitor as anonymous with generated visitor ID.
- Allow optional privacy notice near **Start Chat**.
- Use stricter abuse limits than lead-capture mode.

## Appearance And Branding

Each widget should allow customer-controlled branding:

- Header title, for example `Product FAQ Assistant`, `Ask RapidRAG`, or `Support Bot`.
- Optional subtitle, for example `Answers from our product docs`.
- Icon/avatar selection:
  - default RapidRAG AI chatbot icon
  - friendly robot avatar style
  - compact chat-bubble/AI icon style
  - future custom uploaded icon
- Theme controls:
  - primary color
  - light/dark mode
  - bottom-right or bottom-left placement

The robot examples discussed during planning are visual direction for a friendly AI assistant avatar, not fixed production assets unless final asset license/source is confirmed.

## Knowledge Base Binding

Each widget deployment can be assigned to multiple KBs. The browser must never choose which KBs to query during a visitor chat session.

Backend rules:

- Store widget-to-KB mappings server-side.
- Resolve mapped KBs from deployment on every message.
- Ignore or reject browser-supplied KB IDs.
- Reuse existing guarded RAG pipeline.
- Keep Dify API keys and KB secrets server-side only.
- Track which KBs contributed to each answer for future analytics.

If multiple KBs have different tones, V1 should use the widget-level prompt/style as the answer style. Later, customers can choose a primary KB for tone and supplementary KBs for facts.

## Domain Verification

A widget cannot be activated until at least one domain is verified.

Supported verification methods:

1. **File verification, preferred**
   - Customer places a RapidRAG verification file at:
     `https://customer-domain.com/.well-known/rapidrag-verify.txt`
   - File contains generated verification token.
   - RapidRAG fetches file and compares token.

2. **DNS TXT verification, fallback**
   - Customer adds TXT record such as:
     `_rapidrag-verify.customer-domain.com`
   - TXT value contains generated verification token.
   - RapidRAG performs DNS lookup and compares token.

3. **Meta tag verification, launch requirement**
   - Customer adds:
     `<meta name="rapidrag-verify" content="token">`
   - RapidRAG fetches the homepage and checks the token.
   - Useful when `.well-known` is blocked and DNS access is slow.

Domain matching is exact by default. Subdomain support must be explicit through a deliberate `allowSubdomains` setting after root-domain verification.

### SSRF Protection on Domain Verification

When the platform fetches a customer-supplied domain for file or meta-tag verification, it must block requests that resolve to private or internal addresses. Without this, a customer could supply a domain pointing to `127.0.0.1`, `10.0.0.x`, `172.16.x.x`, `192.168.x.x`, `169.254.169.254` (cloud metadata), or `::1` — causing the platform to make requests to its own internal services.

Required controls before any outbound verification fetch:
- Resolve the domain to its IP address.
- Reject if the resolved IP is in RFC 1918 private ranges, loopback, link-local (169.254.x.x), or IPv6 equivalent.
- Set a short connect and read timeout (3 seconds) to prevent slow-loris holds.
- Follow a maximum of 1 redirect; reject further redirects.
- Do not send any platform credentials or cookies in verification requests.
- Log all verification fetch attempts with the resolved IP for audit.

Verification diagnostics:

- Show exact HTTP status for file/meta failures.
- Show whether DNS TXT is missing, stale, or mismatched.
- Provide copyable test command, for example:
  `curl https://customer-domain.com/.well-known/rapidrag-verify.txt`

## Authentication And Sessions

The public widget does not use OAuth and does not expose secret API keys.

Authentication layers:

- Customer admin dashboard: existing RapidRAG/Keycloak login.
- Widget embed: public publishable widget key.
- Visitor session: opaque server-side session token issued after required mode checks pass.
- Future enterprise mode: customer backend signs sessions with secret API key.

Opaque session token storage:

- Browser stores active session token in `sessionStorage`.
- Redis/DB stores session claims:
  - deployment ID
  - visitor ID
  - thread ID
  - origin domain
  - widget mode
  - idle expiry
  - max expiry
  - status: active, expired, ended, revoked

Every message request must validate:

- opaque token exists and maps to an active session
- deployment is active
- origin domain is still verified
- request origin matches session origin domain
- thread belongs to visitor
- visitor belongs to deployment
- session is not idle-expired, max-expired, ended, or revoked
- request follows configured widget mode
- nonce/timestamp replay checks pass
- rate limits pass

## Multiple Visitors On The Same Website

Many visitors can use the same widget at the same time. Each visitor gets isolated state.

Isolation model:

- Same widget deployment can have many visitor sessions.
- Each visitor gets unique lead/anonymous visitor record.
- Each visitor gets unique opaque session token.
- Each visitor gets unique chat thread.
- Each mapped KB gets its own conversation/session state as needed.

No chat history or Dify conversation context should be shared between visitors.

```text
Customer website
  -> Widget deployment: Product FAQ Widget
      -> Visitor session A: John / john@example.com
      -> Visitor session B: Sara / sara@example.com
      -> Visitor session C: anonymous visitor
```

## Session Storage And Navigation

Use `sessionStorage` for the browser-side active widget session in V1.

Behavior:

- Same tab and same verified website: keep active session.
- Page reload in same tab: restore active session if not expired.
- Same-site navigation in same tab: keep history if session is active.
- New browser tab: start separate session.
- Different browser/device: start new session.
- Tab close: browser-side active session is gone, but backend lead/chat history remains until retention cleanup.

This avoids keeping sessions open forever and prevents accidental cross-tab sharing. Optional cross-tab continuity using `localStorage` plus `BroadcastChannel` can be V1.1 with a privacy warning.

## Configurable Session Timers

Timer values must be configurable during widget setup so code changes are not needed for customer preferences.

Default settings:

- Idle timeout: `10 minutes`
- Idle warning: after `5 minutes` idle, warn that session expires in 5 more minutes
- Maximum session lifetime: `24 hours`
- Lead/chat retention: `90 days`

Recommended validation ranges:

- Idle timeout: `5` to `120` minutes
- Idle warning: `1` to `30` minutes and less than idle timeout
- Maximum session lifetime: `1` to `168` hours
- Lead/chat retention: `7` to `365` days

Timer behavior:

- Reset idle timer when visitor sends a message, receives an answer, types, or interacts with widget.
- Show warning after configured idle-warning threshold.
- If visitor interacts after warning but before expiry, continue same session.
- If idle timeout is reached, expire session and require new lead/session before more chat.
- Backend enforces idle timeout and max lifetime on every message.

Default warning:

```text
Your chat session will expire in 5 minutes due to inactivity.
```

Default expired message:

```text
Your chat session has expired. Please start a new chat to continue.
```

## Fast Response And Streaming Architecture

Fast perceived response is a launch requirement.

Widget frontend:

- Show typing indicator immediately after send.
- Render streamed answer chunks progressively.
- Use client-side timeout and retry state, defaulting to 15 seconds.
- Keep composer usable and show clear progress.
- Handle stream completion, stream error, and retry states.

API gateway:

- Add a widget stream route that supports `text/event-stream`.
- Do not buffer streaming responses.
- Preserve `X-Request-Id` and streaming headers.
- Enforce origin, session, nonce, and rate-limit checks before stream begins.

Workflow service:

- Add a widget-specific streaming message handler.
- Use Dify streaming mode when available.
- Keep existing blocking helper for current web chat and Slack paths.
- Store final assistant message after stream completes.
- On mid-stream failure, send a structured stream error and log request context.

Dify:

- Existing blocking calls use `response_mode: "blocking"`.
- Widget streaming path should use `response_mode: "streaming"` when supported.
- If streaming cannot be used, fallback should still show typing/progress and return a friendly error on timeout.

Nginx/proxy:

- Disable proxy buffering for widget streaming routes.
- Set timeouts high enough for long RAG responses.
- Keep dynamic responses `Cache-Control: no-store`.

Streaming should be scoped to the new widget message endpoint first. Existing platform web chat and Slack do not need to change in V1.

## Public Widget APIs

Public endpoints are unauthenticated by user login, but protected by widget key, verified origin, opaque session tokens, Turnstile where needed, replay checks, and rate limits.

Planned endpoints:

- `GET /widget/v1/config/:publicKey`
  - Returns mode, theme, welcome message, privacy policy URL, Turnstile site key, timer config, and stream support flag.

- `POST /widget/v1/init`
  - Accepts public widget key, origin, and mode-specific visitor data.
  - Lead-capture mode accepts name, email, consent flag, and Turnstile token.
  - Quick-start mode accepts Start Chat intent and does not require name/email/captcha.
  - Validates domain, mode rules, Turnstile/consent where required, and rate limits.
  - Creates visitor/lead and thread.
  - Returns opaque session token and expiry metadata.

- `POST /widget/v1/message`
  - Non-streaming fallback endpoint.
  - Accepts opaque session token, message, nonce, and timestamp.
  - Validates session, origin, nonce, replay window, rate limits, and timers.
  - Sends message through backend RAG pipeline.

- `GET or POST /widget/v1/message/stream`
  - Streaming endpoint for widget messages.
  - Uses SSE or equivalent streaming response.
  - Must perform all security checks before emitting answer chunks.

- `POST /widget/v1/refresh` (optional)
  - Refreshes an active or recently valid session token without requiring new lead info, only if allowed by session policy.

## Admin APIs

Admin endpoints use existing authenticated dashboard access.

Planned endpoints:

- `GET /widgets/deployments`
- `POST /widgets/deployments`
- `PUT /widgets/deployments/:id`
- `DELETE /widgets/deployments/:id`
- `POST /widgets/deployments/:id/domains`
- `POST /widgets/deployments/:id/domains/:domainId/verify`
- `POST /widgets/deployments/:id/activate`
- `POST /widgets/deployments/:id/deactivate`
  - On deactivation: set deployment status to inactive. All new session creation is rejected immediately. Existing active sessions continue until their natural idle or max expiry — they are not force-revoked. This avoids cutting off a visitor mid-sentence. Sessions do not auto-renew once the deployment is inactive.
- `GET /widgets/deployments/:id/leads`
- `GET /widgets/deployments/:id/leads.csv`
- `DELETE /widgets/deployments/:id/leads/:threadId`
- `GET /widgets/deployments/:id/health`
- `GET /widgets/deployments/:id/logs`

Activation must require:

- at least one verified domain
- at least one mapped KB
- valid mode configuration
- valid privacy policy/consent configuration for lead-capture mode
- Turnstile configuration for lead-capture mode
- valid timer configuration

## Backend Security Requirements

Origin and CORS:

- Check `Origin` first, with `Referer` fallback only where appropriate.
- Match request origin against verified domains for deployment.
- Return `Access-Control-Allow-Origin` only for verified requesting origin.
- Never return wildcard CORS for widget endpoints.

Replay protection:

- Each message request includes nonce and timestamp.
- Timestamp must be fresh, for example within 10 seconds.
- Redis stores used nonces scoped by session token hash until session expiry.
- Duplicate nonces are rejected.

Rate limiting:

- Use Redis sliding-window or equivalent counters.
- Apply limits per IP.
- Apply limits per deployment.
- Apply limits per session token.
- Quick-start mode gets stricter anonymous-session limits than lead-capture mode.
- Return `429` with `Retry-After` when limits are exceeded.

Recommended starting limits:

- Per IP session creation: tier configurable.
- Per IP messages: 60 per minute.
- Per session token: 30 messages per minute.
- Per deployment sessions: tier configurable.
- Per deployment messages: tier configurable.
- Quick-start session creation should start stricter than lead-capture.

RAG safety:

- Reuse input guard.
- Reuse output gate.
- Reuse zero-retrieval handling.
- Reuse hallucination guard.
- Log widget RAG events with deployment/session/request context.
- Return friendly error if Dify/RAG fails.

Default failure:

```text
I am having trouble answering right now. Please try again later or contact support.
```

## Customer Dashboard

The frontend should provide:

- widget list
- create/edit wizard
- dashboard preview mode
- KB multi-select
- domain verification instructions and diagnostics
- activation/deactivation controls
- embed code copy block
- CSP guidance
- theme and appearance settings
- widget mode selector: lead-capture or quick-start
- header title/subtitle settings
- icon/avatar selection
- privacy policy URL setting
- Turnstile configuration status
- configurable session timers
- leads/anonymous visitor table
- transcript view
- CSV export
- delete or anonymize lead data
- widget health panel
- widget logs filtered by `X-Request-Id`

Lead/visitor table columns:

- name
- email
- visitor type: lead or anonymous
- domain
- first seen
- last message
- message count
- status
- actions

CSV export should include:

- name
- email
- visitor type
- domain
- first seen
- last seen
- message count
- transcript reference or transcript content, depending on final product choice

Privacy controls:

- anonymize lead name/email
- delete a lead and transcript
- automatic retention cleanup based on widget setting
- audit log for viewing/exporting leads where practical

## Data Model Planning

All models are defined in `packages/db/prisma/schema.prisma` using Prisma ORM. Migrations run automatically via the existing `db-migrate` container (Phase 4 of phased startup). No separate migration runner is needed.

### New models to add to Prisma schema

**`WidgetDeployment`**
- `id`, `ownerId` (FK to platform user), `name`, `status` (draft/active/inactive)
- `publicKey` (unique, `pub_wdg_xxxxx` format)
- `widgetMode` (lead_capture | quick_start)
- `appearanceJson` (header title, subtitle, icon, primary colour, placement, light/dark)
- `timerConfig` (idleTimeoutMinutes, idleWarningMinutes, maxLifetimeHours, retentionDays)
- `turnstileConfigJson` (siteKey, secretKey reference — key value stored in Vault, not here)
- `streamEnabled` (boolean, default true)
- `personaPrompt` (optional custom persona/tone — prepended to system prompt on every Dify call for this deployment)
- `privacyPolicyUrl`
- `fallbackContactUrl` (optional email or URL shown when widget bundle fails to load — e.g. `mailto:support@company.com` or `https://company.com/contact`)
- `createdAt`, `updatedAt`

**`WidgetDeploymentKb`**
- `deploymentId` (FK → WidgetDeployment), `knowledgeBaseId` (FK → existing KB table), `displayOrder`
- Composite primary key on `(deploymentId, knowledgeBaseId)`

**`WidgetAllowedDomain`**
- `id`, `deploymentId` (FK → WidgetDeployment), `hostname`
- `verificationToken`, `verificationMethod` (file | dns_txt | meta_tag)
- `verifiedAt`, `lastVerifiedAt`, `lastVerificationResult`
- `allowSubdomains` (boolean, default false)

**`WidgetLead`**
- `id`, `deploymentId`, `threadId` (FK → existing `ChannelChatThread`)
- `visitorType` (lead | anonymous), `visitorId` (generated UUID)
- `name`, `email` (nullable, encrypted at rest for leads)
- `consentTimestamp`, `privacyPolicyUrl` (snapshot at consent time)
- `anonymizedAt`, `deletedAt`, `createdAt`

**`WidgetSession`**
- `tokenHash` (primary key — SHA-256 of the opaque token, never the raw token)
- `deploymentId`, `visitorId`, `threadId`
- `originDomain`, `widgetMode`, `status` (active | expired | ended | revoked)
- `idleExpiresAt`, `maxExpiresAt`, `lastActivityAt`

### Existing models to reuse (no changes needed)

- `ChannelChatThread` — widget threads created with `origin: "widget"`. The `origin` enum already exists; add `widget` as a value.
- `ChannelChatMessage` — all widget messages stored here, same as Slack messages.
- `ChannelChatKbSession` — per-KB Dify conversation ID mapping, reused for widget channel.

### PII protection

`WidgetLead.name` and `WidgetLead.email` are encrypted at rest using the platform's Vault transit encryption strategy, consistent with how other PII fields are protected.

## Observability And Debugging

The platform already has a full observability stack. Widget observability hooks into the existing infrastructure — no new logging or tracing system is introduced.

### Existing infrastructure used

- **`X-Request-Id`**: The api-gateway already injects a correlation ID on every request via an existing `preHandler` hook. Widget routes inherit this automatically.
- **Distributed tracing**: `@platform/observability` provides `createTraceHook()` using AsyncLocalStorage. Widget service methods call `logInfo()` with `component: "widget"` context exactly as other services do.
- **Logging service** (port 4005): All widget log events are sent to the logging-service and stored in OpenSearch, the same as sync-job logs and cert-rotation events. Widget-specific log queries filter by `component: "widget"` and optionally `deploymentId`.
- **Existing `/logs` dashboard page**: The platform already has a log viewer. Widget logs appear here. The widget health panel links to filtered log views using `X-Request-Id`.

### Widget-specific additions

- Deployment health panel at `/widgets/[id]/health`:
  - last 10 errors (queried from logging-service by `deploymentId`)
  - average and p95 response latency (from timing fields logged on each widget RAG call)
  - rate-limit hit count (from Redis counter reads)
  - domain verification status (from `WidgetAllowedDomain` table)
  - last successful message time
  - Dify circuit breaker state
- Browser debug mode:
  - enabled with `localStorage.setItem("rapidrag_debug", "true")`
  - logs widget lifecycle and non-secret diagnostics to browser console
  - never logs raw session tokens, secrets, or visitor PII
- Slow widget RAG requests (> 5 seconds) are logged with:
  - `deploymentId`, `threadId`, `kbIds`, `difyTimingMs`, `X-Request-Id`

## V1.1 Candidates

These are valuable but can follow first launch if scope pressure appears.

- Embed loader resilience:
  - retry failed config loads with backoff
  - CSS-only skeleton/fallback while widget bundle loads
  - `window.rapidragQueue` for queued commands before loader is ready

- Local development support:
  - dashboard development-mode toggle
  - allow `localhost` and `127.0.0.1` only in development mode
  - clearly mark as unsafe for production

- Optional cross-tab continuity:
  - keep V1 default as `sessionStorage`
  - later allow opt-in sharing using `localStorage` plus `BroadcastChannel`
  - show privacy warning

- Quick-start optional email capture:
  - after several messages, optionally show `Email me this transcript`
  - customer can enable or disable this prompt

- Captcha policy modes:
  - lead-capture default remains Turnstile before chat
  - later allow `always`, `on_abuse`, or `disabled`
  - `disabled` shows abuse-risk warning and stricter rate limits

- Frequently asked question cache:
  - cache identical or near-identical questions for short TTL where safe
  - invalidate when mapped KB is resynced

- Per-KB usage analytics:
  - show which KB contributed to each answer
  - help customers tune multi-KB widgets

## Later / Enterprise Candidates

- Enterprise first-party hosting:
  - customer CNAME such as `chat.customer.com`
  - optional self-hosted loader or API proxy

- Customer backend signed sessions:
  - customer backend signs visitor identity with secret API key
  - useful for authenticated portals and CRM/customer-user correlation

- KB-level concurrency controls:
  - limit concurrent RAG requests per KB
  - queue briefly when saturated
  - return polite busy message when capacity is exceeded
  - add cost/concurrency alerts

- Advanced privacy automation:
  - Data Processing Agreement acceptance in setup
  - right-to-be-forgotten API using email hash
  - store privacy policy version shown at consent time
  - detailed audit exports and lead views

## Professional UI Standards

The widget and the customer dashboard are both public-facing products. Both must meet professional UI quality before launch.

### Design Principles

- **Consistent design system**: use `@platform/ui-kit` for all dashboard pages. This is the existing shared component library already used across the platform. Do not introduce a second component library. The widget visitor UI (the iframe/bundle served to customer websites) has its own self-contained CSS that does not depend on `@platform/ui-kit`.
- **Every state is designed**: every screen has a loading state, an empty state, an error state, and a success state. No blank white screens or raw JSON errors shown to users.
- **Responsive by default**: dashboard works on desktop (1280px+), tablet (768px+). Widget works on mobile (320px+) without overlapping browser chrome or virtual keyboard.
- **Accessible by default**: WCAG 2.1 AA minimum. All interactive elements are keyboard-navigable, have visible focus rings, and have ARIA labels. Color contrast ratio 4.5:1 minimum.
- **Professional typography**: consistent font scale, line height, and spacing. No mixed font sizes across similar UI elements.

### Widget Visual Standards

The visitor-facing widget is the most visible part of the product. It must feel polished:

- Smooth open/close animation (no jarring position jumps).
- Typing indicator is animated (three pulsing dots, not static text).
- Streamed answer text renders progressively without layout shift.
- Messages use readable line length (max ~65 characters wide).
- "Powered by RapidRAG" footer is subtle, not distracting — small grey text at bottom.
- Widget launcher button has hover and active states.
- Error states show a human-friendly message with a retry button, never a stack trace.
- On mobile: widget opens full-height above the keyboard, does not overlap the launcher button.

### Dashboard Visual Standards

- Navigation sidebar matches the existing RapidRAG sidebar style — no new navigation pattern invented for widgets.
- Widget setup wizard uses a step indicator so customers always know where they are.
- Domain verification status uses clear visual indicators: green (verified), yellow (pending), red (failed), with an exact error message, not just a colour.
- Embed code block uses syntax highlighting and a one-click copy button with a copied confirmation state.
- Widget preview in dashboard is live-rendered using the same widget bundle as production — not a static mockup.
- All form validation errors appear inline next to the field, not in a page-level toast only.
- Destructive actions (delete widget, delete lead, deactivate) require a confirmation dialog before executing.

### No Manual Config Files for Customisation

Any appearance, behaviour, or policy change a customer needs must be achievable through the dashboard UI. If a setting exists only as an environment variable or database field but has no UI control, it is incomplete. The rule is: **if a customer would ever need to ask support to change it, it needs a UI control.**

---

## Build and Restart Scripts

The platform already has a complete set of scripts. **Do not invent new scripts or run raw `docker compose` commands.** All operations go through the existing scripts.

### Existing Scripts — What They Do

| Script | Purpose |
|---|---|
| `scripts/build-images.sh [dev\|prod]` | Builds all Docker images in dependency-aware phases. Phase 1: db-migrate. Phase 2: api-gateway, workflow-service, logging-service (shared base). Phase 3: web (bakes in `NEXT_PUBLIC_*` vars). |
| `scripts/platform-containers.sh [dev\|prod] [action] [services...]` | Start, stop, restart, status, logs for any environment. Handles Vault secret generation and shredding automatically. |
| `scripts/generate-runtime-env.sh` | Authenticates with Vault via AppRole, reads all secrets, writes ephemeral `.env.runtime` to `/run/platform-secrets/` with `chmod 600`. Vault token is revoked immediately after. |
| `scripts/rotate-secret.sh` | Rotates one field, one path, or all secrets in Vault for a given environment. Prints required manual DB follow-up steps. |
| `scripts/list-secrets.sh` | Lists all Vault secret paths and field names. Use `SHOW_VALUES=true` to reveal values (careful in prod). |
| `scripts/seed-keycloak-platform-admin.sh` | Seeds Keycloak platform admin account after first boot. |
| `infra/scripts/phased-startup.sh` | Full cold-boot in 6 phases. Called automatically by `platform-containers.sh dev/prod start` when no services are specified. |
| `infra/vault/seed-secrets.dev.sh` | Seeds all dev secrets into Vault. Run once after Vault bootstrap. |
| `infra/vault/seed-secrets.prod.sh` | Seeds all prod secrets into Vault. Run once on the production host. |
| `infra/scripts/update-prisma-client.sh` | Regenerates Prisma client after schema changes. |

### Common Operations

```bash
# Build all images for dev (after code changes)
scripts/build-images.sh dev

# Build only the api-gateway image
scripts/build-images.sh dev --only api-gateway

# Full cold boot (all 6 phases, Vault → infra → services → gateway)
scripts/platform-containers.sh dev start

# Cold boot from phase 5 (skip Vault + infra, restart services only)
scripts/platform-containers.sh dev start --phase 5

# Restart specific services after a rebuild (Vault secret injection is automatic)
scripts/platform-containers.sh dev restart workflow-service api-gateway web

# Restart specific services in prod
scripts/platform-containers.sh prod restart workflow-service api-gateway

# Check status
scripts/platform-containers.sh prod status

# Tail logs for the api-gateway
scripts/platform-containers.sh dev logs api-gateway

# Stop everything
scripts/platform-containers.sh prod down
```

### 6-Phase Startup Order

The phased startup exists because 33+ containers cannot be started simultaneously without race conditions. The phases are:

```
Phase 1: vault
Phase 2: vault-bootstrap, all *-vault-agent sidecars, cert-rotation-controller
         (TLS certs are issued to volumes here — all services need these before starting)
Phase 3: postgres, redis, rabbitmq, minio, keycloak, opensearch, n8n, dify-migrate
Phase 4: db-migrate (waits for postgres healthy), dify-api, dify-worker
Phase 5: workflow-service, logging-service, dify-web
Phase 6: api-gateway, web, web-ingress
```

The widget's API endpoints live in `api-gateway` (Phase 6) and `workflow-service` (Phase 5). No new phases are needed.

### Widget-Specific Additions to Existing Scripts

When the widget is implemented, the following additions are required to the **existing** scripts:

**`scripts/build-images.sh`** — add widget bundle build inside Phase 3:
- Build the widget JS bundle.
- Compute the SRI hash (`sha384`) of the bundle output.
- Write the hash to `dist/widget-sri.json` so the API can serve it in generated embed codes without hardcoding.

**`infra/vault/seed-secrets.dev.sh`** — add one new vault_write block:
```bash
# ── App: Widget ───────────────────────────────────────────────────────────────
WIDGET_SIGNING_SECRET="dev-widget-$(openssl rand -base64 24 | tr -d '/+=')"
TURNSTILE_SITE_KEY="<dev-turnstile-site-key>"       # from Cloudflare dashboard
TURNSTILE_SECRET_KEY="<dev-turnstile-secret-key>"   # from Cloudflare dashboard
vault_write "app/widget/config" \
  "{\"signing_secret\": \"${WIDGET_SIGNING_SECRET}\",
    \"turnstile_site_key\": \"${TURNSTILE_SITE_KEY}\",
    \"turnstile_secret_key\": \"${TURNSTILE_SECRET_KEY}\",
    \"turnstile_fallback_site_key\": \"${TURNSTILE_SITE_KEY}\",
    \"turnstile_fallback_secret_key\": \"${TURNSTILE_SECRET_KEY}\"}"
```

**`infra/vault/seed-secrets.prod.sh`** — same block with production-strength entropy:
```bash
WIDGET_SIGNING_SECRET="$(openssl rand -base64 40 | tr -d '/+=')"
# Turnstile keys must be set manually — get them from the Cloudflare dashboard
```

**`scripts/generate-runtime-env.sh`** — add a `vault_field` block to read widget secrets and write them to the runtime env file:
```bash
WIDGET_SIGNING_SECRET="$(vault_field "app/widget/config" "signing_secret")"
TURNSTILE_SITE_KEY="$(vault_field "app/widget/config" "turnstile_site_key")"
TURNSTILE_SECRET_KEY="$(vault_field "app/widget/config" "turnstile_secret_key")"
```

**`scripts/list-secrets.sh`** — add `"app/widget/config"` to the `PATHS` array.

**`scripts/rotate-secret.sh`** — add `"app/widget/config"` to the `ALL_PATHS` array in the `ROTATE_ALL` block.

### Vault Secret Path for Widget

```
platform/dev/app/widget/config
  signing_secret            — HMAC secret for opaque session token signing
  turnstile_site_key        — Cloudflare Turnstile public site key (safe to expose)
  turnstile_secret_key      — Cloudflare Turnstile server-side validation key
  turnstile_fallback_site_key    — Platform-provided fallback (for customers without their own)
  turnstile_fallback_secret_key  — Platform-provided fallback secret

platform/prod/app/widget/config
  (same fields, production values)
```

Rotating the widget signing secret (e.g. after a suspected token leak) invalidates all active visitor sessions. Use `scripts/rotate-secret.sh` with `SECRET_PATH=app/widget/config SECRET_FIELD=signing_secret`, then restart `api-gateway` and `workflow-service`.

---

## Scalability Architecture

The widget is designed to scale horizontally from day one. Increasing capacity requires adding more instances, not changing code.

### Stateless API Gateway

The API gateway has no local state. All session, rate limit, and nonce data lives in Redis. Any number of API gateway instances can run behind a load balancer and handle any request from any visitor.

```
Browser visitor
    ↓ public HTTPS (TLS only)
nginx ingress / Cloudflare
    ↓
api-gateway (1..N instances, stateless)   ← add instances freely
    ↓ mTLS (@platform/tls-runtime)
workflow-service (1..N instances, stateless)
    ↓ mTLS
Dify API  ←  scales independently

Shared state (all instances read/write same store):
  Redis Cluster       ← sessions, rate limits, nonces
  PostgreSQL          ← primary + read replicas
  RabbitMQ            ← widget events (lead.created, session.started)
  OpenSearch          ← logs (via logging-service)
```

### Scaling Dimensions

| What is bottlenecked | How to scale |
|---|---|
| API Gateway CPU / connection count | Add more gateway instances behind the load balancer |
| Redis memory / throughput | Scale Redis vertically or switch to Redis Cluster |
| Database read load | Add PostgreSQL read replicas; route read queries to replicas |
| Dify / RAG throughput | Scale Dify independently; multiple Dify instances load-balanced |
| Widget static assets | CDN handles this; no server scaling needed |
| SSE streaming connections | Gateway instances are connection-limited; add more instances |

### No Shared In-Process State

No caching, no counters, no queues live in process memory. Everything is in Redis or the database. This is a hard rule — any future developer adding an in-process cache must be redirected to Redis.

### Workflow Service Scaling

The workflow service handles RAG orchestration. It is also stateless. Multiple instances can run in parallel. Long-running SSE streams hold a connection but not a lock on the workflow service — Dify handles the actual work.

### Database Schema Designed for Scale

- All `WidgetSession` lookups use the opaque token hash as the primary key — single-row lookups, no table scans.
- All `WidgetLead` and `WidgetSession` tables are partitioned by `deployment_id` to allow future per-customer data isolation.
- Rate limit counters live in Redis, never in the database.

### Capacity Increase Procedure

When more capacity is needed, the only steps are:

1. Add more API gateway instances (horizontal pod scale in Kubernetes, or add containers).
2. Confirm `GET /widget/v1/health` returns 200 on new instances.
3. Load balancer routes traffic to new instances automatically.

No code change, no config file change, no restart of existing instances required.

---

## Module Structure and File Separation

The `main.ts` entry point in both `api-gateway` and `workflow-service` must remain minimal — bootstrap only. All logic lives in feature modules. This prevents the "big main file" problem and makes the codebase navigable.

### Rule: main.ts is Bootstrap Only

The `main.ts` files in `api-gateway` and `workflow-service` are already large. The widget implementation must not make them larger. Widget routes and service logic are registered as **Fastify plugins** and kept in their own files.

`main.ts` does exactly three things:
1. Create the Fastify instance and load config.
2. Register plugins (routes, hooks, decorators).
3. Start listening on the port.

No inline route handlers, no business logic, no inline middleware in `main.ts`.

### api-gateway — Widget Files to Add

The api-gateway uses Fastify. Widget routes are registered as a Fastify plugin, following the same pattern as all existing route groups.

```
apps/api-gateway/src/
  main.ts                          ← already exists — register widget plugin here only
  widget/
    widget.plugin.ts               ← Fastify plugin: registers all /widget/v1/* routes
    widget-public.routes.ts        ← public routes (no Keycloak JWT required)
    widget-admin.routes.ts         ← admin routes (requireAnyRole from @platform/auth)
    widget-session.hook.ts         ← Fastify preHandler: validates opaque session token
    widget-origin.hook.ts          ← Fastify preHandler: CORS origin check vs verified domains
    widget-ratelimit.hook.ts       ← Fastify preHandler: Redis sliding-window rate limits
    widget.schema.ts               ← Fastify JSON schemas for all request/reply bodies
```

All hooks follow the existing Fastify `addHook('preHandler', ...)` pattern already used in main.ts for JWT validation. Schemas use the existing Fastify schema validation pattern already used for all other routes.

### workflow-service — Widget Files to Add

The workflow-service is where RAG orchestration lives. Widget service files sit alongside the existing rag-chat, prompt-template, and dify-config modules.

```
apps/workflow-service/src/
  main.ts                          ← already exists — add widget HTTP routes here as plugin
  widget/
    widget-deployment.service.ts   ← deployment CRUD, KB mapping, domain verification
    widget-session.service.ts      ← session create / validate / idle-expire / revoke
    widget-lead.service.ts         ← lead create / anonymize / delete / CSV export
    widget-rag.service.ts          ← RAG call for widget channel (wraps existing RAG pipeline)
    widget-stream.service.ts       ← SSE streaming adapter for Dify streaming responses
    widget-events.ts               ← RabbitMQ event publishing (lead.created, session.started, etc.)
```

There are no new `dify.client.ts` or `redis.client.ts` files — these already exist in the workflow-service and are imported directly.

### packages/ — Widget Additions

```
packages/contracts/src/
  widget.ts                        ← WidgetDeployment, WidgetSession, WidgetLead, WidgetMode
                                      types shared between api-gateway and workflow-service
                                      Add "widget" to existing ChannelOrigin union type

packages/db/prisma/schema.prisma   ← add WidgetDeployment, WidgetDeploymentKb,
                                      WidgetAllowedDomain, WidgetLead, WidgetSession models
                                      ChannelChatThread already exists — add origin "widget" value
```

### Web App — Widget Pages to Add

Widget management sits in the existing `(platform)` route group alongside `/chat-channels`. Components use `@platform/ui-kit` exclusively — no second component library.

```
apps/web/src/app/
  (platform)/
    widgets/
      page.tsx                     ← widget list (table of deployments)
      new/
        page.tsx                   ← 3-stage creation wizard
      [id]/
        page.tsx                   ← edit deployment (appearance, timers, KBs, domains)
        leads/
          page.tsx                 ← leads table, transcript view, CSV export
        health/
          page.tsx                 ← health panel, recent errors, latency, logs
  components/
    widget/                        ← all use @platform/ui-kit base components
      WidgetWizard.tsx
      WidgetPreview.tsx            ← live widget bundle iframe preview
      DomainVerificationPanel.tsx
      EmbedCodeBlock.tsx           ← syntax-highlighted code + one-click copy
      LeadsTable.tsx
      HealthPanel.tsx
```

Navigation sidebar entry — add to existing Workspace Section in `navigation-sidebar.tsx`:

```
/widgets    ← after /chat-channels
```

---

## Documentation Requirements

These documents must be created or updated as part of the widget implementation. Documentation is not optional and is not deferred to after launch.

### Documents to Create

| Document | Location | Purpose |
|---|---|---|
| `docs/widget/setup-guide.md` | Repo | Customer-facing: how to embed and configure the widget step by step |
| `docs/widget/api-reference.md` | Repo | Developer-facing: all public widget API endpoints, request/response shapes, error codes |
| `docs/widget/mcp-design.md` | Repo | Future MCP tool definitions, resource URIs, and authentication model |
| `docs/widget/security-model.md` | Repo | How sessions, CORS, replay protection, and rate limits work — for security review |
| `docs/widget/env-vars.md` | Repo | Complete environment variable reference with type, default, and valid range |
| `docs/runbooks/widget-deploy.md` | Repo | Step-by-step: how to deploy, promote env, rollback |
| `docs/runbooks/widget-incident.md` | Repo | How to diagnose: Dify circuit open, rate limit storm, domain verification failure |
| `.env.example` | Repo root | All env vars listed with descriptions, no real values |

### Documents to Update

| Document | Update Required |
|---|---|
| `README.md` | Add widget feature to project overview, link to setup guide |
| `PRODUCTION_MIGRATION.md` | Add widget section covering: new Vault secrets to seed (`app/widget/config`), new n8n workflows to import, new Prisma migration that runs automatically, and post-deploy smoke test (load widget on verified domain, send a test message) |
| `docs/plans/chatwidget.md` | This document — update as decisions are confirmed during implementation |
| `CHANGELOG.md` | Add widget V1 release entry when shipped |

### API Reference Format

The `api-reference.md` must document every public endpoint with:

- Method and path
- Request headers required
- Request body schema (JSON example)
- Response body schema (JSON example)
- All possible error codes and what they mean
- Rate limit behaviour
- Example `curl` command

This doubles as the MCP tool documentation when MCP support is added — the same inputs and outputs map directly to MCP tool arguments and results.

---

## Production Readiness Requirements

These must be satisfied before the widget is opened to real customer traffic.

### Loader and CDN

- Loader script is served from a CDN with a versioned path: `/widget/v1/loader.js`.
- Embed code includes a Subresource Integrity (`integrity="sha384-..."`) hash generated at each release.
- Full widget bundle is lazy-loaded by the loader after the launcher icon is visible, never blocking page load.
- Hard bundle size budget: loader + skeleton under 30 KB gzipped; full chat UI under 100 KB gzipped.
- CDN cache is invalidated on every widget release; loader itself should have short TTL (5 minutes) so customers pick up security patches quickly.

### Graceful Degradation

- If the widget bundle fails to load (CDN error, network timeout), the launcher shows a static "Contact us" fallback with a configured email or URL.
- If Dify streaming fails mid-response, the partial response is displayed and an error message is appended: `There was a problem completing this answer. Please try again.`
- If Redis is unavailable, the widget endpoint returns 503 with a friendly error rather than crashing or leaking internal errors.

### Circuit Breaker for Dify

- If Dify returns errors above a configurable threshold (default: 5 errors in 10 seconds), open the circuit and return a queued fallback message immediately rather than hanging visitor requests.
- Circuit half-opens after a configurable recovery window (default: 30 seconds).
- Dashboard health panel shows current circuit state.

### Zero-Downtime Deployment

- Widget deployments (code releases) must not interrupt in-flight SSE streams.
- Use graceful drain: stop accepting new connections on the old instance, allow existing streams up to 60 seconds to complete before shutdown.
- Redis session state is independent of any single API gateway instance; rolling deploys do not invalidate active visitor sessions.

### Database Migrations

- All schema changes for widget entities (`WidgetDeployment`, `WidgetSession`, etc.) ship as backwards-compatible migrations so old and new API gateway instances can run simultaneously during a rolling deploy.
- No destructive column drops in V1 migrations.

### Health and Readiness

- `GET /widget/v1/health` returns 200 with `{ status: "ok", dify: "ok"|"degraded", redis: "ok"|"degraded" }`.
- Kubernetes/deployment readiness probe uses this endpoint.
- Liveness probe checks that the process is not deadlocked.

### Horizontal Scaling

- The API gateway handling widget traffic is stateless; all session state lives in Redis.
- Rate limiting counters use Redis atomic operations and are consistent across all instances.
- Streaming SSE connections are sticky to one instance via load balancer session affinity (not required for correctness but improves streaming efficiency).

### Secrets Management

- Turnstile secret key, widget signing secret, and Dify API keys are injected via environment variables or a secrets manager (Vault/K8s secrets), never hardcoded or committed.
- Widget public key is safe to expose in browser; widget signing/validation secret is never exposed.

### Input Limits (Required for Production)

- Visitor message max length: 2000 characters, enforced at frontend and backend.
- Lead name max: 100 characters.
- Lead email validated server-side with strict RFC 5322 pattern.
- Domain hostname max: 253 characters.

### PII Handling

- Visitor messages are scanned for common PII patterns (credit card numbers, social security, passwords) by the input guard before storage or forwarding to Dify.
- PII detections are logged as security events but the raw detected value is not logged.
- Name and email in `WidgetLead` are encrypted at rest using the platform's key management strategy.

### "Powered by RapidRAG" Footer

- Every widget view renders a non-removable `Powered by RapidRAG` footer link.
- The link points to `https://rapidrag.ai` and opens in a new tab.
- Clicking it does not interrupt the active visitor session.
- The footer is part of the widget bundle, not injected by the host page, so it cannot be suppressed by CSS overrides from the customer site.

---

## Acceptance Tests

- Customer can create widget from frontend.
- Customer can choose lead-capture widget mode.
- Customer can choose quick-start widget mode.
- Customer can configure header title and icon/avatar.
- Customer can assign multiple KBs to one widget.
- Customer can verify domain by file method.
- Customer can verify domain by DNS TXT method.
- Customer can verify domain by meta tag method.
- Widget cannot activate without verified domain.
- Widget cannot activate without at least one KB.
- Dashboard preview works before embed.
- Dashboard generates embed code and CSP guidance.
- Widget loads on verified domain.
- Widget fails on unverified domain.
- Lead form requires name, email, agreement, and Turnstile.
- Quick-start widget starts chat without name, email, or captcha.
- Quick-start widget still enforces verified domain, opaque session token, CORS, replay protection, and rate limits.
- Multiple visitors on same website get separate chat threads.
- Same tab page navigation keeps active chat history.
- New tab starts separate session.
- Idle warning appears after 5 idle minutes by default.
- Session expires after 10 idle minutes by default.
- Customer-configured timer values are reflected in widget config.
- Session max lifetime is enforced.
- Browser-supplied KB IDs cannot alter mapped KB access.
- Streaming widget endpoint emits answer chunks and completes cleanly.
- Streaming route handles timeout/error with friendly UI.
- CORS rejects non-verified origins.
- Duplicate nonce replay is rejected.
- Rate limits return `429`.
- Dify/RAG failure returns friendly widget error.
- Leads and transcripts appear in dashboard.
- CSV export works.
- Delete/anonymize lead actions work.
- Debug mode logs useful non-secret widget diagnostics.
- Widget health panel shows recent errors and latency.
- Domain verification failure displays actionable diagnostics.

- Widget footer shows "Powered by RapidRAG" link on every chat view.
- Footer link cannot be hidden by customer CSS overrides.
- Visitor message over 2000 characters is rejected with a clear error.
- Widget bundle loads under 100 KB gzipped.
- GET /widget/v1/health returns correct Dify and Redis status.
- Rolling deploy does not drop active SSE streams.
- Dify circuit breaker opens after threshold errors and closes after recovery window.
- Redis unavailability returns 503, not an unhandled error.
- Embed SRI hash is present and verified by browser.

---

## Constraints For Implementation

- This plan is documentation only until implementation begins.
- Do not expose API keys, OAuth secrets, Turnstile secrets, or Dify credentials to browser code.
- Do not allow widgets on unverified domains.
- Do not allow browser-controlled KB selection during chat.
- Do not keep visitor sessions open forever.
- Do not use wildcard CORS for widget endpoints.
- Do not require lead form or captcha in quick-start mode.
- Scope streaming to the new widget endpoint first; do not force existing web chat or Slack to migrate in V1.
- All widget logic must live in service layer methods, not inline in HTTP route handlers, so MCP adapters can call the same logic without HTTP context.
- Do not hardcode any consumer-specific assumptions (widget, Slack, MCP) into `RagQueryService` or `SessionService`.
- Do not remove or rename any V1 public API endpoint path without incrementing the API version prefix.
- "Powered by RapidRAG" footer is non-removable in V1 and must be rendered by the widget bundle itself.
- Do not hardcode any domain, URL, or environment-specific value in source code. All such values must come from environment variables.
- The widget loader must derive its API base URL from its own script `src` origin at runtime, never from a hardcoded string.
- `localhost` and `127.0.0.1` as allowed widget domains must be gated on `NODE_ENV=development` only — not on a separate code path or config flag.
- Database migrations must run automatically on container start, not as a manual step.
- Moving between environments (dev → staging → production) must require only environment variable changes and domain DNS updates. Any code change required for promotion is a constraint violation.
