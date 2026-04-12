# Operations Guide: Event Workers

## Purpose
Event workers provide asynchronous post-processing and durable history for workflow publishing and RAG indexing.

## Worker runtime checks
- Ensure RabbitMQ is healthy: `docker compose ps rabbitmq`
- Ensure services are running:
  - `workflow-service`
  - `rag-service`

## Worker outputs to verify
- Workflow publish audit trail:
  - call `GET /workflows/:id/publish-audits`
  - expect `PROCESSED` records for published versions
- RAG index job history:
  - call `GET /rag/jobs`
  - expect `RUNNING`/`COMPLETED`/`FAILED` lifecycle states

## Recovery behavior
- Both workers reconnect on service restart.
- Messages remain durable in queues while services are down.
- Workflow audit processing is idempotent by `workflowVersionId`.
- If RAG worker processing fails, a failed job record is persisted for troubleshooting and retry planning.
