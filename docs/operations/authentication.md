# Operations Guide: Gateway Authentication

## Purpose
Control API access with role enforcement backed by Keycloak JWTs.

## Runtime behavior
- JWT bearer tokens are validated against Keycloak JWKS.
- Accepted token issuers can include both internal and public URLs:
  - internal: `KEYCLOAK_URL`
  - optional public: `KEYCLOAK_PUBLIC_URL`
  - optional explicit override: `KEYCLOAK_ISSUER`
- Token/client binding is validated against `KEYCLOAK_CLIENT_ID` using `azp`, `aud`, or `resource_access`.
- Role checks are enforced at API gateway route level.
- Non-JWT or invalid bearer tokens are rejected as unauthenticated.

## Key configuration
- `KEYCLOAK_URL`
- `KEYCLOAK_PUBLIC_URL` (recommended when issuer differs between internal Docker DNS and public URL)
- `KEYCLOAK_ISSUER` (optional explicit issuer value)
- `KEYCLOAK_REALM`
- `KEYCLOAK_CLIENT_ID`

## Validation checklist
1. Gateway health: `GET /health`
2. Role-protected endpoint access:
   - admin-only path should reject viewer
   - viewer path should allow viewer
3. If JWT auth fails unexpectedly:
   - verify Keycloak realm URL and client id settings
   - verify token issuer matches one of accepted issuer env values
   - verify web login can fetch token from `/api/auth/token`

## Smoke impact
- Use real Keycloak access tokens in smoke and integration tests.
