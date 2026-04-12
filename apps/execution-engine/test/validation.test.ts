import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowNode } from "@platform/contracts";
import { validateWorkflowNodes } from "../src/validation.js";

test("validateWorkflowNodes returns errors for duplicate ids and invalid ordering", () => {
  const nodes: WorkflowNode[] = [
    {
      id: "node-1",
      name: "Node 1",
      order: 0,
      configType: "SIMPLE",
      approvalRequired: false,
      failurePolicy: "RETRY",
      steps: [
        {
          id: "step-1",
          name: "Step 1",
          executionType: "SCRIPT",
          commandRef: "echo ok",
          inputVariables: {},
          successCriteria: "ok",
          retryPolicy: { maxRetries: 1, backoffMs: 100 }
        }
      ]
    },
    {
      id: "node-1",
      name: "Node 2",
      order: 0,
      configType: "SIMPLE",
      approvalRequired: false,
      failurePolicy: "RETRY",
      steps: []
    }
  ];

  const errors = validateWorkflowNodes(nodes);
  assert.ok(errors.some((line) => line.includes("Duplicate node id")));
  assert.ok(errors.some((line) => line.includes("Duplicate node order")));
  assert.ok(errors.some((line) => line.includes("must contain at least one step")));
});
