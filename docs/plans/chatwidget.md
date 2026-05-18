# Website Chat Widget V1 Plan

This is a planning/specification document only. It describes the intended Website Chat Widget design and does not represent an implemented feature yet.

## Summary

RapidRAG will provide a plug-and-play website chat widget that customers configure from the RapidRAG frontend. A customer can create and sync one or more knowledge bases, create a widget deployment, assign the relevant KBs, verify their website domain, customize the widget, and copy an embed script into their website.

The widget will collect visitor lead details before chat starts, then answer visitor questions using only the KBs assigned to that widget. All RAG calls remain backend-only; no Dify keys, OAuth tokens, or secret API keys are exposed in browser code.

## Customer Setup Flow

1. Customer logs in to RapidRAG using the existing dashboard authentication.
2. Customer creates or syncs the KBs they want to expose, such as a product FAQ, shipping policy, or warranty KB.
3. Customer opens the Website Widget setup area from the frontend.
4. Customer creates a widget deployment and gives it a name.
5. Customer selects one or more KBs to attach to the widget.
6. Customer adds one or more allowed website domains.
7. Customer verifies each domain.
8. Customer configures widget appearance, privacy policy URL, and session timers.
9. Customer activates the widget.
10. RapidRAG shows the embed code.
11. Customer pastes the embed code into their website before the closing `</body>` tag.
12. Customer publishes the website and sends a test question.

Example embed code:

```html
<script
  async
  src="https://rapidrag.ai/widget/loader.js"
  data-widget-key="pub_wdg_xxxxx"
  data-theme="light">
</script>
```

The embed code is generated in the RapidRAG dashboard. Customers do not need GitHub to get the widget code. GitHub may be used as a KB source, but widget setup happens in the frontend.

## Knowledge Base Binding

Each widget deployment can be assigned to multiple KBs. The browser must never choose which KBs to query during a visitor chat session.

Backend rules:

- Store widget-to-KB mappings on the server.
- Resolve mapped KBs from the deployment on every message.
- Ignore or reject any browser-supplied KB IDs.
- Use the same guarded RAG pipeline already used by existing chat channels.
- Keep Dify API keys and KB secrets server-side only.

## Domain Verification

A widget cannot be activated until at least one domain is verified.

Supported verification methods:

1. File-based verification, preferred:
   - Customer places a RapidRAG verification file at:
     `https://customer-domain.com/.well-known/rapidrag-verify.txt`
   - The file contains the generated verification token.
   - RapidRAG fetches the file and compares the token.

2. DNS TXT verification, fallback:
   - Customer adds a TXT record such as:
     `_rapidrag-verify.customer-domain.com`
   - The TXT value contains the generated verification token.
   - RapidRAG performs DNS lookup and compares the token.

Domain matching should be exact by default. If subdomains are supported later, they should be explicit or controlled by a deliberate `allowSubdomains` setting after root-domain verification.

## Visitor Flow

V1 uses a lead form before chat starts.

Visitor steps:

1. Visitor opens the widget.
2. Widget displays the lead form.
3. Visitor enters name and email.
4. Visitor checks the agreement/privacy consent checkbox.
5. Visitor completes captcha/not-robot verification.
6. Backend creates a lead, chat thread, and signed session token.
7. Visitor can send messages.
8. RapidRAG answers from the widget's assigned KBs only.

Consent requirements:

- The agreement checkbox is mandatory.
- The widget should link to the customer's privacy policy URL configured during setup.
- Backend stores the consent timestamp with the lead/session.

## Authentication Model

The public website widget does not use OAuth and does not expose secret API keys.

Authentication layers:

- Customer admin dashboard: existing RapidRAG/Keycloak login.
- Widget embed: public publishable widget key.
- Visitor session: signed short-lived session token issued after domain, lead form, consent, captcha, and rate-limit checks pass.
- Future enterprise mode: optional customer backend signs sessions with a secret API key.

Session token claims should include:

