# RapidRAG — RAG-as-a-Service

RapidRAG is a fully managed RAG-as-a-Service platform. Connect your docs, repos, and websites — and anyone on your team can ask questions in plain language and get real answers pulled straight from your own content. Deploy to Slack, Telegram, or WhatsApp in minutes. Run in the cloud or on-prem inside your own infrastructure.

## Quick start

1. `corepack enable`
2. `corepack prepare pnpm@9.15.0 --activate`
3. `pnpm install`
4. `cp .env.example .env`
5. `/home/bali/09_rapidrag/scripts/platform-containers.sh dev start`
6. `ENVIRONMENT=dev bash scripts/seed-keycloak-platform-admin.sh`

## Access points (containerized, secure-only)

- Web UI through the compose ingress: `https://<host-ip>:3443`
- Production deployments may place host Nginx or another edge proxy on `443` in front of the compose ingress.
- API Gateway: `https://<host-ip>:4000`
- Keycloak: `https://<host-ip>:8443`
- RabbitMQ UI: `https://<host-ip>:15671`
- MinIO Console: `https://<host-ip>:9001`

The web app proxies API calls through same-origin `/gateway/*` by default.
To force a direct public API base in the browser, set `WEB_NEXT_PUBLIC_API_BASE_URL` in `.env` before `pnpm compose:up`.
For containerized runtime, keep:
- `WEB_INTERNAL_API_BASE_URL=https://api-gateway:4000`
- `WEB_KEYCLOAK_URL=https://keycloak:8443`

## TLS and certificate rotation

- Backend services use Vault-issued certificates rendered by Vault Agent sidecars into `/tls/*`.
- Service cert/key updates are hot-reloaded in-process by the shared TLS runtime.
- PKI bootstrap can be re-run with `pnpm seed:vault-pki`.
- TLS diagnostics endpoint per backend service: `GET /security/tls` (set `x-security-token` if `SECURITY_DIAGNOSTICS_TOKEN` is configured).

## Web Sign-In

- The web app now uses Keycloak login directly from the UI (no manual token paste required).
- Default seeded account: `platform-admin` with the Vault-backed `platform_admin_password` from `platform/dev/infra/keycloak/config`.

## Current product surface

- Knowledge Connector (`/knowledge-connector`): create GitHub, GitLab, Google Drive, web, or upload-backed knowledge sources; manage path filters, credentials, sharing, sync, cleanup, and retry jobs.
- RAG Assistant (`/rag-assistant`): private Dify-backed discussion threads, including multi-KB answers.
- AI Agent Prompt (`/ai-agent-prompt`): admin/useradmin prompt template management and template application to KBs.
- Admin tools: `/rag-stats`, `/logs`, `/users`, `/secrets`, and `/security`.

Flowise is not a current runtime dependency. Dify handles datasets/chat and n8n handles sync workflows.

## Current product surface

- Knowledge Connector (`/knowledge-connector`): create GitHub, GitLab, Google Drive, web, or upload-backed knowledge sources; manage path filters, credentials, sharing, sync, cleanup, and retry jobs.
- RAG Assistant (`/rag-assistant`): private Dify-backed discussion threads, including multi-KB answers.
- AI Agent Prompt (`/ai-agent-prompt`): admin/useradmin prompt template management and template application to KBs.
- Admin tools: `/rag-stats`, `/logs`, `/users`, `/secrets`, and `/security`.

Flowise is not a current runtime dependency. Dify handles datasets/chat and n8n handles sync workflows.

## Workspace

- `apps/*`: deployable services and UI
- `packages/*`: shared contracts, libraries, and domain logic
- `docs/*`: implementation plan, developer docs, and operations docs
- `infra/*`: local infrastructure bootstrap assets
