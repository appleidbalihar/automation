# Service Status

| Service | Status | Scope in this milestone |
| --- | --- | --- |
| web | Implemented (v1 core + replatform baseline) | Enterprise shell, role-aware navigation, route-level auth gate with Keycloak sign-in, self-registration defaulting to `useradmin`, integrations page, profile page, users page, security page, secrets page, React Flow workflow builder with canonical flow payload + admin reset controls, orders/approval/log UX |
| api-gateway | Implemented (v1 core) | Public API routing to workflow/order/execution/integration/logging services, RBAC enforcement, dependency/readiness health checks, certificate monitoring + rotation control APIs, admin Vault secret passthrough APIs |
| workflow-service | Implemented (v1 core + replatform baseline) | Workflow CRUD/publish/versioning, canonical flow validation + publish gate, planner draft endpoint (Flowise-backed), integration/environment CRUD + sharing + duplicate + usage safety checks, owner/shared scope enforcement, workflow event publishing, publish-audit persistence, Vault-only secret policy + migration endpoint, admin workflows/orders reset APIs |
| order-service | Implemented (v1 core + replatform baseline) | Order execute/get/list/approvals/retry/rollback and approval actions, canonical flow runtime conversion, Temporal-backed execution dispatch with existing status/checkpoint/audit persistence, RabbitMQ domain event publishing, owner-scope enforcement for non-admin users |
| execution-engine | Implemented (v1 core) | Workflow validation and checkpoint-aware execution orchestration delegated to integration-service with timestamped step audit payloads |
| integration-service | Implemented (v1 core) | REST/SSH/NETCONF/SCRIPT adapters with policy controls, Vault-only secret references, env template interpolation, OAuth2 token retrieval/cache, payload masking, audit emission |
| logging-service | Implemented (v1 core) | Ingest/query/timeline APIs with recursive masking, correlation-aware filtering, and RabbitMQ event consumption |

## Deployment mode
- All services run in Docker Compose with a containerized app tier (`web`, `api-gateway`, `workflow-service`, `order-service`, `execution-engine`, `integration-service`, `logging-service`) plus containerized infra dependencies.
- Automated certificate/key lifecycle is wired through Vault PKI bootstrap + per-service Vault Agent rendering into `/tls/*`, and backend services expose TLS runtime diagnostics via `/security/tls`.
- Rotation controller remains the renewal/recycle orchestrator and uses the shared control queue (`/rotation-control/requests.jsonl`).
- Secure-only deployment defaults are enabled: HTTPS service URLs and TLS-enabled infra listener configs are part of the compose baseline.
- Offline production deployment path is available via GitLab Container Registry images and `docker-compose.prod.yml` (no `build:` steps, no internet pulls from public registries).
- Replatform stack additions are wired in compose: self-managed Temporal (`temporal`, `temporal-ui`, `temporal-postgres`) and Flowise planner service (`flowise`).
