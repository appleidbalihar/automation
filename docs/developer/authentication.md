# Developer Guide: Authentication and RBAC

## Overview
`@platform/auth` supports Keycloak JWT verification for gateway authorization, with legacy local bearer parsing gated behind an explicit development flag.

## Token handling
- If bearer token is JWT-shaped (`header.payload.signature`):
  - verify signature via Keycloak JWKS
  - verify issuer against configured accepted issuers (`KEYCLOAK_URL`, optional `KEYCLOAK_PUBLIC_URL`, optional `KEYCLOAK_ISSUER`)
  - verify token is bound to configured client (`KEYCLOAK_CLIENT_ID`) via `azp`, `aud`, or `resource_access`
  - extract roles from:
    - `realm_access.roles`
    - `resource_access[KEYCLOAK_CLIENT_ID].roles`
- If bearer token is legacy (`user:role[:role...]`):
  - parse only when `AUTH_ALLOW_LEGACY_BEARER=true`
  - otherwise resolve to anonymous viewer context

## Role model
- Allowed roles: `admin`, `operator`, `approver`, `viewer`
- Unknown/missing roles fall back to `viewer`

## Key env assumptions
- `KEYCLOAK_URL`
- `KEYCLOAK_PUBLIC_URL` (optional, for public issuer compatibility)
- `KEYCLOAK_ISSUER` (optional explicit issuer override)
- `KEYCLOAK_REALM`
- `KEYCLOAK_CLIENT_ID`
- `AUTH_ALLOW_LEGACY_BEARER` (`false` by default)

## Security behavior
- JWT verification failure falls back to anonymous viewer context (no privileged role escalation).
- Non-JWT bearer tokens are ignored unless explicitly allowed for local/dev compatibility.
- Gateway role checks remain enforced through `requireAnyRole`.
