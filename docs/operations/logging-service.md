# Operations Guide: Logging Service

## Purpose

Use `logging-service` to inspect sanitized platform logs and RAG sync-job logs.

## Key APIs

Through the gateway:

```text
GET /gateway/logs
GET /gateway/logs/timeline
GET /gateway/logs/sync-job
```

Direct service routes are the same without `/gateway`.

## Common Flows

### Investigate A Platform Error

1. Open `/logs` as an admin.
2. Filter by `severity=ERROR`.
3. Narrow by `source` such as `api-gateway`, `workflow-service`, `logging-service`, or `n8n-rag-sync`.
4. Use `messageContains` for the failing operation.
5. If a correlation ID is present, use the timeline view.

### Investigate A Sync Step

1. Open Knowledge Connector.
2. Open the Sync Process Monitor.
3. Click the step log drawer for the failed step.
4. The UI calls `/gateway/logs/sync-job?syncJobId=<id>&stepName=<step>`.

## Notes

- Full `/gateway/logs` and `/gateway/logs/timeline` are admin-only.
- `/gateway/logs/sync-job` is available to admin, useradmin, and operator for scoped sync debugging.
- OpenSearch is optional for ingest success; PostgreSQL remains the source of persisted platform logs.
