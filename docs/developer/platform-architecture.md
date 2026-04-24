# Developer Guide: Platform Architecture

## Services
- `api-gateway`: external entry point and policy enforcement.
- `workflow-service`: Operations AI discussion persistence and admin secret management.
- `logging-service`: execution history and searchable logs.
- `web`: enterprise UI.

## Persistence
- PostgreSQL stores Operations AI discussion history and retained execution log records.
- OpenSearch stores searchable masked logs.
- RabbitMQ carries domain events.
- Redis provides transient coordination and caching.
