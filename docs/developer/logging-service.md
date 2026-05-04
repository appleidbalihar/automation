# Developer Guide: Logging Service

## Overview

`logging-service` persists sanitized platform logs in PostgreSQL and ships a best-effort copy to OpenSearch. It also exposes scoped RAG sync logs for the Sync Process Monitor drawer.

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | Liveness |
| `GET` | `/security/tls` | TLS diagnostics, token-protected when configured |
| `POST` | `/logs/ingest` | Store one sanitized platform log |
| `GET` | `/logs` | Query logs by filter |
| `GET` | `/logs/timeline` | Return chronological events for a correlation ID |
| `GET` | `/logs/sync-job` | Return logs for one RAG sync job, optionally one step |

## Ingest Contract

`POST /logs/ingest` accepts:

```json
{
  "severity": "INFO",
  "source": "workflow-service",
  "message": "Sync started",
  "payload": {},
  "correlationId": "optional",
  "durationMs": 123,
  "syncJobId": "optional",
  "stepName": "optional"
}
```

Sensitive payload keys containing `password`, `token`, `secret`, `key`, or `credential` are recursively masked before persistence.

For RAG sync logs, `syncJobId` is also stored as the PostgreSQL `correlationId` fallback so logs remain queryable even if OpenSearch is unavailable.

## Query Filters

`GET /logs` supports:

- `severity`
- `source`
- `correlationId`
- `messageContains`
- `from`
- `to`
- `limit` from 1 to 500, default 200

`GET /logs/timeline` supports:

- `correlationId`
- `from`
- `to`
- `limit`

`GET /logs/sync-job` requires:

- `syncJobId`

and optionally accepts:

- `stepName`
- `limit`

## Storage

- PostgreSQL table: `PlatformLog`
- OpenSearch index pattern: `platform-logs-*`
- OpenSearch failures do not fail `/logs/ingest`.
