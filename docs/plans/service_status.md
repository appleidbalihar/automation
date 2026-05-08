# Service Status

| Service | Status | Scope in this milestone |
| --- | --- | --- |
| web | Implemented | RapidRAG landing page, role-aware platform navigation, Keycloak sign-in, Knowledge Connector, RAG Assistant, AI Agent Prompt templates, RAG stats, logs, profile, users, security, and secrets pages |
| api-gateway | Implemented | Public API routing to workflow/logging services, RBAC enforcement, dependency/readiness health checks, OAuth connect/callback/disconnect, certificate monitoring + rotation control APIs, admin Vault secret passthrough APIs, Dify/n8n proxy routes |
| workflow-service | Implemented | RAG discussion persistence, Dify/n8n orchestration, KB sync/cancel/cleanup/retry, prompt templates, RAG stats, Vault secret management endpoints, and retained security/admin utilities |
| logging-service | Implemented (v1 core) | Ingest/query/timeline APIs with recursive masking, correlation-aware filtering, and RabbitMQ event consumption |

## Deployment mode
- All services run in Docker Compose with a containerized app tier (`web`, `api-gateway`, `workflow-service`, `logging-service`) plus containerized infra dependencies.
- Automated certificate/key lifecycle is wired through Vault PKI bootstrap + per-service Vault Agent rendering into `/tls/*`, and backend services expose TLS runtime diagnostics via `/security/tls`.
- Rotation controller remains the renewal/recycle orchestrator and uses the shared control queue (`/rotation-control/requests.jsonl`).
- Secure-only deployment defaults are enabled: HTTPS service URLs and TLS-enabled infra listener configs are part of the compose baseline.
- Offline production deployment path is available via GitLab Container Registry images and `docker-compose.prod.yml` (no `build:` steps, no internet pulls from public registries).
- Flowise is no longer wired in compose. Dify is the RAG/chat backend and n8n is the sync workflow runner.
