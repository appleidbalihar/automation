# Operations Guide: Recovery Timeline Smoke

## Purpose
Validate retry/rollback timeline tracking through gateway APIs.

## Command
- `pnpm smoke:recovery`

## What it verifies
1. Creates and publishes a workflow via gateway.
2. Executes an order.
3. Triggers rollback and retry actions.
4. Queries `GET /logs/timeline` and confirms expected transition states:
   - `RUNNING`
   - `ROLLING_BACK`
   - `ROLLED_BACK`

## Script resilience
- The smoke script now reuses already-healthy local services instead of failing on duplicate startup (`EADDRINUSE`).

## Dependencies
- PostgreSQL
- RabbitMQ
- workflow-service
- order-service
- logging-service
- api-gateway

## Failure hints
- If workflow creation/publish fails, verify admin auth header handling in gateway.
- If timeline states are missing, inspect order-service transition writes and logging-service timeline retrieval.
