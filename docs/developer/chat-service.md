# Developer Guide: Chat Service

## Overview
`chat-service` now returns context-aware operational answers using live order/workflow data while enforcing strict operational-only policy.

## Behavior
- Rejects backend/code-level prompts using keyword policy guardrails.
- If `orderId` is provided:
  - includes status, node/step pointer, checkpoint, and last error context.
- If `workflowId` is provided:
  - includes latest workflow version state.
- Adds targeted retry/rollback guidance when query intent includes those terms.

## API
- `POST /chat/query`
- `GET /chat/history/:userId`

## Persistence
- Every query/answer pair is persisted in `ChatHistory`.

## Tests
- `apps/chat-service/test/answers.test.ts` validates:
  - restricted prompt detection
  - restricted response behavior
  - order-context and retry guidance generation
