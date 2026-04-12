# Developer Guide: Execution Tracking and Resume

## Objective
Persist workflow execution state so failures can resume from the last successful checkpoint without rerunning completed successful steps.

## Data model
- `Order`: current status, current node/step pointers, failure policy, correlation ID.
- `ExecutionCheckpoint`: durable node/step checkpoint writes after each successful step.
- `StatusTransition`: chronological status changes with reason.
- `StepExecution`: step-level execution audit with status, duration, and error metadata.

## Engine behavior
- `runWorkflowFromCheckpoint` in `packages/engine-core` starts from `order.currentNodeOrder` and `order.currentStepIndex`.
- For each successful step:
  - write step audit success
  - write checkpoint
  - advance order pointer
- For each failed step:
  - write step audit failure
  - apply failure policy mapping:
    - `CONTINUE` -> continue node flow and return partial execution if any failure occurred
    - `ROLLBACK` -> return failed with rollback-required reason
    - `RETRY` -> fail and preserve exact failed pointer for retry

## Retry and rollback API hooks
- `POST /orders/:id/retry` marks order back to `RUNNING` and keeps last known pointer as resume origin.
- `POST /orders/:id/rollback` marks transitions to `ROLLING_BACK` then `ROLLED_BACK` in current skeleton.

