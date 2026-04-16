# Developer Guide: Platform Architecture

## Services
- `api-gateway`: external entry point and policy enforcement.
- `workflow-service`: workflow lifecycle and versioning.
- `order-service`: order orchestration, statuses, and checkpoints.
- `execution-engine`: deterministic execution and resume logic.
- `integration-service`: adapter execution for target systems.
- `logging-service`: execution history and searchable logs.
- `web`: enterprise UI.

## Persistence
- PostgreSQL stores workflows, versions, orders, node/step execution history, checkpoints, approvals, and integration/environment metadata.
- OpenSearch stores searchable masked logs.
- RabbitMQ carries domain events.
- Redis provides transient coordination and caching.

## Recovery design
- Each successful step produces a persisted checkpoint.
- Resume always starts from the last successful checkpoint for the order.
- Retry defaults to failed-step scope.
- Rollback only runs reversible actions for already successful steps.
