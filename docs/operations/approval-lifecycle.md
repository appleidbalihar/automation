# Operations Guide: Approval Lifecycle

## Purpose
Enable controlled approval gates in workflow execution with auditable decisions.

## Runtime flow
1. Operator requests approval for an order (`request-approval`).
2. Order enters `PENDING_APPROVAL` and appears in approval queue.
3. Approver decides:
   - approve: order resumes from checkpoint
   - reject: order transitions to `FAILED`
4. Decision history is available through order approval records.

## API checkpoints
- `POST /orders/:id/request-approval`
- `POST /orders/:id/approve`
- `POST /orders/:id/reject`
- `GET /orders/:id/approvals`
- `GET /orders/approvals`

## RBAC summary
- operator/admin: request approval
- approver/admin: approve or reject
- viewer: read-only visibility

## Recovery notes
- Approval decisions are persisted and survive restarts.
- Resume behavior after approval starts from saved order checkpoint pointer.
