# Workflow Builder, Node Library, Test Execution, and Step Logging

This guide explains how to use the workflow builder after the reusable Node Library, JSON import/export, test execution, and per-step logging framework were added.

## What the node buttons mean

The workflow builder keeps the same runtime node model. The four built-in node buttons represent the primary authoring concepts:

### Trigger

Use `Trigger` when the workflow should start from an external event or an incoming request.

Common examples:

- an inbound order API call
- a scheduled platform event
- a webhook or system notification

In v1, if you want a trigger to represent an API-driven order initiation pattern, create it as a reusable template. The template can carry Swagger or OpenAPI metadata in its template metadata JSON for documentation and authoring guidance, while still serializing to the current workflow node model.

### Condition

Use `Condition` when the workflow must inspect inputs, state, or previous outcomes and decide which branch to follow.

Common examples:

- check whether configuration already exists
- decide whether approval is required
- branch based on environment, tenant, or request type
- detect retryable versus non-retryable failures

### Action

Use `Action` when the workflow should execute an operational task.

Common examples:

- authenticate to an external system
- call a REST endpoint
- run a script or command
- send a configuration request
- call another workflow through a prebuilt reusable template pattern

### Approval

Use `Approval` when a human or timed gate is required before continuing.

Common examples:

- require manual confirmation before a risky configuration change
- auto-approve or auto-reject after a timeout
- pause before production-impacting actions

## Worked example: authentication, config check, configure, ack, re-check, success

The following example flow is supported with the current plan and runtime:

1. `Trigger`
   Use an inbound order or API initiation template.
2. `Action`
   Authenticate and store the access token for later steps.
3. `Condition`
   Check whether the target configuration already exists.
4. Existing config branch
   Continue directly toward success if the configuration is already present.
5. Missing config branch
   Run a configuration action using the token.
6. `Action`
   Send the configuration request and capture the ack or response summary.
7. `Condition`
   Re-check whether the configuration completed successfully.
8. Success branch
   End with success when the configuration is complete.
9. Optional `Approval`
   Insert an approval step before the configuration action if the change is sensitive.

This pattern is a good candidate for reusable templates:

- an inbound API trigger template
- an authentication action template
- a config-exists condition template
- a configure action template
- a config-complete condition template

## Node Library

The `Node Library` page is an authenticated product page inside the existing platform shell. It does not introduce a new authentication mechanism. If a user is already signed in, they can access the page according to the same session or token checks used elsewhere in the platform.

### How to navigate to it

Users can open `Node Library` from the left navigation menu in the platform shell.

The left navigation now supports pin and unpin behavior:

- when pinned, the full navigation stays visible
- when unpinned, the navigation collapses
- use the visible reveal control to bring the navigation back

The page lets engineers:

- create reusable node templates
- edit template metadata and default configuration
- duplicate templates
- delete templates
- share templates with other users
- remove shared access
- import template JSON
- export template JSON
- preview the effective node configuration before using it

### Main page layout

The page opens in a list-first management view.

The table shows:

- template name
- category
- node type
- owner
- description
- access
- updated timestamp

Each row provides actions for:

- `View`
- `Update`
- `Duplicate`
- `Share`
- `Delete`

### Top-right actions

The page header actions include:

- `Create Template`
- `Import JSON`
- `Export JSON`

### Popup behavior

Create, update, view, share, and delete actions open popup dialogs.

Create, update, and view support two authoring modes:

- `Form`
- `JSON`

This lets engineers switch between guided editing and strict schema-based editing.

## Node Library field meanings

The main template fields are:

- `name`
  The reusable template name shown in the library and builder palette.
- `category`
  A grouping label such as `operations`, `api`, `approval`, or `recovery`.
- `nodeType`
  The workflow authoring type: `TRIGGER`, `CONDITION`, `ACTION`, or `APPROVAL`.
- `description`
  Human-readable guidance on when the template should be used.
- `tags`
  Search-friendly keywords for filtering and reuse.
- `configType`
  The internal configuration profile for the node template.
- `integrationProfileId`
  Optional default integration profile to use when the template is inserted.
- `environmentId`
  Optional default environment to use when the template is inserted.
- `failurePolicy`
  Runtime behavior on failure, such as retry, continue, or rollback.
- `approvalMode`
  Approval behavior for nodes that require a manual or timed gate.
- `approvalTimeoutSec`
  Timeout used when auto-timeout approval mode is active.
- `autoDecision`
  Decision taken when timed approval completes without manual action.
- `metadata`
  Extra authoring metadata, such as Swagger or OpenAPI references for trigger templates.

## Step and command fields

Each template can include multiple commands or steps in form mode.

Each step includes:

- `id`
  Unique identifier for the step. This is auto-generated and should not be edited manually.
- `name`
  Human-readable step name.
- `executionType`
  How the step runs, such as `REST`, `SSH`, `NETCONF`, or `SCRIPT`.
- `commandRef`
  The command, script, or API reference the step should execute.
- `timeoutSec`
  Maximum allowed time for the step before it is considered timed out.
- `requestTemplate`
  Optional request payload or request body template used when the step executes.
- `expectedResponse`
  Optional expected response reference or response pattern used for validation.
- `successCriteria`
  Legacy single success expression kept for compatibility.
- `successConditions`
  Multiple success conditions that can all be used to determine whether the step succeeded. Examples include `200 OK`, `201 Created`, `exit_code=0`, or a response status condition.
- `inputVariables`
  Named variables the step expects.
