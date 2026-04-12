# Operations Guide: Workflow Builder UI

## Purpose
Provide controlled workflow draft creation and publish actions from the web console.

## Operator flow
1. Open the `Workflow Builder` panel.
2. Load or select an existing workflow.
3. Edit draft model (nodes/steps/retry policy).
4. Save as a new workflow draft.
5. Publish selected workflow when ready.

## Access expectations
- Draft creation requires operator or admin permissions on gateway.
- Publish requires admin permission.
- If token is missing or invalid, gateway will reject protected actions.

## Runtime dependencies
- `api-gateway` reachable at `NEXT_PUBLIC_API_BASE_URL`
- `workflow-service` healthy for create/list/get/publish routes

## Resume notes
- Saved drafts are persisted immediately when `Save As New Workflow` succeeds.
- Publish history remains traceable through workflow publish audits and event logs.
