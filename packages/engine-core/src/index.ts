import type { FailurePolicy, Order, WorkflowNode, WorkflowStep } from "@platform/contracts";

export interface CheckpointStore {
  save(orderId: string, nodeOrder: number, stepIndex: number): Promise<void>;
}

export interface StepAdapter {
  run(
    nodeId: string,
    step: WorkflowStep,
    input: Record<string, unknown>
  ): Promise<{
    ok: boolean;
    output?: unknown;
    error?: string;
    requestPayload?: Record<string, unknown>;
    responsePayload?: Record<string, unknown>;
  }>;
}

export interface StepAuditStore {
  record(entry: {
    orderId: string;
    nodeId: string;
    stepId: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED";
    retryCount: number;
    durationMs: number;
    errorMessage?: string;
    requestPayload?: Record<string, unknown>;
    responsePayload?: Record<string, unknown>;
    startedAt: string;
    finishedAt: string;
  }): Promise<void>;
}

export interface EngineRunContext {
  order: Pick<Order, "id" | "currentNodeOrder" | "currentStepIndex" | "failurePolicy">;
  workflowNodes: WorkflowNode[];
  input: Record<string, unknown>;
  approvedNodeOrders?: number[];
  checkpointStore: CheckpointStore;
  adapter: StepAdapter;
  auditStore: StepAuditStore;
}

export interface EngineRunResult {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "PENDING_APPROVAL";
  currentNodeOrder: number;
  currentStepIndex: number;
  failureReason?: string;
}

function nextOnFailure(policy: FailurePolicy): "CONTINUE_NODE" | "ROLLBACK" | "FAIL" {
  if (policy === "CONTINUE") return "CONTINUE_NODE";
  if (policy === "ROLLBACK") return "ROLLBACK";
  return "FAIL";
}

export async function runWorkflowFromCheckpoint(context: EngineRunContext): Promise<EngineRunResult> {
  let currentNodeOrder = context.order.currentNodeOrder;
  let currentStepIndex = context.order.currentStepIndex;
  let partial = false;
  const approvedNodeOrders = new Set(context.approvedNodeOrders ?? []);

  for (const node of context.workflowNodes) {
    if (node.order < currentNodeOrder) {
      continue;
    }

    const startStep = node.order === currentNodeOrder ? currentStepIndex : 0;
    if (startStep === 0 && node.approvalRequired && !approvedNodeOrders.has(node.order)) {
      return {
        status: "PENDING_APPROVAL",
        currentNodeOrder: node.order,
        currentStepIndex: 0,
        failureReason: `Approval required for node ${node.id}`
      };
    }

    for (let stepIndex = startStep; stepIndex < node.steps.length; stepIndex += 1) {
      const step = node.steps[stepIndex];
      const started = Date.now();
      const run = await context.adapter.run(node.id, step, context.input);
      const finished = Date.now();
      const durationMs = finished - started;
      const startedAt = new Date(started).toISOString();
      const finishedAt = new Date(finished).toISOString();

      if (!run.ok) {
        await context.auditStore.record({
          orderId: context.order.id,
          nodeId: node.id,
          stepId: step.id,
          status: "FAILED",
          retryCount: 0,
          durationMs,
          errorMessage: run.error ?? "Unknown execution error",
          requestPayload: run.requestPayload,
          responsePayload: run.responsePayload,
          startedAt,
          finishedAt
        });
        const action = nextOnFailure(node.failurePolicy ?? context.order.failurePolicy);
        if (action === "CONTINUE_NODE") {
          partial = true;
          break;
        }
        if (action === "ROLLBACK") {
          return {
            status: "FAILED",
            currentNodeOrder: node.order,
            currentStepIndex: stepIndex,
            failureReason: `Rollback required after failure on ${node.id}/${step.id}: ${run.error ?? "unknown"}`
          };
        }
        return {
          status: "FAILED",
          currentNodeOrder: node.order,
          currentStepIndex: stepIndex,
          failureReason: run.error ?? "Execution failed"
        };
      }

      await context.auditStore.record({
        orderId: context.order.id,
        nodeId: node.id,
        stepId: step.id,
        status: "SUCCESS",
        retryCount: 0,
        durationMs,
        requestPayload: run.requestPayload,
        responsePayload: run.responsePayload,
        startedAt,
        finishedAt
      });

      await context.checkpointStore.save(context.order.id, node.order, stepIndex + 1);
      currentNodeOrder = node.order;
      currentStepIndex = stepIndex + 1;
    }

    currentNodeOrder = node.order + 1;
    currentStepIndex = 0;
  }

  return {
    status: partial ? "PARTIAL" : "SUCCESS",
    currentNodeOrder,
    currentStepIndex
  };
}
