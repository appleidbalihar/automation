export type ExecutionType = "REST" | "SSH" | "NETCONF" | "SCRIPT";
export type OrderStatus = "PENDING" | "RUNNING" | "PENDING_APPROVAL" | "FAILED" | "PARTIAL" | "SUCCESS" | "ROLLING_BACK" | "ROLLED_BACK";
export type FailurePolicy = "RETRY" | "CONTINUE" | "ROLLBACK";
export interface RetryPolicy {
    maxRetries: number;
    backoffMs: number;
}
export interface WorkflowStep {
    id: string;
    name: string;
    executionType: ExecutionType;
    commandRef: string;
    inputVariables: Record<string, string>;
    successCriteria: string;
    retryPolicy: RetryPolicy;
    rollbackAction?: string;
}
export interface WorkflowNode {
    id: string;
    name: string;
    order: number;
    configType: string;
    approvalRequired: boolean;
    failurePolicy: FailurePolicy;
    steps: WorkflowStep[];
}
export interface WorkflowVersion {
    id: string;
    workflowId: string;
    version: number;
    status: "DRAFT" | "PUBLISHED";
    createdAt: string;
    nodes: WorkflowNode[];
}
export interface Workflow {
    id: string;
    name: string;
    description?: string;
    latestVersionId?: string;
    createdAt: string;
    updatedAt: string;
}
export interface ExecutionCheckpoint {
    orderId: string;
    nodeOrder: number;
    stepIndex: number;
    updatedAt: string;
}
export interface OrderStepExecution {
    orderId: string;
    nodeId: string;
    stepId: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED";
    retryCount: number;
    durationMs: number;
    errorSource?: "SBI" | "INTERNAL";
    errorMessage?: string;
    requestPayload?: Record<string, unknown>;
    responsePayload?: Record<string, unknown>;
    startedAt: string;
    finishedAt: string;
}
export interface Order {
    id: string;
    workflowVersionId: string;
    status: OrderStatus;
    currentNodeOrder: number;
    currentStepIndex: number;
    failurePolicy: FailurePolicy;
    correlationId: string;
    lastError?: string;
    createdAt: string;
    updatedAt: string;
}
export interface OrderExecutionRequest {
    workflowVersionId: string;
    input: Record<string, unknown>;
    initiatedBy: string;
}
export interface ChatQuery {
    query: string;
    workflowId?: string;
    orderId?: string;
    userId: string;
}
export interface ChatResponse {
    answer: string;
    citations: string[];
    restricted: boolean;
}
export interface PlatformEvent<T> {
    event: string;
    timestamp: string;
    payload: T;
}
export declare const PlatformEvents: {
    readonly workflowPublished: "workflow.published";
    readonly orderCreated: "order.created";
    readonly orderExecutionResumed: "order.execution.resumed";
    readonly orderNodeStarted: "order.node.started";
    readonly orderNodeCompleted: "order.node.completed";
    readonly orderNodeFailed: "order.node.failed";
    readonly executionStepStarted: "execution.step.started";
    readonly executionStepCompleted: "execution.step.completed";
    readonly executionStepFailed: "execution.step.failed";
    readonly executionRollbackStarted: "execution.rollback.started";
    readonly executionRollbackCompleted: "execution.rollback.completed";
    readonly logsIngest: "logs.ingest";
    readonly ragIndexRequested: "rag.index.requested";
};
//# sourceMappingURL=index.d.ts.map