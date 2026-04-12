# Operations Guide: Order Execution Console UI

## Purpose
Provide operational visibility and recovery controls for tracked orders from the web console.

## Operator flow
1. Enter an order ID and click `Track Order`.
2. Review status, checkpoint, and failure cause in the execution summary.
3. Use `Retry Selected` or `Rollback Selected` when role policy permits.
4. Watch timeline events for transition history and execution context.
5. Monitor tracked `PENDING_APPROVAL` items in the approval queue panel.
6. Approver/admin can approve or reject directly from the queue table.

## Access model
- View order and timeline data: viewer/operator/admin
- Retry and rollback actions: operator/admin
- Approval decisions: approver/admin

## Runtime dependencies
- `api-gateway`, `order-service`, and `logging-service` must be healthy
- Valid bearer token should be stored in web auth panel for protected actions
- Backend list routes should be available:
  - `GET /orders`
  - `GET /orders/approvals`

## Resume notes
- After service interruption, reopen console and refresh; recent orders, approval queue, and timeline are loaded from persisted backend records.
