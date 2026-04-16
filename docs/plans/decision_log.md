# Decision Log

## 2026-04-08
- Use TypeScript monorepo architecture with Docker Compose as runtime baseline.
- Use PostgreSQL as system of record with Redis/RabbitMQ/OpenSearch/MinIO/Keycloak/Vault as supporting services.
- Treat execution checkpoints and transition history as first-class persisted entities.

## 2026-04-10
- Standardize RabbitMQ event envelope `{ event, timestamp, payload }`.
- Keep retry/resume checkpoint-driven and rollback limited to completed reversible steps.
- Add repeatable smoke scripts as resume checkpoints after interruptions.

## 2026-04-11
- Adopt strict secure-only runtime defaults (HTTPS/mTLS + TLS-enabled infra).
- Make Vault the authoritative secret store for sensitive runtime values.
- Keep platform RBAC centered on `admin` and `useradmin` (legacy operator compatibility retained where needed).

## 2026-04-12
- Keep production deployment internet-independent via private GitLab registry images and production compose.

## 2026-04-13
- Hard-remove all AI assistant scope (`agent-service`, `rag-service`, `chat-service`, assistant UI/routes/contracts/schema/docs/tests).
- AI capability is deferred and will be reintroduced later as a separate scoped initiative without compatibility shims.
