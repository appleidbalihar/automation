# Operations Guide: RAG Indexing

## Purpose
Track and validate asynchronous indexing from gateway requests to searchable document results.

## Runtime checks
- Index request (via gateway): `POST /rag/index`
- Job tracking (via gateway): `GET /rag/jobs`
- Retrieval check (via gateway): `POST /rag/search`

## Troubleshooting
- No jobs after index request:
  - verify `rag-service` health
  - verify RabbitMQ health
  - verify gateway can reach `rag-service`
- Jobs stuck in `RUNNING` or `FAILED`:
  - inspect `rag-service` logs for worker errors
  - verify Postgres availability and migrations
- Search returns empty results:
  - confirm completed jobs exist in `GET /rag/jobs`
  - confirm request `source` filter matches indexed source

## Smoke validation
- Run `pnpm smoke:rag` to validate:
  - gateway index request
  - async worker completion
  - searchable indexed results
