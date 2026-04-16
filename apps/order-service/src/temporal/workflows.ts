import { proxyActivities } from "@temporalio/workflow";

type EngineRunResult = {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "PENDING_APPROVAL";
  currentNodeOrder: number;
  currentStepIndex: number;
  failureReason?: string;
};

type TemporalRunPayload = {
  order: {
    id: string;
    workflowVersionId: string;
    environmentId?: string | null;
    status: string;
    currentNodeOrder: number;
    currentStepIndex: number;
    failurePolicy: string;
    correlationId: string;
    inputJson: unknown;
    envSnapshotJson?: unknown;
  };
  nodes: unknown[];
  integrationProfilesByNode: Record<string, unknown>;
  nodeEnvironmentsByNode: Record<string, unknown>;
  approvedNodeOrders?: number[];
};

const activities = proxyActivities<{
  executeOrderWorkflowActivity(payload: TemporalRunPayload): Promise<EngineRunResult>;
}>({
  startToCloseTimeout: "10 minute"
});

export async function orderExecutionWorkflow(payload: TemporalRunPayload): Promise<EngineRunResult> {
  return activities.executeOrderWorkflowActivity(payload);
}
