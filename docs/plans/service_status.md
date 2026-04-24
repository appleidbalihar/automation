# Service Status

| Service | Status | Scope in this milestone |
| --- | --- | --- |
| web | Implemented | Enterprise shell, role-aware navigation, route-level auth gate with Keycloak sign-in, Operations AI (Dify), logs, profile, users, security, and secrets pages |
| api-gateway | Implemented | Public API routing to workflow/logging services, RBAC enforcement, dependency/readiness health checks, certificate monitoring + rotation control APIs, admin Vault secret passthrough APIs, Dify/n8n proxy routes |
| workflow-service | Implemented | Operations AI discussion persistence, Dify/n8n orchestration, Vault secret management endpoints, and retained security/admin utilities |
| logging-service | Implemented (v1 core) | Ingest/query/timeline APIs with recursive masking, correlation-aware filtering, and RabbitMQ event consumption |

## Deployment mode
- All services run in Docker Compose with a containerized app tier (`web`, `api-gateway`, `workflow-service`, `logging-service`) plus containerized infra dependencies.
- Automated certificate/key lifecycle is wired through Vault PKI bootstrap + per-service Vault Agent rendering into `/tls/*`, and backend services expose TLS runtime diagnostics via `/security/tls`.
- Rotation controller remains the renewal/recycle orchestrator and uses the shared control queue (`/rotation-control/requests.jsonl`).
- Secure-only deployment defaults are enabled: HTTPS service URLs and TLS-enabled infra listener configs are part of the compose baseline.
- Offline production deployment path is available via GitLab Container Registry images and `docker-compose.prod.yml` (no `build:` steps, no internet pulls from public registries).
- Flowise remains wired in compose as the Operations AI backend.
