# Decision Log

## 2026-04-08
- Use a TypeScript monorepo for all first-phase services and UI.
- Use Docker Compose as the primary local runtime.
- Use PostgreSQL with `pgvector` for operational data and RAG retrieval storage.
- Use Keycloak for v1 OAuth2/OIDC and RBAC.
- Use server-sent events for v1 status streaming.
- Treat execution checkpoints and transition history as first-class persistent entities.

## 2026-04-10
- Keep integration secret handling provider-based with explicit prefixes (`env:`, `vault:`) to avoid accidental resolution of normal colon strings.
- Enforce fail-safe production defaults for non-REST adapter execution via explicit allowlists.
- Add a dedicated timeline API in logging-service that merges transitions, step executions, and logs for deterministic incident reconstruction.
- Use RabbitMQ topic exchange `platform.events` as the first async event backbone; producers are best-effort non-blocking while logging consumer persists masked event copies for recovery.
- Standardize event publisher envelope across services as `{ event, timestamp, payload }` and test publisher delivery contract (routing key + persistent JSON payload) in service-level tests.
- Persist worker processing state in service-owned tables (`WorkflowPublishAudit`, `RagIndexJob`) to make asynchronous automation resumable and auditable after service restarts.
- Use persisted indexed documents (`RagDocument`) as the v1 retrieval source so search quality depends on completed worker jobs and can be validated through gateway smoke tests.
- Add recurring smoke flows (`smoke:vault`, `smoke:rag`, `smoke:recovery`) as resume checkpoints to quickly validate core integration paths after interruptions.
- Validate JWT tokens through Keycloak JWKS in gateway auth while preserving legacy local bearer format for current automation smoke scripts.
- Disable legacy non-JWT bearer parsing by default and require explicit `AUTH_ALLOW_LEGACY_BEARER=true` for local smoke/dev compatibility.
- Implement workflow-builder v1 as save-as-new draft composition + publish-selected flow to match current workflow-service API surface while preserving version history visibility.
- Implement approval queue/execution console v1 as tracked-order workflow derived from `/orders/:id` and `/logs/timeline` until backend list APIs are introduced.
- Standardize RBAC/resume validation in one repeatable smoke checkpoint (`smoke:rbac`) to verify both authorization boundaries and retry resume pointer integrity after interruptions.
- Promote approval/order queue retrieval to backend first-class APIs (`/orders`, `/orders/approvals`) and use them as the source of truth for web console listing.
- Persist approval decisions in a dedicated table and model approval flow via explicit request/approve/reject APIs; approval acceptance resumes execution from checkpoint with approved-node bypass.
- Treat execution-engine as a first-class validation surface by adding dedicated workflow validation and run simulation endpoints over shared engine-core logic.
- Move production step execution to a strict service chain (`order-service -> execution-engine -> integration-service`) and remove local command simulation from order runtime.
- Persist engine-returned step request/response payloads and timestamps in `StepExecution` for incident replay and checkpoint-aware resume auditing.
- Execute retry requests immediately from the stored checkpoint pointer and run rollback actions only for already successful reversible steps, recording partial rollback failures explicitly.
- Keep chat-service operational-only and context-aware by combining strict backend-detail guardrails with live order/workflow status summaries for troubleshooting prompts.
- Standardize final verification with dedicated engine smoke and an aggregated `smoke:all` pipeline to simplify repeatable UAT checks.

## 2026-04-11
- Add a first-class web login path (`/api/auth/token`) and route-level auth gating so platform usage does not depend on manual token copy/paste.
- Keep strict production default `AUTH_ALLOW_LEGACY_BEARER=false` in container runtime; retain legacy bearer only as explicit smoke/dev override.
- Accept both internal and public Keycloak issuer variants during JWT verification and enforce client binding via `azp`/`aud`/`resource_access`.
- Seed Keycloak default user with profile fields (`firstName`, `lastName`, `email`) to avoid direct grant failures (`Account is not fully set up`) on fresh realm imports.
- Resolve `env:` secret references in integration execution against the selected order environment snapshot first, with process env fallback for ops-level variables.
- Compose REST adapter requests from integration profile base config (`baseUrl`, method/headers/query/body defaults), merged credentials, and step input variables so node-level integration assignments are executable without dummy glue data.
- Introduce explicit integration auth types (`OAUTH2`, `BASIC`, `MTLS`, `API_KEY`, `OIDC`, `JWT`) and apply auth-scheme-aware REST request shaping in integration runtime.
- Treat integration/environment sharing as first-class by persisting username-based share records and exposing owned/shared/all list scopes for one-click visibility in UI.
- Block integration deactivate/terminate when referenced by any workflow version and return workflow name/version usage details for operator-safe remediation.
- Standardize platform RBAC around two primary personas: `admin` (platform-admin global control) and `useradmin` (owner/shared scope), while treating legacy `operator` as a compatibility alias to `useradmin` during transition.
- Keep all user lifecycle and password operations Keycloak-managed through server-side APIs only; never expose admin credentials to browser code.
- Default self-registration role to `useradmin` so new users start with self-service resource management privileges instead of platform-wide control.
- Add first-class account pages in web UX: `/profile` for self password changes and `/users` as admin-only Keycloak user LCM console.
- Align node-integration UX with Postman-like auth configuration by using auth-type-specific form fields instead of raw JSON for common modes (`No Auth`, `Basic`, `API Key`, `OAuth2`).
- Resolve `{{variable}}` templates in integration URL/auth fields from selected environment values to support user-friendly endpoint/auth configuration without manual JSON wiring.
- Support OAuth2 v1 through `client_credentials` and `password` grants with integration-service token retrieval and short-lived in-memory token cache reuse across sequential executions.
- Use Vault PKI as the internal certificate authority and bootstrap roles/policies/AppRoles through an idempotent startup job so cert issuance does not require manual operator steps.
- Standardize service TLS runtime with in-process cert/key/CA file watching and secure-context refresh so Node microservices pick rotated material automatically without restart.
- Add per-service Vault Agent sidecars to render short-lived leaf certs to `/tls` volumes and keep renewal continuous.
- Keep `api-gateway` ingress listener on HTTP for current external compatibility while enforcing TLS for downstream internal service calls.
- Add an automated rotation controller for infrastructure containers that need periodic recycle behavior during cert lifecycle operations.
- Move to strict secure-only mode: gateway ingress over HTTPS, web internal gateway proxy over HTTPS, and secure URL defaults (`https/amqps/rediss`) across runtime config.
- Require private CA trust import for client browsers/operators as the default deployment model for internal IP-based access.
- Enable TLS listeners for core infra containers in compose baseline (PostgreSQL, RabbitMQ, Redis, Keycloak, MinIO) and remove plaintext defaults from shared environment contracts.
