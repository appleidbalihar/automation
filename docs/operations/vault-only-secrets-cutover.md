# Vault-Only Secrets Operations

## What changed
- Secret runtime is Vault Agent-only for app services.
- Shared `VAULT_TOKEN` env usage is removed from compose app env.
- Strict mode blocks startup when plaintext sensitive values still exist.

## Admin operations
- Use web `Secrets` page (platform-admin only) to:
  - list the Vault catalog
  - create/update/delete secrets (masked output only)
  - create/update/delete a specific field by Vault path
  - run one-time plaintext migration placeholder if needed

## Required env defaults
- `VAULT_STRICT_SECRETS=true`
- `VAULT_KV_MOUNT=secret`

## Upgrade durability
- Secret values remain in Vault storage volume (`vault_data`).
- App records store Vault references only.
- `git pull` and image updates do not overwrite Vault-stored secret data.

## Cutover checklist
1. Start stack and ensure Vault bootstrap completed.
2. Run migration (`POST /admin/secrets/migrate`) only if legacy plaintext cleanup is still required.
3. Validate no blocked plaintext via workflow-service startup success.
