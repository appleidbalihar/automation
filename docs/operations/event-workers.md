# Operations Guide: Event Workers

## Purpose
Event workers provide asynchronous post-processing and durable history for workflow publishing.

## Worker runtime checks
- Ensure RabbitMQ is healthy: `docker compose ps rabbitmq`
- Ensure services are running:
  - `workflow-service`

## Worker outputs to verify
- Workflow publish audit trail:
  - call `GET /workflows/:id/publish-audits`
  - expect `PROCESSED` records for published versions

## Recovery behavior
- Worker reconnects on service restart.
- Messages remain durable in queues while services are down.
- Workflow audit processing is idempotent by `workflowVersionId`.
