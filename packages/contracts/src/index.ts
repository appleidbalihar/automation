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
export type WorkflowNodeType = "TRIGGER" | "CONDITION" | "ACTION" | "APPROVAL";
export type ApprovalMode = "NONE" | "MANUAL" | "AUTO_WITH_TIMEOUT";
export type AutoDecision = "APPROVE" | "REJECT";

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
  successConditions?: string[];
  timeoutSec?: number;
  requestTemplate?: string;
  expectedResponse?: string;
  loggingEnabled: boolean;
  retryPolicy: RetryPolicy;
  rollbackAction?: string;
}

export interface WorkflowNode {
  id: string;
  name: string;
  order: number;
  nodeType: WorkflowNodeType;
  description?: string;
  configType: string;
  integrationProfileId?: string;
  environmentId?: string;
  approvalRequired: boolean;
  approvalMode: ApprovalMode;
  approvalTimeoutSec?: number;
  autoDecision?: AutoDecision;
  failurePolicy: FailurePolicy;
  steps: WorkflowStep[];
}

export interface WorkflowFlowNodeConfig {
  nodeType: WorkflowNodeType;
  description?: string;
  configType: string;
  integrationProfileId?: string;
  environmentId?: string;
  approvalRequired: boolean;
  approvalMode: ApprovalMode;
  approvalTimeoutSec?: number;
  autoDecision?: AutoDecision;
  failurePolicy: FailurePolicy;
  steps: WorkflowStep[];
}

export interface WorkflowFlowNode {
  id: string;
  type: "task";
  label: string;
  position: {
    x: number;
    y: number;
  };
  config: WorkflowFlowNodeConfig;
}

export interface WorkflowFlowEdge {
  id: string;
  source: string;
  target: string;
}

export interface WorkflowFlowDefinition {
  schemaVersion: "v2";
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
}

export interface NodeTemplateConfig {
  nodeType: WorkflowNodeType;
  description?: string;
  configType: string;
  integrationProfileId?: string;
  environmentId?: string;
  approvalRequired: boolean;
  approvalMode: ApprovalMode;
  approvalTimeoutSec?: number;
  autoDecision?: AutoDecision;
  failurePolicy: FailurePolicy;
  steps: WorkflowStep[];
}

export interface NodeTemplateDefinition {
  schemaVersion: "v1";
  name: string;
  description?: string;
  category?: string;
  tags?: string[];
  config: NodeTemplateConfig;
  metadata?: Record<string, unknown>;
}

function mapFlowNodeToWorkflowNode(node: WorkflowFlowNode, order: number): WorkflowNode {
  return {
    id: node.id,
    name: node.label,
    order,
    nodeType: node.config.nodeType,
    description: node.config.description,
    configType: node.config.configType,
    integrationProfileId: node.config.integrationProfileId,
    environmentId: node.config.environmentId,
    approvalRequired: node.config.approvalRequired,
    approvalMode: node.config.approvalMode,
    approvalTimeoutSec: node.config.approvalTimeoutSec,
    autoDecision: node.config.autoDecision,
    failurePolicy: node.config.failurePolicy,
    steps: node.config.steps.map((step) => ({
      ...step,
      successConditions:
        Array.isArray(step.successConditions) && step.successConditions.length > 0
          ? step.successConditions.map((condition) => String(condition))
          : undefined,
      timeoutSec: step.timeoutSec === undefined ? undefined : Math.max(0, Number(step.timeoutSec ?? 0)),
      requestTemplate: typeof step.requestTemplate === "string" ? step.requestTemplate : undefined,
      expectedResponse: typeof step.expectedResponse === "string" ? step.expectedResponse : undefined,
      loggingEnabled: Boolean(step.loggingEnabled)
    }))
  };
}

export function isWorkflowFlowDefinition(input: unknown): input is WorkflowFlowDefinition {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return value.schemaVersion === "v2" && Array.isArray(value.nodes) && Array.isArray(value.edges);
}

