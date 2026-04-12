# Master Implementation Plan

## Current milestone
- Milestone 3: Automated PKI, cert rotation, and secure internal runtime hardening.

## Completed
- Greenfield repository initialized.
- Shared contracts package with workflow/order/checkpoint/event models.
- Shared execution engine package with checkpoint resume logic.
- Prisma schema for workflows, versions, orders, checkpoints, transitions, step execution, logs, and chat history.
- Service skeletons created for all planned microservices.
- Enterprise web shell created with two-panel layout and operations-focused dashboard placeholders.
- Gateway forwarding to workflow/order/logging/chat/rag services plus dependency health checks.
- Integration adapters implemented for REST/SSH/NETCONF/SCRIPT with policy controls, secret masking, and Vault/env secret references.
- Logging service enhanced with correlation-aware log filtering and timeline retrieval API.
- RabbitMQ event pipeline added for order/execution lifecycle publication and asynchronous logging ingestion.
- Added workflow publish and RAG index event publication to RabbitMQ with tested event envelope delivery contract.
- Implemented dedicated workflow/RAG event workers with durable worker-state persistence and status query endpoints.
- Implemented real v1 RAG indexing persistence (`RagDocument`) with worker-driven ingestion and gateway-level smoke validation.
- Added web operations panels for publish audits and RAG jobs plus gateway recovery smoke for execute/rollback/retry timeline verification.
- Hardened gateway auth to support Keycloak JWT verification with RBAC role extraction.
- Moved web operations auth to token-driven identity (`/auth/me`) and gated legacy bearer parsing behind explicit `AUTH_ALLOW_LEGACY_BEARER=true`.
- Replaced workflow builder placeholder with interactive v1 UI for node/step draft composition, save-as-new workflow, publish-selected workflow, and version visibility.
- Added order execution console and approval queue v1 UX with tracked-order status/checkpoint/failure view, timeline retrieval, and retry/rollback controls.
- Added RBAC + resume end-to-end smoke suite (`smoke:rbac`) covering gateway role enforcement and retry resume pointer correctness.
- Added backend order and approval listing APIs (`GET /orders`, `GET /orders/approvals`) and migrated web approval queue from tracked-local mode to backend-driven listing.
- Implemented full approval lifecycle with persistent decisions (`ApprovalDecision`), request/approve/reject APIs, engine `PENDING_APPROVAL` behavior, and UI decision actions.
- Upgraded execution-engine from skeleton to functional service with workflow validation and checkpoint-aware run execution via integration-service.
- Hardened chat-service with strict operational guardrails and context-aware responses using live order/workflow state.
- Added final validation polish with dedicated `smoke:engine`, consolidated `smoke:all`, and chat-service unit tests for guardrails/context generation.
- Fully containerized the app tier and infrastructure stack in Docker Compose, including db migration bootstrap and container-to-container service discovery defaults.
- Shifted runtime execution to true service chaining (`order-service -> execution-engine -> integration-service`) with persisted checkpoint/audit payload history and timestamped step records.
- Implemented real retry execution (immediate resume run) and rollback-action execution for completed reversible steps, with partial rollback reporting when needed.
- Added real web Keycloak sign-in flow and route-level session gating, removing reliance on manual token paste for normal operation.
- Hardened gateway JWT validation for mixed issuer environments (internal Docker URL + public URL), with explicit client-binding checks.
- Introduced `useradmin` role model (with legacy `operator` compatibility alias), changed registration default role to `useradmin`, and added Keycloak bootstrap role entry.
- Added Keycloak-backed profile and platform-admin user lifecycle surfaces (`/profile`, `/users`) with server-side user/password management APIs.
- Enforced non-admin ownership scope in order-service and workflow-service list/query paths for owner/shared visibility boundaries.
- Added shared `@platform/tls-runtime` package for cert hot-reload, outbound TLS dispatcher refresh, AMQP TLS options, and service TLS diagnostics.
- Wired backend services to consume TLS runtime env contract and expose `/security/tls` diagnostics.
- Switched internal service routing URLs in compose to HTTPS for backend service-to-service calls.
- Replaced Vault dev-only mode with persistent Vault server + idempotent PKI bootstrap job and AppRole generation.
- Added Vault Agent sidecars for backend services to auto-render and renew cert/key/CA files under `/tls`.
- Added automated rotation-controller service scaffold for infra container recycle paths.
- Added developer/operations docs for TLS rotation runtime behavior and operations workflows.

## In progress
- Hardening infra dependency native TLS enablement path (PostgreSQL/RabbitMQ/Redis/Keycloak/MinIO/OpenSearch) beyond app-plane TLS baseline.

## Next resume point
- Restart stack with rebuild (`pnpm compose:up --build`), confirm `vault-bootstrap` completion, then validate `/security/tls` on each backend service and run smoke suites.
