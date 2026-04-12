# Developer Guide: Event Workers

## Overview
Two dedicated RabbitMQ consumers now run as background workers:
- `workflow-service` publish-audit worker for `workflow.published`
- `rag-service` indexing worker for `rag.index.requested`

## Workflow publish-audit worker
- Queue: `workflow-service.publish-audit.v1`
- Binding: `platform.events` exchange with routing key `workflow.published`
- Persistence table: `WorkflowPublishAudit`
- Behavior:
  - consumes event envelope
  - validates `workflowId`, `workflowVersionId`, `version`
  - upserts audit row by `workflowVersionId` for idempotent replay safety

## RAG indexing worker
- Queue: `rag-service.index-worker.v1`
- Binding: `platform.events` exchange with routing key `rag.index.requested`
- Persistence table: `RagIndexJob`
- Behavior:
  - creates `RUNNING` job on receipt
  - upserts indexed documents into `RagDocument`
  - marks job `COMPLETED` after successful indexing
  - marks `FAILED` with error details when processing fails

## New read endpoints
- `GET /workflows/:id/publish-audits`
- `GET /rag/jobs`
