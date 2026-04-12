# Operations Guide: Event Bus

## Purpose
The event bus provides asynchronous execution tracking so order activity can still be reconstructed if synchronous service calls are delayed or unavailable.

## RabbitMQ resources
- Exchange: `platform.events` (type `topic`, durable)
- Queue: `logging-service.events.v1` (durable)
- Binding: routing key `#`

## Current producers
- `order-service`: order/step/retry/rollback lifecycle events
- `workflow-service`: workflow publish events (`workflow.published`)
- `rag-service`: indexing requests (`rag.index.requested`)

## What to monitor
- RabbitMQ queue depth for `logging-service.events.v1`
- Consumer connection health for `logging-service`
- Event publish warnings in `order-service` logs

## Failure handling
- If RabbitMQ is temporarily unavailable:
  - `order-service` continues API processing
  - publish attempts log warnings and do not fail order APIs
- If `logging-service` cannot consume:
  - it logs a startup warning and continues serving `/logs` APIs
  - restart service after RabbitMQ is healthy

## Recovery steps
1. Ensure RabbitMQ is healthy in compose: `docker compose ps rabbitmq`
2. Restart `order-service` and `logging-service` to re-establish channels.
3. Verify consumption by executing an order and checking `/logs?orderId=<id>&source=event-bus`.
