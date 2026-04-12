# Operations Guide: Integration Execution

## What changed
The integration service now runs real adapter actions instead of stub responses.

## Endpoint
- `POST /integrations/execute`

## How to use
- Choose execution type (`REST`, `SCRIPT`, `SSH`, `NETCONF`).
- Provide command reference and adapter input.
- Review response for status, duration, output, and error details.
- Use `env:` references for sensitive values instead of raw plaintext in request payloads.
- Use `vault:path#field` references when Vault integration is configured (`VAULT_ADDR`, `VAULT_TOKEN`).
- Review `policy` in responses to confirm whether adapter execution was allowed or denied by policy controls.

## Example usage patterns
- Use `REST` for API operations against external systems.
- Use `SCRIPT` for local scripted automation tasks.
- Use `SSH` for remote shell command execution on managed hosts.
- Use `NETCONF` for network configuration RPCs over SSH subsystem.

## Troubleshooting
- `FAILED` with timeout: increase `timeoutMs` or validate target availability.
- `FAILED` for SSH/NETCONF: verify host, port, user, and network path.
- `FAILED` for REST: inspect returned status code and response payload.
- `FAILED` with policy message: check adapter allowlist environment variables and command restrictions.
- `FAILED` with Vault message: verify `VAULT_ADDR`, `VAULT_TOKEN`, secret path, and referenced field.

## Security controls
- Dangerous command patterns are blocked for shell-based adapters.
- Adapter allowlists can be tuned with:
  - `INTEGRATION_REST_URL_ALLOWLIST`
  - `INTEGRATION_SCRIPT_ALLOWLIST`
  - `INTEGRATION_SSH_ALLOWLIST`
  - `INTEGRATION_NETCONF_ALLOWLIST`
- Sensitive referenced values are masked from output and errors when detected.
- In production mode, script/ssh/netconf adapters are blocked by default unless allowlists are explicitly configured.
- Include `metadata.orderId` (and optional `nodeId`/`stepId`) in requests when you want integration execution events to be persisted in logging-service.
- Integration audit logs include policy decision metadata (`allowed`, `rule`, `reason`) for incident investigation.

## Vault smoke and recovery
- Seed smoke secret: `pnpm seed:vault`
- Execute smoke validation: `pnpm smoke:vault`
- If smoke fails during Vault startup, rerun after `docker compose up -d vault`; scripts now include readiness waits for Vault and integration-service.