export function normalizeWorkflowFlow(input: unknown): WorkflowFlowDefinition {
  if (!isWorkflowFlowDefinition(input)) {
    throw new Error("INVALID_WORKFLOW_FLOW_SCHEMA");
  }

  const nodeIds = new Set<string>();
  for (const node of input.nodes) {
    if (!node.id || node.type !== "task") throw new Error("INVALID_WORKFLOW_FLOW_NODE");
    if (nodeIds.has(node.id)) throw new Error("DUPLICATE_WORKFLOW_FLOW_NODE_ID");
    nodeIds.add(node.id);
  }

  for (const edge of input.edges) {
    if (!edge.id || !edge.source || !edge.target) throw new Error("INVALID_WORKFLOW_FLOW_EDGE");
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      throw new Error("WORKFLOW_FLOW_EDGE_NODE_NOT_FOUND");
    }
  }

  return {
    schemaVersion: "v2",
    nodes: input.nodes.map((node) => ({
      id: node.id,
      type: "task",
      label: node.label,
      position: {
        x: Number(node.position?.x ?? 0),
        y: Number(node.position?.y ?? 0)
      },
      config: {
        nodeType: node.config.nodeType ?? "ACTION",
        description: typeof node.config.description === "string" ? node.config.description : undefined,
        configType: node.config.configType,
        integrationProfileId: node.config.integrationProfileId,
        environmentId: node.config.environmentId,
        approvalRequired:
          typeof node.config.approvalRequired === "boolean"
            ? node.config.approvalRequired
            : String(node.config.approvalMode ?? "NONE").toUpperCase() !== "NONE",
        approvalMode: (String(node.config.approvalMode ?? "NONE").toUpperCase() as ApprovalMode) || "NONE",
        approvalTimeoutSec:
          node.config.approvalTimeoutSec === undefined ? undefined : Math.max(0, Number(node.config.approvalTimeoutSec ?? 0)),
        autoDecision:
          node.config.autoDecision === undefined
            ? undefined
            : (String(node.config.autoDecision).toUpperCase() as AutoDecision),
        failurePolicy: node.config.failurePolicy,
        steps: node.config.steps.map((step) => ({
          ...step,
          successConditions:
            Array.isArray(step.successConditions) && step.successConditions.length > 0
              ? step.successConditions.map((condition) => String(condition))
              : undefined,
          timeoutSec: step.timeoutSec === undefined ? undefined : Math.max(0, Number(step.timeoutSec ?? 0)),
          requestTemplate: typeof step.requestTemplate === "string" ? step.requestTemplate : undefined,
          expectedResponse: typeof step.expectedResponse === "string" ? step.expectedResponse : undefined,
          loggingEnabled: Boolean(step.loggingEnabled)
        }))
      }
    })),
    edges: input.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target
    }))
  };
}

export function flowDefinitionToWorkflowNodes(flow: WorkflowFlowDefinition): WorkflowNode[] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const byId = new Map<string, WorkflowFlowNode>();
  for (const node of flow.nodes) {
    byId.set(node.id, node);
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }
  for (const edge of flow.edges) {
    adjacency.get(edge.source)?.push(edge.target);
    inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  }

  const queue = [...flow.nodes.filter((node) => (inDegree.get(node.id) ?? 0) === 0).map((node) => node.id)];
  const ordered: WorkflowNode[] = [];
  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    const node = byId.get(nodeId);
    if (!node) continue;
    ordered.push(mapFlowNodeToWorkflowNode(node, ordered.length));
    for (const neighbor of adjacency.get(nodeId) ?? []) {
      const nextDegree = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, nextDegree);
      if (nextDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (ordered.length !== flow.nodes.length) {
    throw new Error("WORKFLOW_FLOW_CONTAINS_CYCLE");
  }
  return ordered;
}

export interface WorkflowVersion {
  id: string;
  workflowId: string;
  version: number;
  status: "DRAFT" | "PUBLISHED";
  isActive: boolean;
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

export type NodeTemplateAccess = "OWNER" | "SHARED" | "ADMIN";

export interface NodeTemplateSummary {
  id: string;
  name: string;
  description?: string;
  category?: string;
  tags: string[];
  nodeType: WorkflowNodeType;
  access: NodeTemplateAccess;
  ownerId: string;
  sharedWithUsers: string[];
  updatedAt: string;
}

export interface NodeTemplateRecord extends NodeTemplateSummary {
  createdAt: string;
  metadata?: Record<string, unknown>;
  config: NodeTemplateConfig;
}

export interface WorkflowExportPayload {
  workflow: {
    id: string;
    name: string;
    description?: string | null;
  };
  version: {
    id: string;
    version: number;
    state: "DRAFT" | "PUBLISHED";
    status: "ACTIVE" | "INACTIVE";
  };
  flowDefinition: WorkflowFlowDefinition;
}

export interface WorkflowImportPayload {
  name: string;
  description?: string;
  flowDefinition: WorkflowFlowDefinition;
}

export type RagDiscussionMessageRole = "user" | "assistant";

export interface RagDiscussionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  preview?: string;
}

export interface RagDiscussionMessage {
  id: string;
  threadId: string;
  role: RagDiscussionMessageRole;
  content: string;
  createdAt: string;
}

export interface RagDiscussionThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  messages: RagDiscussionMessage[];
}

export interface RagDiscussionSendMessageRequest {
  content: string;
}

export interface RagDiscussionSendMessageResponse {
  thread: RagDiscussionSummary;
  userMessage: RagDiscussionMessage;
  assistantMessage: RagDiscussionMessage;
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
  certExpiryWarning: "cert.expiry.warning",
  certExpiryCritical: "cert.expiry.critical",
  certReloadFailed: "cert.reload.failed",
  certRotationTriggered: "cert.rotation.triggered",
  certRotationCompleted: "cert.rotation.completed",
  certRotationFailed: "cert.rotation.failed",
  certWebhookDeliveryFailed: "cert.webhook.delivery.failed"
} as const;
