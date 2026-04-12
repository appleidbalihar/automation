# Developer Guide: Execution Engine Service

## Overview
`execution-engine` now provides real validation and checkpoint-aware run endpoints (not just capabilities metadata).

## Endpoints
- `GET /engine/capabilities`
- `POST /engine/validate-workflow`
  - validates node ordering, duplicate ids/orders, step definitions, and retry policy values
- `POST /engine/run`
  - executes workflow from provided checkpoint pointer using shared `engine-core`
  - supports optional `approvedNodeOrders` to pass approval gates
  - dispatches each step to `integration-service` (`/integrations/execute`) using declared execution type
  - returns execution result, checkpoint writes, and masked step audit trail (request/response payload + timestamps)

## Implementation notes
- Uses `@platform/engine-core` for deterministic resume behavior.
- Runtime path is service-to-service: `order-service -> execution-engine -> integration-service`.
- Engine responses are persisted by `order-service` as checkpoints and step execution history.

## Smoke
- Engine smoke: `pnpm smoke:engine`
- Full smoke sequence: `pnpm smoke:all`
