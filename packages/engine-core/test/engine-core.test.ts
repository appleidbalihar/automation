import test from "node:test";
import assert from "node:assert/strict";
import { runWorkflowFromCheckpoint } from "../src/index.js";
import type { WorkflowNode } from "@platform/contracts";

test("resumes from checkpoint and skips prior node/steps", async () => {
  const executed: string[] = [];
  const nodes: WorkflowNode[] = [
    {
      id: "node-1",
      name: "Node 1",
      order: 0,
      configType: "Slice",
      approvalRequired: false,
      failurePolicy: "RETRY",
      steps: [
        {
          id: "step-1",
          name: "Step 1",
          executionType: "REST",
          commandRef: "cmd-1",
          inputVariables: {},
          successCriteria: "ok",
          retryPolicy: { maxRetries: 1, backoffMs: 100 }
        }
      ]
    },
    {
      id: "node-2",
      name: "Node 2",
      order: 1,
      configType: "DNN",
      approvalRequired: false,
      failurePolicy: "RETRY",
      steps: [
        {
          id: "step-2",
          name: "Step 2",
          executionType: "REST",
          commandRef: "cmd-2",
          inputVariables: {},
          successCriteria: "ok",
          retryPolicy: { maxRetries: 1, backoffMs: 100 }
        }
      ]
    }
  ];

  const result = await runWorkflowFromCheckpoint({
    order: {
      id: "order-1",
      currentNodeOrder: 1,
      currentStepIndex: 0,
      failurePolicy: "RETRY"
    },
    workflowNodes: nodes,
    input: {},
    checkpointStore: {
      async save(): Promise<void> {
        return;
      }
    },
    adapter: {
      async run(nodeId, step): Promise<{ ok: boolean }> {
        executed.push(`${nodeId}:${step.id}`);
        return { ok: true };
      }
    },
    auditStore: {
      async record(): Promise<void> {
        return;
      }
    }
  });

  assert.equal(executed.length, 1);
  assert.equal(executed[0], "node-2:step-2");
  assert.equal(result.status, "SUCCESS");
});

test("returns pending approval for node requiring approval", async () => {
  const nodes: WorkflowNode[] = [
    {
      id: "node-approval",
      name: "Approval Node",
      order: 0,
      configType: "Slice",
      approvalRequired: true,
      failurePolicy: "RETRY",
      steps: [
        {
          id: "step-1",
          name: "Step 1",
          executionType: "REST",
          commandRef: "cmd-1",
          inputVariables: {},
          successCriteria: "ok",
          retryPolicy: { maxRetries: 1, backoffMs: 100 }
        }
      ]
    }
  ];

  const result = await runWorkflowFromCheckpoint({
    order: {
      id: "order-approval",
      currentNodeOrder: 0,
      currentStepIndex: 0,
      failurePolicy: "RETRY"
    },
    workflowNodes: nodes,
    input: {},
    checkpointStore: {
      async save(): Promise<void> {
        return;
      }
    },
    adapter: {
      async run(): Promise<{ ok: boolean }> {
        return { ok: true };
      }
    },
    auditStore: {
      async record(): Promise<void> {
        return;
      }
    }
  });

  assert.equal(result.status, "PENDING_APPROVAL");
  assert.equal(result.currentNodeOrder, 0);
  assert.equal(result.currentStepIndex, 0);
});
