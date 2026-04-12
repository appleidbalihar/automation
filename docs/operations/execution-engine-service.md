# Operations Guide: Execution Engine Service

## Purpose
Provide direct validation and real checkpoint-resume execution behavior.

## Health and capability checks
- `GET /health`
- `GET /engine/capabilities`

## Operational checks
1. Validate workflow definition:
   - `POST /engine/validate-workflow`
2. Run engine from checkpoint pointer:
   - `POST /engine/run`
3. Inspect response for:
   - `result.status`
   - `checkpoints`
   - `audits`

## Validation commands
- Engine-only smoke: `pnpm smoke:engine`
- Full suite smoke: `pnpm smoke:all`

## Notes
- Run execution is delegated to `integration-service` for REST/SSH/NETCONF/SCRIPT operations.
- Production execution path is `order-service -> execution-engine -> integration-service`, with DB persistence in `order-service`.
