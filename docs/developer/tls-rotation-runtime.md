# TLS Rotation Runtime (Developer)

## What was added
- New shared package: `@platform/tls-runtime`.
- All backend services now initialize a TLS runtime with:
  - cert/key/CA file loading
  - file-watch + debounce reload
  - outbound mTLS-capable dispatcher refresh
  - optional AMQP TLS socket options
  - diagnostics status surface

## Service contract
Every backend service consumes:
- `MTLS_REQUIRED`
- `TLS_CERT_PATH`
- `TLS_KEY_PATH`
- `TLS_CA_PATH`
- `TLS_VERIFY_PEER`
- `TLS_RELOAD_DEBOUNCE_MS`
- `TLS_SERVER_NAME` (optional)
- `SECURITY_DIAGNOSTICS_TOKEN` (optional)

When enabled, services expose:
- `GET /security/tls` (token-protected when `SECURITY_DIAGNOSTICS_TOKEN` is set)

## Runtime behavior
- On startup, cert material must exist if `MTLS_REQUIRED=true`.
- On file changes, cert material reloads in-process.
- Existing cert remains active if a reload attempt fails.
- `reloadFailures` increments and is visible via `/security/tls`.
- Outbound internal `fetch` calls use the refreshed TLS dispatcher.

## Current note
- Internal service-to-service TLS is enabled at app plane.
- `api-gateway` keeps HTTP listener for ingress compatibility while using TLS for downstream internal service calls.
