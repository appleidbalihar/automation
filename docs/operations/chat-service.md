# Operations Guide: Chat Service

## Purpose
Provide operational troubleshooting guidance without exposing backend implementation details.

## Expected behavior
- Accepts operational questions.
- Refuses backend/code internals.
- Uses order/workflow context when IDs are supplied.

## Example usage
- Ask with order context: include `orderId` in request body.
- Ask with workflow context: include `workflowId`.

## Validation checks
1. Operational query returns non-restricted response.
2. Backend/code query returns `restricted=true`.
3. Query with existing order ID includes live status guidance.
