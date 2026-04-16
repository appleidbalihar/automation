import assert from "node:assert/strict";
import test from "node:test";
import { flowDefinitionToWorkflowNodes, isWorkflowFlowDefinition, normalizeWorkflowFlow } from "../src/index.ts";

test("normalizeWorkflowFlow accepts valid v2 flow definition", () => {
  const flow = normalizeWorkflowFlow({
    schemaVersion: "v2",
    nodes: [
      {
        id: "node-a",
        type: "task",
        label: "Node A",
        position: { x: 10, y: 20 },
        config: {
          configType: "SIMPLE",
          approvalRequired: false,
          failurePolicy: "RETRY",
          steps: [
            {
              id: "step-a",
              name: "Step A",
              executionType: "SCRIPT",
              commandRef: "echo ok",
              inputVariables: {},
              successCriteria: "ok",
              retryPolicy: { maxRetries: 1, backoffMs: 100 }
            }
          ]
        }
      }
    ],
    edges: []
  });
  assert.equal(isWorkflowFlowDefinition(flow), true);
  assert.equal(flow.schemaVersion, "v2");
  assert.equal(flow.nodes.length, 1);
});

test("flowDefinitionToWorkflowNodes sorts by edge topology", () => {
  const flow = normalizeWorkflowFlow({
    schemaVersion: "v2",
    nodes: [
      {
        id: "node-b",
        type: "task",
        label: "Node B",
        position: { x: 250, y: 40 },
        config: {
          configType: "SIMPLE",
          approvalRequired: false,
          failurePolicy: "RETRY",
          steps: []
        }
      },
      {
        id: "node-a",
        type: "task",
        label: "Node A",
        position: { x: 10, y: 40 },
        config: {
          configType: "SIMPLE",
          approvalRequired: false,
          failurePolicy: "RETRY",
          steps: []
        }
      }
    ],
    edges: [{ id: "edge-a-b", source: "node-a", target: "node-b" }]
  });
  const nodes = flowDefinitionToWorkflowNodes(flow);
  assert.equal(nodes[0].id, "node-a");
  assert.equal(nodes[1].id, "node-b");
  assert.equal(nodes[0].order, 0);
  assert.equal(nodes[1].order, 1);
});

test("flowDefinitionToWorkflowNodes rejects cyclic graph", () => {
  const flow = normalizeWorkflowFlow({
    schemaVersion: "v2",
    nodes: [
      {
        id: "node-a",
        type: "task",
        label: "Node A",
        position: { x: 10, y: 40 },
        config: {
          configType: "SIMPLE",
          approvalRequired: false,
          failurePolicy: "RETRY",
          steps: []
        }
      },
      {
        id: "node-b",
        type: "task",
        label: "Node B",
        position: { x: 250, y: 40 },
        config: {
          configType: "SIMPLE",
          approvalRequired: false,
          failurePolicy: "RETRY",
          steps: []
        }
      }
    ],
    edges: [
      { id: "edge-a-b", source: "node-a", target: "node-b" },
      { id: "edge-b-a", source: "node-b", target: "node-a" }
    ]
  });
  assert.throws(() => flowDefinitionToWorkflowNodes(flow), /WORKFLOW_FLOW_CONTAINS_CYCLE/);
});
