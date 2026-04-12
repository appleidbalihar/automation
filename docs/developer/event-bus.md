# Developer Guide: Event Bus

## Overview
RabbitMQ topic exchange `platform.events` now carries execution-domain events between services.

## Publishers
- `order-service` publishes:
  - `order.created`
  - `execution.step.completed`
  - `execution.step.failed`
  - `order.node.completed`
  - `order.node.failed`
  - `order.execution.resumed`
  - `execution.rollback.started`
  - `execution.rollback.completed`
- `workflow-service` publishes:
  - `workflow.published`
- `rag-service` publishes:
  - `rag.index.requested`

## Envelope format
All published messages follow:
- `event`: event name
- `timestamp`: ISO timestamp at publish time
- `payload`: event body including `orderId` and `correlationId` when available

## Consumer
- `logging-service` binds queue `logging-service.events.v1` to `platform.events` using routing key `#`.
- For messages with `payload.orderId`, it persists an `ExecutionLog` row with:
  - `source = "event-bus"`
  - severity inferred from event name (`*failed*` => `ERROR`, else `INFO`)
  - masked payload
- Dedicated workers:
  - `workflow-service.publish-audit.v1` handles `workflow.published`
  - `rag-service.index-worker.v1` handles `rag.index.requested`

## Delivery tests
- `workflow-service` publisher tests verify:
  - routing key equals event name
  - envelope contains `event`, `timestamp`, `payload`
  - messages are published persistent with `application/json`
- `rag-service` publisher tests verify the same delivery contract for `rag.index.requested`.

## Reliability notes
- Publisher failures are non-blocking to order API responses.
- Consumer uses manual ack/nack and requeues transient processing failures.
