# Operations Guide: Logging Service

## Purpose
Use `logging-service` to inspect execution activity, troubleshoot failures, and reconstruct order history.

## Key APIs
- `GET /logs?orderId=<id>`
- `GET /logs?correlationId=<correlation-id>`
- `GET /logs/timeline?orderId=<id>`
- `GET /logs/timeline?correlationId=<correlation-id>`

## Common operational flows
- Incident triage:
  - query `/logs` by `correlationId`
  - narrow by `severity=ERROR`
  - inspect `source`, `nodeId`, `stepId`, and `message`
- Timeline review:
  - call `/logs/timeline`
  - follow status transitions and step execution events in time order
  - correlate with adapter execution logs for root-cause analysis

## Notes
- Payloads are stored as masked payloads; sensitive keys are redacted automatically.
- API gateway exposes these endpoints to authorized roles (`admin`, `operator`, `viewer`).
