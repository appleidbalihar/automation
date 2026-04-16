# Developer Guide: Event Workers

## Overview
One dedicated RabbitMQ consumer runs as a background worker:
- `workflow-service` publish-audit worker for `workflow.published`

## Workflow publish-audit worker
- Queue: `workflow-service.publish-audit.v1`
- Binding: `platform.events` exchange with routing key `workflow.published`
- Persistence table: `WorkflowPublishAudit`
- Behavior:
  - consumes event envelope
  - validates `workflowId`, `workflowVersionId`, `version`
  - upserts audit row by `workflowVersionId` for idempotent replay safety

## New read endpoints
- `GET /workflows/:id/publish-audits`
