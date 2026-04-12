# Vault-Only Secrets Cutover

## Summary
- Sensitive values are now Vault-only (`vault:path#field`) with strict enforcement.
- `env:` secret references are blocked.
- Plaintext sensitive fields are blocked for integration credentials and environment variables.

## Service behavior
- `workflow-service` enforces strict policy at startup (`VAULT_STRICT_SECRETS=true` by default).
- Integration credential create/update validates:
  - no plaintext sensitive keys
  - no `env:` refs
  - referenced Vault secret exists
- Environment create/update blocks sensitive keys entirely.
- `integration-service` resolves secrets through Vault Agent using `VAULT_ADDR` and never uses `VAULT_TOKEN`.

## Admin APIs
- `GET /admin/secrets`
- `POST /admin/secrets`
- `PATCH /admin/secrets`
- `DELETE /admin/secrets`
- `GET /admin/secrets/usage`
- `POST /admin/secrets/migrate`

These are implemented in `workflow-service` and exposed through `api-gateway`.

## Path model
- User namespace: `secret/data/platform/users/<username>/<group>#<key>`
- Global namespace: `secret/data/platform/global/<group>#<key>`

## Compose wiring
- Shared env no longer injects `VAULT_TOKEN`.
- `workflow-service` uses `VAULT_ADDR=http://workflow-service-vault-agent:8200`.
- `integration-service` uses `VAULT_ADDR=http://integration-service-vault-agent:8200`.