- `retryPolicy.maxRetries`
  Maximum retries for the step.
- `retryPolicy.backoffMs`
  Delay between retry attempts.
- `rollbackAction`
  Optional rollback action to use if reversal is needed.
- `loggingEnabled`
  Whether detailed correlated logs should be emitted for this step.

### Why step IDs are locked

Step IDs are intentionally auto-generated and read-only in the form flow.

This avoids collisions when:

- templates are duplicated
- templates are shared
- templates are imported from JSON
- templates are reused inside multiple workflows

If engineers use JSON mode, they should still treat step IDs as platform-managed identifiers.

## Reusing templates in workflows

After a template is saved in Node Library, engineers can go to the workflow builder and insert it from the reusable template section.

Typical reuse flow:

1. open `Node Library`
2. create or update a template
3. save the template
4. open `Workflow Builder`
5. find the template in the reusable template panel
6. insert it into the canvas
7. customize workflow-specific details if needed

The sharing model is:

- owner access
- explicitly shared users
- admin visibility

## How reusable templates are used in the builder

The workflow builder now includes a `Reusable Node Library` panel.

From that panel, users can:

- search templates by name, category, tag, or node type
- see whether a template is `OWNER`, `SHARED`, or `ADMIN` visible
- insert a reusable template directly into the current canvas

Inserted templates become normal editable workflow nodes. After insertion, the engineer can still:

- rename the node
- change integration or environment
- change approval behavior
- change failure policy
- edit execution fields
- duplicate the node

## Workflow JSON import and export

The builder now supports workflow JSON import and export.

### Export

Use `Export JSON` in the workflow editor to download the current workflow definition in the platform schema.

If the workflow already exists, export uses the backend export endpoint so the downloaded file includes workflow and version metadata. If the workflow is still unsaved, the editor exports the current local draft.

### Import

Use `Import JSON` in the workflow editor to upload a platform workflow JSON document. The platform validates the structure server-side and imports it as a new draft workflow.

This is the intended v1 path for AI-assisted authoring:

1. ask AI to draft platform workflow JSON
2. import the JSON into the builder
3. inspect and refine the imported workflow on the canvas
4. save, publish, and test it

## Node template JSON import and export

The Node Library page also supports JSON round-tripping.

Use template JSON import/export when:

- you want to move reusable patterns between environments
- you want AI to draft a reusable trigger, condition, action, or approval template
- you want a team-standard template pack for common tasks

For v1, import validation is strict on purpose. The platform validates the schema and returns clear errors rather than trying to guess what malformed AI JSON meant.

## Test / Execute in the workflow builder

The workflow builder now includes a `Test / Execute` panel.

It uses the existing tracked execution path:

- the builder calls the existing `POST /orders/execute`
- the platform creates a tracked test order
- the user can open the order detail and timeline from the result link

For v1, test execution runs the current published workflow version. If the workflow is still a draft, publish it first and then use the test button.

The test panel supports:

- choosing an optional test environment
- providing input JSON
- starting a tracked test execution
- jumping to the order timeline after the test order is created

## Standard execution and status framework

The platform now expects a consistent execution status model so engineers do not need to reinvent run-state handling in each implementation.

The standard lifecycle states are:

- `queued`
- `in_progress`
- `completed`
- `failed`
- `skipped`
- `pending_approval`
- `retrying`
- `rollback_in_progress`
- `rolled_back`

Operationally, the platform tracks execution with correlated identifiers such as:

- execution id
- order id
- workflow id
- workflow version id
- node id
- task id
- step id
- timestamps
- duration
- retry count
- branch outcome
- error message or error source

The builder and order views use that information to show:

- current node or step
- last completed step
- current order status
- final outcome

## Per-step detailed logging

Each step now has a `loggingEnabled` flag.

### Default behavior

Detailed step logging is `disabled` by default.

This is intentional so shared workflows do not flood the logging pipeline unless an engineer explicitly turns logging on for a step that needs extra operational traceability.

### Where to enable it

In the workflow builder:

1. select a node
2. open the `Execution` tab in the inspector
3. enable `Enable detailed step logging for this step`

### What happens when it is enabled

When a step with logging enabled executes, the platform emits correlated logs through the existing logging path to OpenSearch.

Each emitted record is correlated with fields such as:

- execution id
- order id
- workflow id
- workflow version id
- node id
- step id
- task id
- initiated by
- severity
- status or event type
- message

The logging path reuses the existing logging-service and OpenSearch integration. No second logging pipeline is introduced.

### How to search in OpenSearch

When detailed step logging is enabled, operators can search by:

- `executionId`
- `orderId`
- `workflowId`
- `workflowVersionId`
- `nodeId`
- `taskId`

That makes it safe for many users to run the same shared workflow because the logs remain correlated per execution rather than mixed globally.

## Recommended authoring pattern

For v1, use the platform in this order:

1. create or import reusable node templates in `Node Library`
2. insert those templates into the workflow builder
3. adjust the specific workflow behavior
4. save the draft
5. publish the version
6. run `Test / Execute`
7. inspect orders, timeline events, and detailed step logs when needed

## Notes for engineers

- The platform still uses the current workflow runtime model. The Node Library adds reuse, not a second engine.
- The builder test path uses the existing order execution route.
- Detailed step logging is selective by design. Only enable it where the extra traceability is worth the additional volume.
- JSON import is meant to help AI-assisted authoring, but the platform still validates strictly before accepting definitions.