```json
{
  "deploymentId": "wdg_123",
  "visitorId": "lead_456",
  "threadId": "thread_789",
  "originDomain": "customer-domain.com",
  "iat": 1234567890,
  "exp": 1234567890
}
```

Every message request must validate:

- token signature
- token expiry
- deployment is active
- origin domain is still verified
- thread belongs to visitor
- visitor belongs to deployment
- session has not been idle-expired or manually ended

## Multiple Visitors On The Same Website

Many visitors can use the same widget at the same time. Each visitor gets an isolated session.

Isolation model:

- Same widget deployment can have many visitor sessions.
- Each visitor gets a unique lead record.
- Each visitor gets a unique session token.
- Each visitor gets a unique chat thread.
- Each mapped KB gets its own conversation/session state as needed.

No chat history or Dify conversation context should be shared between visitors.

Example:

```text
Customer website
  -> Widget deployment: Product FAQ Widget
      -> Visitor session A: John / john@example.com
      -> Visitor session B: Sara / sara@example.com
      -> Visitor session C: Mike / mike@example.com
```

## Session Storage And Navigation

Use `sessionStorage` for the browser-side active widget session.

Behavior:

- Same tab and same verified website: keep the session while it is active.
- Page reload in the same tab: restore the active session if not expired.
- Same-site navigation in the same tab: keep history if the session is not expired.
- New browser tab: start a separate session and require the lead form again.
- Different browser or device: start a new session.
- Tab close: browser-side active session is gone, though backend lead/chat history remains until retention cleanup.

This avoids keeping sessions open forever and prevents accidental cross-tab sharing.

## Configurable Session Timers

Timer values must be configurable by customer during widget integration so code changes are not needed for different customer preferences.

Default settings:

- Idle timeout: `10 minutes`
- Idle warning: after `5 minutes` idle, warn that the session will expire in 5 more minutes
- Maximum session lifetime: `24 hours`
- Lead/chat retention: `90 days`

Recommended validation ranges:

- Idle timeout: `5` to `120` minutes
- Idle warning: `1` to `30` minutes and less than idle timeout
- Maximum session lifetime: `1` to `168` hours
- Lead/chat retention: `7` to `365` days

Timer behavior:

- Reset idle timer when the visitor sends a message, receives an answer, types, or interacts with the widget.
- Show a warning after the configured idle-warning threshold.
- If the visitor interacts after warning but before expiry, continue the same session.
- If the idle timeout is reached, expire the session and require a new lead/session before more chat.
- Backend enforces idle timeout and max lifetime on every message.

Default visitor warning text:

```text
Your chat session will expire in 5 minutes due to inactivity.
```

Default expired text:

```text
Your chat session has expired. Please start a new chat to continue.
```

## Public Widget APIs

Public endpoints are unauthenticated by user login, but must be protected by widget key, verified origin, signed session tokens, captcha, replay checks, and rate limits.

Planned endpoints:

- `GET /widget/v1/config/:publicKey`
  - Returns widget settings such as theme, welcome message, privacy policy URL, captcha site key, and timer config.

- `POST /widget/v1/init`
  - Accepts public widget key, visitor name, email, consent flag, captcha token, and origin.
  - Validates domain, captcha, consent, and rate limits.
  - Creates lead and thread.
  - Returns signed session token.

- `POST /widget/v1/message`
  - Accepts session token, message, nonce, and timestamp.
  - Validates token, origin, nonce, replay window, rate limits, and session timers.
  - Sends the message through the backend RAG pipeline.

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
- `GET /widgets/deployments/:id/leads`
- `GET /widgets/deployments/:id/leads.csv`
- `DELETE /widgets/deployments/:id/leads/:threadId`

Activation must require:

- at least one verified domain
- at least one mapped KB
- valid lead form settings
- valid privacy policy/consent configuration
- captcha configuration available through customer-provided or platform-default keys

## Backend Security Requirements

