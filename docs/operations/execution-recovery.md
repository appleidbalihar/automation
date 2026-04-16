# Operations Guide: Failure Recovery

## What is tracked
- Every order tracks current node and step progress.
- Every successful step writes a checkpoint.
- Every status change is recorded with timestamp and reason.

## How resume works
- If execution stops, the order can continue from the last successful checkpoint.
- Completed successful steps are not rerun by default.
- Retry starts from the failed point.

## Operator actions
- Use order details to inspect:
  - current status
  - transition timeline
  - failed step details
  - checkpoint progression
- Use retry for transient failures.
- Use rollback when partial changes must be reversed for consistency.

## Security and visibility
- Logs are stored with masking for sensitive fields (`password`, `token`, `secret`).
