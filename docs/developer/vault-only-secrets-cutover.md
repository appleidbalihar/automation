# Vault-Only Secrets Cutover

## Summary
- Sensitive values are now Vault-only (`vault:path#field`) with strict enforcement.
- `env:` secret references are blocked.
- Plaintext sensitive fields are blocked for managed platform secret usage.

## Service behavior
- `workflow-service` enforces strict policy at startup (`VAULT_STRICT_SECRETS=true` by default).
- The surviving admin secret APIs read and write Vault through the local Vault Agent and do not use `VAULT_TOKEN` in app runtime.

## Admin APIs
- `GET /admin/secrets`
- `POST /admin/secrets`
- `PATCH /admin/secrets`
- `DELETE /admin/secrets`
- `POST /admin/secrets/migrate`

These are implemented in `workflow-service` and exposed through `api-gateway`.

## Path model
- User namespace: `secret/data/platform/users/<username>/<group>#<key>`
- Global namespace: `secret/data/platform/global/<group>#<key>`

## Compose wiring
- Shared env no longer injects `VAULT_TOKEN`.
- `workflow-service` uses `VAULT_ADDR=http://workflow-service-vault-agent:8200`.
