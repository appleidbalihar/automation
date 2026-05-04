# Developer Guide: Authentication and RBAC

## Overview
`@platform/auth` supports Keycloak JWT verification only for gateway authorization.

## Token handling
- If bearer token is JWT-shaped (`header.payload.signature`):
  - verify signature via Keycloak JWKS
  - verify issuer against configured accepted issuers (`KEYCLOAK_URL`, optional `KEYCLOAK_PUBLIC_URL`, optional `KEYCLOAK_ISSUER`)
  - verify token is bound to configured client (`KEYCLOAK_CLIENT_ID`) via `azp`, `aud`, or `resource_access`
  - extract roles from:
    - `realm_access.roles`
    - `resource_access[KEYCLOAK_CLIENT_ID].roles`
- If bearer token is not a valid JWT for the configured Keycloak realm/client, resolve to anonymous context and protected routes return `401`.

## Role model
- Allowed roles: `admin`, `useradmin`, `operator`, `approver`, `viewer`
- Unknown/missing roles fall back to `viewer`.
- Tokens with `operator` also receive `useradmin` in `@platform/auth` for current compatibility.

## Key env assumptions
- `KEYCLOAK_URL`
- `KEYCLOAK_PUBLIC_URL` (optional, for public issuer compatibility)
- `KEYCLOAK_ISSUER` (optional explicit issuer override)
- `KEYCLOAK_REALM`
- `KEYCLOAK_CLIENT_ID`

## Security behavior
- JWT verification failure falls back to anonymous viewer context (no privileged role escalation).
- Non-JWT bearer tokens are ignored.
- Gateway role checks remain enforced through `requireAnyRole`.
