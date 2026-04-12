export type ExecutionType = "REST" | "SSH" | "NETCONF" | "SCRIPT";
export type IntegrationAuthType = "NO_AUTH" | "OAUTH2" | "BASIC" | "MTLS" | "API_KEY" | "OIDC" | "JWT";
export type IntegrationLifecycleState = "ACTIVE" | "INACTIVE" | "TERMINATED";
export type OrderStatus =
  | "PENDING"
  | "RUNNING"
  | "PENDING_APPROVAL"
  | "FAILED"
  | "PARTIAL"
  | "SUCCESS"
  | "ROLLING_BACK"
  | "ROLLED_BACK";

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
  integrationProfileId?: string;
  environmentId?: string;
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
  environmentId?: string;
  status: OrderStatus;
  currentNodeOrder: number;
  currentStepIndex: number;
  failurePolicy: FailurePolicy;
  correlationId: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalDecision {
  id: string;
  orderId: string;
  nodeOrder?: number;
  decision: "APPROVED" | "REJECTED";
  decidedBy: string;
  comment?: string;
  createdAt: string;
}

export interface OrderExecutionRequest {
  workflowVersionId: string;
  environmentId?: string;
  input: Record<string, unknown>;
  initiatedBy: string;
}

export interface IntegrationProfile {
  id: string;
  name: string;
  ownerId: string;
  executionType: ExecutionType;
  authType: IntegrationAuthType;
  lifecycleState: IntegrationLifecycleState;
  baseConfig?: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserEnvironment {
  id: string;
  name: string;
  ownerId: string;
  variables: Record<string, unknown>;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
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

export const PlatformEvents = {
  workflowPublished: "workflow.published",
  orderCreated: "order.created",
  orderExecutionResumed: "order.execution.resumed",
  orderNodeStarted: "order.node.started",
  orderNodeCompleted: "order.node.completed",
  orderNodeFailed: "order.node.failed",
  executionStepStarted: "execution.step.started",
  executionStepCompleted: "execution.step.completed",
  executionStepFailed: "execution.step.failed",
  executionRollbackStarted: "execution.rollback.started",
  executionRollbackCompleted: "execution.rollback.completed",
  logsIngest: "logs.ingest",
  ragIndexRequested: "rag.index.requested",
  certExpiryWarning: "cert.expiry.warning",
  certExpiryCritical: "cert.expiry.critical",
  certReloadFailed: "cert.reload.failed",
  certRotationTriggered: "cert.rotation.triggered",
  certRotationCompleted: "cert.rotation.completed",
  certRotationFailed: "cert.rotation.failed",
  certWebhookDeliveryFailed: "cert.webhook.delivery.failed"
} as const;
