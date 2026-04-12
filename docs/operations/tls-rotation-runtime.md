# TLS Rotation and Vault PKI Operations

## Components
- Vault server in persistent mode (`infra/vault/vault.hcl` + `vault_data` volume)
- PKI bootstrap job (`infra/vault/bootstrap-pki.sh`)
- Vault Agent sidecars per app service (`infra/vault/agent-entrypoint.sh`)
- Rotation controller (`infra/vault/rotation-controller.sh`)

## Compose flow
1. `vault` starts with file-backed storage.
2. `vault-bootstrap` initializes/unseals Vault (idempotent), configures PKI, policies, AppRoles, and writes per-service `role_id`/`secret_id`.
3. Each `*-vault-agent` authenticates with AppRole and continuously renders:
   - `/tls/cert.pem`
   - `/tls/key.pem`
   - `/tls/ca.pem`
4. Application services read `/tls/*` and hot-reload certificates in-process.
5. Secure-only transport defaults apply (`https`, `amqps`, `rediss`) with plaintext listener defaults removed from compose env contracts.

## Commands
- Start stack: `pnpm compose:up --build`
- Force PKI bootstrap rerun: `pnpm seed:vault-pki`
- Stop stack: `pnpm compose:down`

## Verification
- Service health: `GET /health`
- TLS diagnostics: `GET /security/tls` with header:
  - `x-security-token: <SECURITY_DIAGNOSTICS_TOKEN>` (if configured)
- Compose check: `docker compose config`
- Endpoint checks:
  - `https://<host-ip>:443` (web ingress)
  - `https://<host-ip>:4000/health` (api-gateway)
  - `https://<host-ip>:8443` (keycloak)

## Environment knobs
- `MTLS_REQUIRED`
- `TLS_CERT_PATH`, `TLS_KEY_PATH`, `TLS_CA_PATH`
- `TLS_VERIFY_PEER`
- `TLS_RELOAD_DEBOUNCE_MS`
- `SECURITY_DIAGNOSTICS_TOKEN`
- `ROTATION_INTERVAL_SECONDS`, `RESTART_WINDOW_SECONDS`, `ROTATION_TARGET_CONTAINERS`

## Failure behavior
- If cert reload fails, service keeps previous cert and records reload failure count.
- Vault Agent continues retry/renew automatically.
- Rotation controller performs periodic infra container recycle (no manual job) for components that do not hot-reload certs.