Origin and CORS:

- Check `Origin` first, with `Referer` as fallback where appropriate.
- Match the request origin against verified domains for the deployment.
- Return `Access-Control-Allow-Origin` only for the verified requesting origin.
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
- Return `429` with `Retry-After` when limits are exceeded.

Recommended starting limits:

- Per IP session creation: 3 to 20 per hour, tier configurable.
- Per IP messages: 60 per minute.
- Per session token: 30 messages per minute.
- Per deployment sessions: configurable by customer tier.
- Per deployment messages: configurable by customer tier.

RAG safety:

- Reuse input guard.
- Reuse output gate.
- Reuse zero-retrieval handling.
- Reuse hallucination guard.
- Log widget RAG events with deployment and session context.
- Return a friendly error if Dify/RAG fails.

Default failure text:

```text
I am having trouble answering right now. Please try again later or contact support.
```

## Customer Dashboard

The frontend should provide:

- widget list
- create/edit wizard
- KB multi-select
- domain verification instructions
- activation/deactivation controls
- embed code copy block
- theme and appearance settings
- privacy policy URL setting
- captcha configuration status
- configurable session timers
- leads table
- transcript view
- CSV export
- delete or anonymize lead data

Lead table columns:

- name
- email
- domain
- first seen
- last message
- message count
- status
- actions

CSV export should include:

- name
- email
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

Planned entities:

- `WidgetDeployment`
  - owner, name, status, public widget key, settings, timer config, retention config.

- `WidgetDeploymentKb`
  - many-to-many mapping between widget deployment and KBs.

- `WidgetAllowedDomain`
  - hostname, verification token, verification method, verified timestamp, optional subdomain policy.

- `WidgetLead`
  - deployment, thread/session references, name, email, consent timestamp, timestamps, anonymization/deletion state.

- `ChannelChatThread`
  - reuse existing generic channel history with origin `"widget"`.

- `ChannelChatMessage`
  - reuse existing generic message history.

- `ChannelChatKbSession`
  - reuse existing per-KB conversation/session mapping.

PII such as name and email should be protected at rest according to the platform's eventual encryption strategy.

## Future Enterprise Mode

V1 should not require customer backend work. A future enterprise mode can allow customer servers to sign widget sessions with a secret API key.

Enterprise mode can support:

- customer-authenticated visitors
- server-signed visitor identity
- bypassing captcha for trusted users
- stronger request signing
- CRM/customer-user correlation

This should be additive and should not be required for the default plug-and-play widget.

## Acceptance Tests

- Customer can create a widget from the frontend.
- Customer can assign multiple KBs to one widget.
- Customer can verify a domain by file method.
- Customer can verify a domain by DNS TXT method.
- Widget cannot activate without a verified domain.
- Widget cannot activate without at least one KB.
- Dashboard generates embed code.
- Widget loads on a verified domain.
- Widget fails on an unverified domain.
- Lead form requires name, email, agreement, and captcha.
- Multiple visitors on the same website get separate chat threads.
- Same tab page navigation keeps active chat history.
- New tab starts a separate session.
- Idle warning appears after 5 idle minutes by default.
- Session expires after 10 idle minutes by default.
- Customer-configured timer values are reflected in widget config.
- Session max lifetime is enforced.
- Browser-supplied KB IDs cannot alter mapped KB access.
- CORS rejects non-verified origins.
- Duplicate nonce replay is rejected.
- Rate limits return `429`.
- Dify/RAG failure returns a friendly widget error.
- Leads and transcripts appear in the dashboard.
- CSV export works.
- Delete/anonymize lead actions work.

## Constraints For Implementation

- This plan is documentation only until implementation begins.
- Do not expose API keys, OAuth secrets, or Dify credentials to browser code.
- Do not allow widgets on unverified domains.
- Do not allow browser-controlled KB selection during chat.
- Do not keep visitor sessions open forever.
- Do not use wildcard CORS for widget endpoints.
