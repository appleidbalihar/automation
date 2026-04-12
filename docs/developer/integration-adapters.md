# Developer Guide: Integration Adapters

## Overview
`integration-service` now executes real adapter flows through `POST /integrations/execute` using a typed adapter engine.

## Supported execution types
- `REST`: uses `fetch` with configurable `url`, `method`, `headers`, and `body`.
- `SCRIPT`: executes shell commands through `bash -lc`.
- `SSH`: runs remote commands through the system `ssh` client.
- `NETCONF`: opens an SSH `netconf` subsystem session and sends XML payload from `commandRef`.

## Request contract
- `executionType`: `REST | SSH | NETCONF | SCRIPT`
- `commandRef`: command or endpoint reference
- `input`: adapter-specific settings
- `timeoutMs`: optional timeout per execution
- `metadata` (optional): `orderId`, `nodeId`, `stepId` for logging correlation.

## Credential and secret references
- Adapter input supports environment references using `env:VAR_NAME`.
- Adapter input supports Vault references using `vault:path#field`.
- Secret resolution is abstracted behind provider interfaces (`env`, `vault`) so additional providers can be added without changing adapter implementations.
- Example: `"token": "env:API_ACCESS_TOKEN"` or `"host": "env:SSH_TARGET_HOST"`.
- Vault example: `"token": "vault:secret/data/network/device-a#token"`.
- Missing referenced environment values fail execution with a clear error.
- Sensitive references (`*token*`, `*secret*`, `*password*`, etc.) are masked from adapter output and error payloads.
- Strings that contain `:` but do not start with `env:` or `vault:` are treated as plain values.

## Command and URL policy
- Dangerous non-REST commands are blocked (`rm -rf /`, command piping into shell, destructive admin commands).
- Allowlists are configurable via environment variables:
  - `INTEGRATION_REST_URL_ALLOWLIST`
  - `INTEGRATION_SCRIPT_ALLOWLIST`
  - `INTEGRATION_SSH_ALLOWLIST`
  - `INTEGRATION_NETCONF_ALLOWLIST`
- Default policy allows broad execution for local development, but production should set strict allowlists.
- Production defaults are strict: non-REST adapters are denied unless explicit allowlists are configured.

## Response contract
- `status`: `SUCCESS | FAILED`
- `durationMs`: measured execution time
- `output`: adapter output payload (stdout, response body, status code)
- `error`: failure reason on failed execution
- `policy`: policy decision metadata:
  - `allowed`: boolean
  - `rule`: allowlist/security rule name
  - `reason`: optional deny reason

## Notes
- SSH and NETCONF require reachable hosts and valid credentials/keys from runtime environment.
- `SCRIPT` execution is intended for controlled automation environments.
- If `metadata.orderId` is provided, integration-service emits an audit event to logging-service, including adapter policy decision metadata for traceability.
- Local Vault smoke path:
  - start: `pnpm compose:up`
  - seed Vault secret: `pnpm seed:vault`
  - run end-to-end smoke: `pnpm smoke:vault`
