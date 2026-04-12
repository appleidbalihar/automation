# Certificate Alerting and Rotation Triggering

## Design intent
- Renewal ownership stays with Vault Agent + rotation controller.
- API gateway adds an alerting/control layer only.
- Manual and policy actions use one shared queue file (`/rotation-control/requests.jsonl`).

## Gateway endpoints
- `GET /admin/security/certificates`
  - Aggregates service certificate status from `/security/tls` and TLS handshake checks.
  - Computes severity using:
    - warning `< 7 days`
    - critical `< 3 days` (72h)
- `POST /admin/security/certificates/:service/renew`
  - Admin-only.
  - Queues request to the rotation controller queue file.
- `GET /admin/security/certificates/events`
  - Returns recent certificate alert/rotation timeline entries.

## Runtime behavior
- Scheduled scanner interval via `CERT_SCAN_INTERVAL_MS` (default 300000 ms).
- Emits platform events:
  - `cert.expiry.warning`
  - `cert.expiry.critical`
  - `cert.reload.failed`
  - `cert.rotation.triggered`
  - `cert.rotation.completed`
  - `cert.webhook.delivery.failed`
- Writes certificate control logs to logging-service with:
  - `orderId=cert-control-global`
  - `source=cert-control`

## Manual/API trigger contract
Queued line format in `/rotation-control/requests.jsonl`:
`requestId|service|trigger|requestedBy|queuedAt|target1,target2,...`

The rotation controller consumes this queue and restarts mapped compose services (usually `*-vault-agent`, plus selected infra service where needed).

