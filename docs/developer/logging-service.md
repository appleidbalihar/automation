# Developer Guide: Logging Service

## Overview
`logging-service` stores masked execution logs and provides filtered retrieval plus timeline reconstruction for order troubleshooting.

## Endpoints
- `POST /logs/ingest`: persist one execution log entry.
- `GET /logs`: filter and retrieve logs.
- `GET /logs/timeline`: retrieve chronological timeline for one order.

## Ingest contract highlights
- Accepts either `orderId` or `correlationId`.
- If only `correlationId` is provided, service resolves the matching order and stores against that order.
- Sensitive payload keys (`password`, `token`, `secret`, `key`, `credential`) are recursively masked before persistence.

## Query filters (`GET /logs`)
- `orderId` or `correlationId`
- `severity`, `source`, `nodeId`, `stepId`
- `messageContains` (case-insensitive)
- `from`, `to` (ISO datetime range)
- `limit` (1..500, defaults to 200)

## Timeline model (`GET /logs/timeline`)
- Requires `orderId` or `correlationId`.
- Merges and sorts:
  - status transitions
  - step executions
  - execution logs
- Output is ordered ascending by timestamp to support UI timeline rendering and incident analysis.
