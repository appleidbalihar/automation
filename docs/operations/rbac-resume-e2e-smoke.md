# Operations Guide: RBAC + Resume E2E Smoke

## Purpose
Validate that role restrictions and retry-resume behavior are both functioning after restarts or environment changes.

## Command
- `pnpm smoke:rbac`

## What it verifies
1. Role protection:
   - viewer cannot publish workflows
   - viewer cannot execute or retry orders
   - viewer cannot approve orders
   - viewer can read order/approval list APIs
   - operator can request approval
   - approver can reject approval
2. Runtime recovery semantics:
   - a controlled failing order is persisted as `FAILED`
   - retry starts from the last persisted node/step checkpoint
3. Audit continuity:
   - timeline shows failure and resumed running transition history

## Failure hints
- If viewer requests are not rejected, verify gateway auth/rbac settings and `AUTH_ALLOW_LEGACY_BEARER` policy.
- If retry resume pointer mismatches order state, inspect order-service checkpoint writes and retry handler behavior.
- If timeline transitions are missing, verify logging-service timeline endpoint and event/log ingestion health.
