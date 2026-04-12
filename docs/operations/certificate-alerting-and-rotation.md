# Certificate Alerting and Rotation Operations

## What owns renewal
- Vault Agent handles cert renewal and file rendering.
- Rotation controller handles controlled recycle actions.
- Webhook alerts do not own renewal; they only notify/escalate.

## New operational surfaces
- Admin UI page: `/security` (platform-admin only)
  - Service cert expiry, days remaining, reload failures, pending rotation.
  - Manual `Run Rotation/Renew` button.
- APIs:
  - `GET /admin/security/certificates`
  - `GET /admin/security/certificates/events`
  - `POST /admin/security/certificates/:service/renew`

## Key env settings
- `CERT_SCAN_INTERVAL_MS=300000`
- `CERT_WARNING_DAYS=7`
- `CERT_CRITICAL_DAYS=3`
- `CERT_ALERT_WEBHOOK_URL=...` (optional)
- `ROTATION_INTERVAL_SECONDS=20`
- `ROTATION_ENABLE_FALLBACK=false` (recommended)

## Rotation queue
- Queue file: `/rotation-control/requests.jsonl`
- Produced by api-gateway
- Consumed by `cert-rotation-controller`

## Verification runbook
1. Check current certificate health:
   - `GET /gateway/admin/security/certificates`
2. Trigger manual rotation for one service:
   - `POST /gateway/admin/security/certificates/<service>/renew`
3. Verify controller consumes queue:
   - `docker compose logs cert-rotation-controller`
4. Verify queue drains:
   - `docker compose exec cert-rotation-controller sh -lc 'wc -l /rotation-control/requests.jsonl'`
5. Verify gateway/service health after action:
   - `GET /gateway/health/readiness`
   - `GET /gateway/health/dependencies`

