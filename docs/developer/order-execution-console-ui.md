# Developer Guide: Order Execution Console UI

## Overview
The web app now includes an order execution console focused on runtime visibility and recovery actions.

## Component
- `apps/web/src/app/order-execution-console.tsx`

## API usage
- `GET /auth/me` for role context
- `GET /orders` for recent order listing
- `GET /orders/approvals` for approval queue listing
- `GET /orders/:id` for order status, checkpoints, transitions, and step executions
- `GET /orders/:id/approvals` for decision history
- `GET /logs/timeline?orderId=...` for merged execution history
- `POST /orders/:id/retry` for manual retry
- `POST /orders/:id/rollback` for manual rollback
- `POST /orders/:id/request-approval` for approval gate entry
- `POST /orders/:id/approve` and `POST /orders/:id/reject` for approver decisions

## UX scope
- Load recent orders from backend and allow quick selection
- Show current status, node/step, last checkpoint, and failure cause
- Display full historical timeline table
- Show approval queue rows from backend `PENDING_APPROVAL` listing
- Enforce role-aware retry/rollback button enablement (admin/operator)
- Enforce role-aware approval decision actions (admin/approver)

## Notes
- Backend list APIs remove tracked-order dependency for approval queue visibility.
- Console is polling-based (`6-8s`) for v1 runtime updates.
