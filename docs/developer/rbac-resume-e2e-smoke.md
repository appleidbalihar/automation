# Developer Guide: RBAC + Resume E2E Smoke

## Overview
`tests/smoke/rbac-resume-e2e-smoke.sh` validates gateway RBAC enforcement and checkpoint-based retry resume behavior in one end-to-end flow.

## Coverage
- Viewer is denied on admin/operator endpoints:
  - `POST /workflows/:id/publish`
  - `POST /orders/execute`
  - `POST /orders/:id/retry`
  - `POST /orders/:id/approve`
- Viewer can read list endpoints:
  - `GET /orders`
  - `GET /orders/approvals`
- Operator can request approval:
  - `POST /orders/:id/request-approval`
- Approver can reject:
  - `POST /orders/:id/reject`
- Admin/operator can execute allowed actions.
- Order with a deterministic failing step ends in `FAILED`.
- `POST /orders/:id/retry` returns `resumeFrom` that matches persisted `currentNodeOrder/currentStepIndex`.
- Timeline includes `PENDING_APPROVAL`, `FAILED`, and resumed `RUNNING` transitions.

## Run
- `pnpm smoke:rbac`

## Notes
- Script enables legacy local bearer auth explicitly via `AUTH_ALLOW_LEGACY_BEARER=true` for smoke compatibility.
- Services are started only when not already healthy and only script-started processes are stopped on exit.
