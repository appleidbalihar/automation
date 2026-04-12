# Enterprise Automation Platform

Microservice-based automation platform with execution checkpoint tracking and resume support.

## Quick start

1. `corepack enable`
2. `corepack prepare pnpm@9.15.0 --activate`
3. `pnpm install`
4. `cp .env.example .env`
5. `pnpm compose:up`

## Access points (containerized, secure-only)

- Web UI: `https://<host-ip>:443`
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
- Default seeded account: `platform-admin / admin123`

## Workspace

- `apps/*`: deployable services and UI
- `packages/*`: shared contracts, libraries, and domain logic
- `docs/*`: implementation plan, developer docs, and operations docs
- `infra/*`: local infrastructure bootstrap assets
