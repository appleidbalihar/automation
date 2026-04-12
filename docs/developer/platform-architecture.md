# Developer Guide: Platform Architecture

## Services
- `api-gateway`: external entry point and policy enforcement.
- `workflow-service`: workflow lifecycle and versioning.
- `order-service`: order orchestration, statuses, and checkpoints.
- `execution-engine`: deterministic execution and resume logic.
- `integration-service`: adapter execution for target systems.
- `logging-service`: execution history and searchable logs.
- `rag-service`: operational knowledge ingestion and retrieval.
- `chat-service`: constrained operational assistant.
- `web`: enterprise UI.

## Persistence
- PostgreSQL stores workflows, versions, orders, node/step execution history, checkpoints, and chat history.
- OpenSearch stores searchable masked logs.
- RabbitMQ carries domain events.
- Redis provides transient coordination and caching.

## Recovery design
- Each successful step produces a persisted checkpoint.
- Resume always starts from the last successful checkpoint for the order.
- Retry defaults to failed-step scope.
- Rollback only runs reversible actions for already successful steps.

