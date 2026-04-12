# Developer Guide: Approval Lifecycle

## Overview
Orders now support first-class approval transitions and decisions in `order-service`.

## Data model
- New table: `ApprovalDecision`
  - `orderId`
  - `nodeOrder`
  - `decision` (`APPROVED` or `REJECTED`)
  - `decidedBy`
  - `comment`
  - `createdAt`

## API surface
- `POST /orders/:id/request-approval`
  - moves order to `PENDING_APPROVAL`
- `POST /orders/:id/approve`
  - records approval decision
  - transitions `PENDING_APPROVAL -> RUNNING`
  - resumes execution from checkpoint for the approved node
- `POST /orders/:id/reject`
  - records rejection decision
  - transitions `PENDING_APPROVAL -> FAILED`
- `GET /orders/:id/approvals`
  - decision history

## Gateway RBAC
- request approval: `admin`, `operator`
- approve/reject: `admin`, `approver`
- approval history read: `admin`, `operator`, `approver`, `viewer`

## Engine behavior
- `engine-core` returns `PENDING_APPROVAL` when an unapproved node with `approvalRequired=true` is reached.
- Approved node resume uses `approvedNodeOrders` to avoid immediate re-blocking on that node.
