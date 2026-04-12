# Developer Guide: RAG Indexing Pipeline

## Overview
RAG indexing is now event-driven with durable persistence.

## Flow
1. `POST /rag/index` publishes `rag.index.requested`.
2. `rag-service` worker (`rag-service.index-worker.v1`) consumes event.
3. Worker resolves source docs via `buildSourceDocuments(source, requestedDocuments)`.
4. Worker upserts docs into `RagDocument` and records lifecycle in `RagIndexJob`.
5. `POST /rag/search` queries indexed `RagDocument` rows from Postgres.

## Data models
- `RagIndexJob`: async indexing lifecycle (`RUNNING`, `COMPLETED`, `FAILED`)
- `RagDocument`: indexed operational docs (`source`, `externalId`, `title`, `text`)

## API notes
- Search contract: `POST /rag/search` with:
  - `query` (required)
  - `source` (optional source filter)
  - `limit` (optional, capped to 20)
- Worker status: `GET /rag/jobs`
