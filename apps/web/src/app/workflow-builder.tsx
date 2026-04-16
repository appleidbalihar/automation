"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactFlow, {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Panel,
  Position,
  getSmoothStepPath,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps
} from "reactflow";
import "reactflow/dist/style.css";
import { resolveApiBase } from "./api-base";
import { fetchIdentity } from "./auth-client";

type FailurePolicy = "RETRY" | "CONTINUE" | "ROLLBACK";
type ExecutionType = "REST" | "SSH" | "NETCONF" | "SCRIPT";
type WorkflowNodeType = "TRIGGER" | "CONDITION" | "ACTION" | "APPROVAL";
type ApprovalMode = "NONE" | "MANUAL" | "AUTO_WITH_TIMEOUT";
type AutoDecision = "APPROVE" | "REJECT";
type WorkflowState = "DRAFT" | "PUBLISHED" | "NONE";
type WorkflowStatus = "ACTIVE" | "INACTIVE";
type EditorMode = "catalog" | "editor";
type InspectorTab = "node" | "execution" | "approval" | "version";

interface WorkflowCatalogRow {
  id: string;
  name: string;
  description: string | null;
  version: number | null;
  state: WorkflowState;
  status: WorkflowStatus;
  selectedVersionId: string | null;
  updatedAt: string;
}

interface WorkflowVersionRecord {
  id: string;
  version: number;
  state: "DRAFT" | "PUBLISHED";
  status: WorkflowStatus;
  createdAt: string;
  nodesJson?: unknown;
}

interface WorkflowDetailsResponse {
  workflow: {
    id: string;
    name: string;
    description?: string | null;
    latestVersionId?: string | null;
    updatedAt?: string;
  };
  versions: WorkflowVersionRecord[];
}

interface PlannerPreview {
  nodesAdded: string[];
  nodesRemoved: string[];
  nodesChanged: string[];
  edgesAdded: number;
  edgesRemoved: number;
  approvalsChanged: string[];
}

interface PlannerResponse {
  flowDefinition: CanonicalFlow;
  summary: string;
  changePreview: PlannerPreview;
  diagnostics?: {
    planner?: {
      attempts: number;
      plannerStatus: number;
      latencyMs: number;
    };
    validated?: boolean;
    errors?: string[];
    degraded?: boolean;
  };
}

interface BuilderStep {
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
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
  };
  rollbackAction?: string;
}

interface FlowNodeConfig {
  configType: string;
  integrationProfileId?: string;
  environmentId?: string;
  approvalRequired: boolean;
  approvalMode: ApprovalMode;
  approvalTimeoutSec?: number;
  autoDecision?: AutoDecision;
  failurePolicy: FailurePolicy;
  steps: BuilderStep[];
}

interface FlowNodeData {
  label: string;
  description?: string;
  nodeType: WorkflowNodeType;
  config: FlowNodeConfig;
}

interface CanonicalFlow {
  schemaVersion: "v2";
  nodes: Array<{
    id: string;
    type: "task";
    label: string;
    description?: string;
    position: { x: number; y: number };
    config: FlowNodeConfig & { nodeType?: WorkflowNodeType };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
  }>;
}

interface IntegrationProfileRecord {
  id: string;
  name: string;
  executionType: ExecutionType;
}

interface UserEnvironmentRecord {
  id: string;
  name: string;
}

type NodeTemplateAccess = "OWNER" | "SHARED" | "ADMIN";

interface NodeTemplateSummary {
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

interface NodeTemplateRecord extends NodeTemplateSummary {
  createdAt: string;
  config: FlowNodeConfig;
  metadata?: Record<string, unknown>;
}

interface WorkflowExportPayload {
  workflow: {
    id: string;
    name: string;
    description?: string | null;
  };
  version: {
    id: string;
    version: number;
    state: "DRAFT" | "PUBLISHED";
    status: WorkflowStatus;
  };
  flowDefinition: CanonicalFlow;
}

interface ExecuteOrderResponse {
  orderId: string;
  result: {
    status: string;
    currentNodeOrder: number;
    currentStepIndex: number;
    failureReason?: string;
  };
}

interface PlannerMessage {
  id: string;
  role: "user" | "planner" | "system";
  text: string;
  createdAt: string;
  proposal?: PlannerResponse;
}

const NODE_TYPES: WorkflowNodeType[] = ["TRIGGER", "CONDITION", "ACTION", "APPROVAL"];

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultStep(nodeType: WorkflowNodeType): BuilderStep {
  return {
    id: makeId("step"),
    name: `${nodeType} Step`,
    executionType: "SCRIPT",
    commandRef: nodeType === "TRIGGER" ? "listen:event" : "echo ok",
    inputVariables: {},
    successCriteria: "exit_code=0",
    successConditions: ["exit_code=0"],
    timeoutSec: 60,
    requestTemplate: "",
    expectedResponse: "",
    loggingEnabled: false,
    retryPolicy: {
      maxRetries: 1,
      backoffMs: 250
    }
  };
}

function cloneBuilderStep(step: BuilderStep, fallbackNodeType: WorkflowNodeType): BuilderStep {
  return {
    id: makeId("step"),
    name: step.name || `${fallbackNodeType} Step`,
    executionType: step.executionType,
    commandRef: step.commandRef,
    inputVariables: { ...(step.inputVariables ?? {}) },
    successCriteria: step.successCriteria,
    successConditions: Array.isArray(step.successConditions) ? [...step.successConditions] : undefined,
    timeoutSec: step.timeoutSec,
    requestTemplate: step.requestTemplate,
    expectedResponse: step.expectedResponse,
    loggingEnabled: Boolean(step.loggingEnabled),
    retryPolicy: {
      maxRetries: Number(step.retryPolicy?.maxRetries ?? 1),
      backoffMs: Number(step.retryPolicy?.backoffMs ?? 250)
    },
    rollbackAction: step.rollbackAction
  };
}

function cloneNodeConfig(config: FlowNodeConfig, nodeType: WorkflowNodeType): FlowNodeConfig {
  return {
    ...config,
    approvalRequired: Boolean(config.approvalRequired ?? config.approvalMode !== "NONE"),
    approvalMode: config.approvalMode ?? "NONE",
    failurePolicy: config.failurePolicy ?? "RETRY",
    steps:
      Array.isArray(config.steps) && config.steps.length > 0
        ? config.steps.map((step) => cloneBuilderStep(step, nodeType))
        : [createDefaultStep(nodeType)]
  };
}

function createNodeData(nodeType: WorkflowNodeType, index: number): FlowNodeData {
  let approvalMode: ApprovalMode = "NONE";
  if (nodeType === "APPROVAL") {
    approvalMode = "MANUAL";
  }
  return {
    label:
      nodeType === "TRIGGER"
        ? "Trigger"
        : nodeType === "CONDITION"
          ? "Condition"
          : nodeType === "APPROVAL"
            ? "Approval Gate"
            : `Action ${index + 1}`,
    description:
      nodeType === "TRIGGER"
        ? "Start the workflow"
        : nodeType === "CONDITION"
          ? "Validate or branch on input"
          : nodeType === "APPROVAL"
            ? "Pause for human or timed decision"
            : "Execute an operational task",
    nodeType,
    config: {
      configType: "SIMPLE",
      integrationProfileId: undefined,
      environmentId: undefined,
      approvalRequired: approvalMode !== "NONE",
      approvalMode,
      approvalTimeoutSec: undefined,
      autoDecision: undefined,
      failurePolicy: "RETRY",
      steps: [createDefaultStep(nodeType)]
    }
  };
}

function createFlowNode(nodeType: WorkflowNodeType, index: number): Node<FlowNodeData> {
  return {
    id: makeId("node"),
    type: "workflowNode",
    position: {
      x: 160 + (index % 3) * 300,
      y: 120 + Math.floor(index / 3) * 180
    },
    data: createNodeData(nodeType, index)
  };
}

function createFlowNodeFromTemplate(template: NodeTemplateSummary | NodeTemplateRecord, index: number): Node<FlowNodeData> {
  const config =
    "config" in template
      ? cloneNodeConfig(template.config, template.nodeType)
      : cloneNodeConfig(createNodeData(template.nodeType, index).config, template.nodeType);
  return {
    id: makeId("node"),
    type: "workflowNode",
    position: {
      x: 180 + (index % 3) * 320,
      y: 140 + Math.floor(index / 3) * 190
    },
    data: {
      label: template.name,
      description: template.description,
      nodeType: template.nodeType,
      config
    }
  };
}

function blankFlow(): CanonicalFlow {
  return {
    schemaVersion: "v2",
    nodes: [],
    edges: []
  };
}

async function requestJson<T>(path: string, method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const token = typeof window !== "undefined" ? window.localStorage.getItem("ops_bearer_token") ?? "" : "";
  const headers: Record<string, string> = {};
  if (token.trim()) {
    headers.authorization = `Bearer ${token.trim().replace(/^Bearer\s+/i, "")}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  const payload = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    const message = payload?.details ?? payload?.error ?? payload?.message ?? `HTTP ${response.status}`;
    throw new Error(String(message));
  }
  return payload as T;
}

function asCanonicalFlow(value: unknown): CanonicalFlow {
  const candidate = value as CanonicalFlow | undefined;
  if (!candidate || candidate.schemaVersion !== "v2" || !Array.isArray(candidate.nodes) || !Array.isArray(candidate.edges)) {
    return blankFlow();
  }
  return {
    schemaVersion: "v2",
    nodes: candidate.nodes.map((node, index) => {
      const typeFromLegacyRoot = (node as any).nodeType;
      const typeFromConfig = node.config?.nodeType;
      const resolvedType = typeFromConfig ?? typeFromLegacyRoot ?? "ACTION";
      return {
        id: node.id,
        type: "task",
        label: node.label,
        description: node.description,
        position: node.position ?? { x: 120 + index * 280, y: 180 },
        config: {
          nodeType: resolvedType,
          configType: node.config?.configType ?? "SIMPLE",
          integrationProfileId: node.config?.integrationProfileId,
          environmentId: node.config?.environmentId,
          approvalRequired: Boolean(node.config?.approvalRequired ?? node.config?.approvalMode !== "NONE"),
          approvalMode: node.config?.approvalMode ?? "NONE",
          approvalTimeoutSec: node.config?.approvalTimeoutSec,
          autoDecision: node.config?.autoDecision,
          failurePolicy: node.config?.failurePolicy ?? "RETRY",
          steps:
            Array.isArray(node.config?.steps) && node.config.steps.length > 0
              ? node.config.steps
              : [createDefaultStep(resolvedType)]
        }
      };
    }),
    edges: candidate.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target
    }))
  };
}

function flowToNodes(flow: CanonicalFlow): Array<Node<FlowNodeData>> {
  return flow.nodes.map((node) => ({
    id: node.id,
    type: "workflowNode",
    position: node.position,
    data: {
      label: node.label,
      description: node.description,
      nodeType: node.config?.nodeType ?? "ACTION",
      config: node.config
    }
  }));
}

function flowToEdges(flow: CanonicalFlow): Edge[] {
  return flow.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "workflowEdge",
    markerEnd: { type: MarkerType.ArrowClosed },
    animated: true
  }));
}

function editorFlow(nodes: Array<Node<FlowNodeData>>, edges: Edge[]): CanonicalFlow {
  return {
    schemaVersion: "v2",
    nodes: nodes.map((node) => ({
      id: node.id,
      type: "task",
      label: node.data.label,
      description: node.data.description,
      position: {
        x: node.position.x,
        y: node.position.y
      },
      config: {
        ...node.data.config,
        nodeType: node.data.nodeType,
        approvalRequired: node.data.config.approvalMode !== "NONE"
      }
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target
    }))
  };
}

function formatDate(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function statusClass(state: string): string {
  const normalized = state.toLowerCase();
  return `workflow-badge workflow-badge-${normalized}`;
}

function nodeTypeBandClass(nodeType: WorkflowNodeType): string {
  return `workflow-node-card workflow-node-${nodeType.toLowerCase()}`;
}

function AnimatedWorkflowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd }: EdgeProps): ReactElement {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  });
  return <path d={path} fill="none" markerEnd={markerEnd} className="react-flow__edge-path workflow-custom-edge-path" />;
}

function WorkflowCanvasNode({ data, selected }: NodeProps<FlowNodeData>): ReactElement {
  return (
    <div className={`${nodeTypeBandClass(data.nodeType)}${selected ? " workflow-node-selected" : ""}`}>
      <Handle type="target" position={Position.Top} className="workflow-handle" />
      <div className="workflow-node-band">
        <span>{data.nodeType}</span>
        <span className="workflow-node-dot" />
      </div>
      <div className="workflow-node-body">
        <div className="workflow-node-title">{data.label}</div>
        <div className="workflow-node-description">{data.description || "No description configured"}</div>
      </div>
      <Handle type="source" position={Position.Bottom} className="workflow-handle" />
    </div>
  );
}

const nodeTypes = {
  workflowNode: WorkflowCanvasNode
};

const edgeTypes = {
  workflowEdge: AnimatedWorkflowEdge
};

export function WorkflowBuilderPanel(): ReactElement {
  const [editorMode, setEditorMode] = useState<EditorMode>("catalog");
  const [roles, setRoles] = useState<string[]>([]);
  const [userId, setUserId] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(true);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [workflows, setWorkflows] = useState<WorkflowCatalogRow[]>([]);
  const [integrationProfiles, setIntegrationProfiles] = useState<IntegrationProfileRecord[]>([]);
  const [environments, setEnvironments] = useState<UserEnvironmentRecord[]>([]);
  const [nodeTemplates, setNodeTemplates] = useState<NodeTemplateSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [selectedPreviewVersionId, setSelectedPreviewVersionId] = useState<string>("");
  const [previewDetails, setPreviewDetails] = useState<WorkflowDetailsResponse | null>(null);
  const [previewFlow, setPreviewFlow] = useState<CanonicalFlow>(blankFlow());
  const [editorWorkflowId, setEditorWorkflowId] = useState<string>("");
  const [editorVersionId, setEditorVersionId] = useState<string>("");
  const [editorName, setEditorName] = useState<string>("Untitled Workflow");
  const [editorDescription, setEditorDescription] = useState<string>("");
  const [editorState, setEditorState] = useState<"DRAFT" | "PUBLISHED">("DRAFT");
  const [editorStatus, setEditorStatus] = useState<WorkflowStatus>("INACTIVE");
  const [nodes, setNodes] = useState<Array<Node<FlowNodeData>>>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [inspectorCollapsed, setInspectorCollapsed] = useState<boolean>(false);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("node");
  const [plannerDockOpen, setPlannerDockOpen] = useState<boolean>(false);
  const [plannerPrompt, setPlannerPrompt] = useState<string>("");
  const [plannerBusy, setPlannerBusy] = useState<boolean>(false);
  const [plannerMessages, setPlannerMessages] = useState<PlannerMessage[]>([]);
  const [plannerProposal, setPlannerProposal] = useState<PlannerResponse | null>(null);
  const [resetPreview, setResetPreview] = useState<Record<string, number> | null>(null);
  const [templateSearch, setTemplateSearch] = useState<string>("");
  const [testEnvironmentId, setTestEnvironmentId] = useState<string>("");
  const [testInputJson, setTestInputJson] = useState<string>('{\n  "mode": "test"\n}');
  const [executingTest, setExecutingTest] = useState<boolean>(false);
  const [lastTestResult, setLastTestResult] = useState<ExecuteOrderResponse | null>(null);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  const isAdmin = roles.includes("admin");
  const selectedNode = useMemo(() => nodes.find((node) => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId]);
  const previewVersions = previewDetails?.versions ?? [];
  const previewEdges = useMemo(() => flowToEdges(previewFlow), [previewFlow]);
  const previewNodes = useMemo(() => flowToNodes(previewFlow), [previewFlow]);
  const filteredTemplates = useMemo(() => {
    const search = templateSearch.trim().toLowerCase();
    if (!search) return nodeTemplates;
    return nodeTemplates.filter((template) =>
      [template.name, template.description ?? "", template.category ?? "", template.tags.join(" "), template.nodeType]
        .join(" ")
        .toLowerCase()
        .includes(search)
    );
  }, [nodeTemplates, templateSearch]);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    Promise.all([
      fetchIdentity(),
      requestJson<WorkflowCatalogRow[]>("/workflows", "GET"),
      requestJson<IntegrationProfileRecord[]>("/integrations?scope=all", "GET"),
      requestJson<UserEnvironmentRecord[]>("/environments?scope=all", "GET"),
      requestJson<NodeTemplateSummary[]>("/node-templates?scope=all", "GET")
    ])
      .then(([identity, workflowRows, integrationRows, environmentRows, templateRows]) => {
        if (!mounted) return;
        setRoles(identity.roles);
        setUserId(identity.userId);
        setWorkflows(workflowRows);
        setIntegrationProfiles(integrationRows);
        setEnvironments(environmentRows);
        setNodeTemplates(templateRows);
        const defaultWorkflowId = selectedWorkflowId || workflowRows[0]?.id || "";
        setSelectedWorkflowId(defaultWorkflowId);
      })
      .catch((loadError) => {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load workflow studio context");
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });
    return () => {
      mounted = false;
    };
  }, [refreshNonce, selectedWorkflowId]);

  useEffect(() => {
    if (!userId) return;
    const plannerDockKey = `workflow-planner-dock:${userId}`;
    const inspectorKey = `workflow-inspector:${userId}`;
    const storedPlanner = window.localStorage.getItem(plannerDockKey);
    const storedInspector = window.localStorage.getItem(inspectorKey);
    setPlannerDockOpen(storedPlanner === "open");
    setInspectorCollapsed(storedInspector === "collapsed");
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    window.localStorage.setItem(`workflow-planner-dock:${userId}`, plannerDockOpen ? "open" : "closed");
  }, [plannerDockOpen, userId]);

  useEffect(() => {
    if (!userId) return;
    window.localStorage.setItem(`workflow-inspector:${userId}`, inspectorCollapsed ? "collapsed" : "open");
  }, [inspectorCollapsed, userId]);

  const loadWorkflowPreview = useCallback(
    async (workflowId: string, preferredVersionId?: string): Promise<void> => {
      if (!workflowId) {
        setPreviewDetails(null);
        setPreviewFlow(blankFlow());
        return;
      }
      const details = await requestJson<WorkflowDetailsResponse>(`/workflows/${workflowId}`, "GET");
      const targetVersion =
        details.versions.find((version) => version.id === preferredVersionId) ??
        details.versions.find((version) => version.status === "ACTIVE") ??
        details.versions[0];
      setPreviewDetails(details);
      setSelectedWorkflowId(workflowId);
      setSelectedPreviewVersionId(targetVersion?.id ?? "");
      setPreviewFlow(asCanonicalFlow(targetVersion?.nodesJson));
    },
    []
  );

  useEffect(() => {
    let mounted = true;
    if (!selectedWorkflowId || editorMode !== "catalog") {
      return () => {
        mounted = false;
      };
    }
    loadWorkflowPreview(selectedWorkflowId, selectedPreviewVersionId)
      .catch((loadError) => {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load workflow preview");
      });
    return () => {
      mounted = false;
    };
  }, [selectedWorkflowId, selectedPreviewVersionId, editorMode, loadWorkflowPreview]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes((current) => applyNodeChanges(changes, current));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current));
  }, []);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) =>
      addEdge(
        {
          ...connection,
          id: makeId("edge"),
          type: "workflowEdge",
          animated: true,
          markerEnd: { type: MarkerType.ArrowClosed }
        },
        current
      )
    );
  }, []);

  function resetEditor(flow: CanonicalFlow, options?: { workflowId?: string; versionId?: string; name?: string; description?: string; state?: "DRAFT" | "PUBLISHED"; status?: WorkflowStatus }): void {
    setNodes(flowToNodes(flow));
    setEdges(flowToEdges(flow));
    setSelectedNodeId(flow.nodes[0]?.id ?? "");
    setEditorWorkflowId(options?.workflowId ?? "");
    setEditorVersionId(options?.versionId ?? "");
    setEditorName(options?.name ?? "Untitled Workflow");
    setEditorDescription(options?.description ?? "");
    setEditorState(options?.state ?? "DRAFT");
    setEditorStatus(options?.status ?? "INACTIVE");
    setPlannerMessages([]);
    setPlannerPrompt("");
    setPlannerProposal(null);
    setInspectorTab("node");
    setLastTestResult(null);
  }

  async function openCreateWorkflow(): Promise<void> {
    resetEditor(blankFlow(), {
      workflowId: "",
      versionId: "",
      name: "Untitled Workflow",
      description: "",
      state: "DRAFT",
      status: "INACTIVE"
    });
    setEditorMode("editor");
    setStatus("Create a new workflow on the canvas, then save the draft.");
    setError("");
  }

  async function openModifyWorkflow(workflowId: string): Promise<void> {
    setStatus("Opening editable draft...");
    setError("");
    try {
      const response = await requestJson<{ version: WorkflowVersionRecord }>(`/workflows/${workflowId}/draft`, "POST");
      const details = await requestJson<WorkflowDetailsResponse>(`/workflows/${workflowId}`, "GET");
      resetEditor(asCanonicalFlow(response.version.nodesJson), {
        workflowId,
        versionId: response.version.id,
        name: details.workflow.name,
        description: details.workflow.description ?? "",
        state: response.version.state,
        status: response.version.status
      });
      setEditorMode("editor");
      setStatus(`Editing draft v${response.version.version}.`);
    } catch (openError) {
      setError(openError instanceof Error ? openError.message : "Failed to open workflow draft");
      setStatus("");
    }
  }

  async function openCopyWorkflow(workflowId: string): Promise<void> {
    setStatus("Creating workflow copy...");
    setError("");
    try {
      const response = await requestJson<{ workflow: { id: string; name: string; description?: string | null }; version: WorkflowVersionRecord }>(
        `/workflows/${workflowId}/copy`,
        "POST"
      );
      resetEditor(asCanonicalFlow(response.version.nodesJson), {
        workflowId: response.workflow.id,
        versionId: response.version.id,
        name: response.workflow.name,
        description: response.workflow.description ?? "",
        state: response.version.state,
        status: response.version.status
      });
      setEditorMode("editor");
      setRefreshNonce((value) => value + 1);
      setStatus("Workflow copy created as a new draft.");
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Failed to copy workflow");
      setStatus("");
    }
  }

  async function deleteWorkflow(workflowId: string): Promise<void> {
    const selected = workflows.find((workflow) => workflow.id === workflowId);
    if (!window.confirm(`Delete workflow "${selected?.name ?? workflowId}"?`)) return;
    setStatus("Deleting workflow...");
    setError("");
    try {
      await requestJson(`/workflows/${workflowId}`, "DELETE");
      if (selectedWorkflowId === workflowId) {
        setSelectedWorkflowId("");
        setSelectedPreviewVersionId("");
        setPreviewDetails(null);
        setPreviewFlow(blankFlow());
      }
      setRefreshNonce((value) => value + 1);
      setStatus("Workflow deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete workflow");
      setStatus("");
    }
  }

  function patchSelectedNode(patch: Partial<FlowNodeData>): void {
    if (!selectedNode) return;
    setNodes((current) =>
      current.map((node) => {
        if (node.id !== selectedNode.id) return node;
        const nextConfig = {
          ...node.data.config,
          ...(patch.config ?? {})
        };
        return {
          ...node,
          data: {
            ...node.data,
            ...patch,
            config: {
              ...nextConfig,
              approvalRequired: (nextConfig.approvalMode ?? "NONE") !== "NONE"
            }
          }
        };
      })
    );
  }

  function addNode(nodeType: WorkflowNodeType): void {
    setNodes((current) => {
      const next = [...current, createFlowNode(nodeType, current.length)];
      const created = next[next.length - 1];
      setSelectedNodeId(created.id);
      return next;
    });
    setStatus(`${nodeType} node added.`);
    setError("");
  }

  function insertTemplate(template: NodeTemplateSummary): void {
    setNodes((current) => {
      const created = createFlowNodeFromTemplate(template, current.length);
      setSelectedNodeId(created.id);
      return [...current, created];
    });
    setStatus(`Template "${template.name}" inserted into the canvas.`);
    setError("");
  }

  function duplicateSelectedNode(): void {
    if (!selectedNode) return;
    setNodes((current) => {
      const duplicate: Node<FlowNodeData> = {
        ...selectedNode,
        id: makeId("node"),
        position: {
          x: selectedNode.position.x + 48,
          y: selectedNode.position.y + 48
        },
        data: {
          ...selectedNode.data,
          label: `${selectedNode.data.label} Copy`,
          config: cloneNodeConfig(selectedNode.data.config, selectedNode.data.nodeType)
        }
      };
      setSelectedNodeId(duplicate.id);
      return [...current, duplicate];
    });
    setStatus("Selected node duplicated.");
    setError("");
  }

  function removeSelectedNode(): void {
    if (!selectedNode) return;
    setNodes((current) => current.filter((node) => node.id !== selectedNode.id));
    setEdges((current) => current.filter((edge) => edge.source !== selectedNode.id && edge.target !== selectedNode.id));
    setSelectedNodeId("");
    setStatus("Node removed from workflow draft.");
  }

  async function saveDraft(): Promise<void> {
    const flow = editorFlow(nodes, edges);
    setStatus("Saving workflow draft...");
    setError("");
    try {
      if (!editorWorkflowId) {
        const response = await requestJson<{
          workflow: { id: string; name: string; description?: string | null };
          version: WorkflowVersionRecord;
        }>("/workflows", "POST", {
          name: editorName,
          description: editorDescription,
          flowDefinition: flow
        });
        setEditorWorkflowId(response.workflow.id);
        setEditorVersionId(response.version.id);
        setEditorState(response.version.state);
        setEditorStatus(response.version.status);
        setSelectedWorkflowId(response.workflow.id);
      } else {
        const response = await requestJson<{
          workflow: { id: string; name: string; description?: string | null };
          version: WorkflowVersionRecord;
        }>(`/workflows/${editorWorkflowId}/versions/${editorVersionId}/draft`, "PUT", {
          name: editorName,
          description: editorDescription,
          flowDefinition: flow
        });
        setEditorState(response.version.state);
        setEditorStatus(response.version.status);
      }
      setRefreshNonce((value) => value + 1);
      setStatus("Workflow draft saved.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save workflow draft");
      setStatus("");
    }
  }

  async function publishDraft(): Promise<void> {
    if (!editorWorkflowId) {
      setError("Save the workflow draft first.");
      return;
    }
    setStatus("Publishing workflow draft...");
    setError("");
    try {
      const response = editorVersionId
        ? await requestJson<{ version: WorkflowVersionRecord }>(`/workflows/${editorWorkflowId}/versions/${editorVersionId}/publish`, "POST")
        : await requestJson<{ version: WorkflowVersionRecord }>(`/workflows/${editorWorkflowId}/publish`, "POST");
      if (response.version) {
        setEditorState(response.version.state);
        setEditorStatus(response.version.status);
        setEditorVersionId(response.version.id);
      }
      setRefreshNonce((value) => value + 1);
      setStatus("Workflow version published.");
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : "Failed to publish workflow");
      setStatus("");
    }
  }

  async function activateVersion(): Promise<void> {
    if (!editorWorkflowId || !editorVersionId) return;
    setStatus("Activating published version...");
    setError("");
    try {
      const response = await requestJson<{ version: WorkflowVersionRecord }>(
        `/workflows/${editorWorkflowId}/versions/${editorVersionId}/activate`,
        "POST"
      );
      if (response.version) {
        setEditorStatus(response.version.status);
      }
      setRefreshNonce((value) => value + 1);
      setStatus("Workflow version activated.");
    } catch (activateError) {
      setError(activateError instanceof Error ? activateError.message : "Failed to activate workflow version");
      setStatus("");
    }
  }

  async function previewResetData(): Promise<void> {
    setStatus("Loading workflow/order reset preview...");
    setError("");
    try {
      const preview = await requestJson<{ counts: Record<string, number> }>("/admin/reset/workflows-orders/preview", "POST");
      setResetPreview(preview.counts);
      setStatus("Reset preview ready.");
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Failed to preview reset");
      setStatus("");
    }
  }

  async function executeReset(): Promise<void> {
    if (!window.confirm("This will remove workflows and orders for all users. Continue?")) return;
    setStatus("Executing global workflow/order reset...");
    setError("");
    try {
      await requestJson("/admin/reset/workflows-orders/execute", "POST", {
        confirmText: "RESET WORKFLOWS AND ORDERS"
      });
      setResetPreview(null);
      setPreviewDetails(null);
      setPreviewFlow(blankFlow());
      setSelectedWorkflowId("");
      setSelectedPreviewVersionId("");
      setEditorMode("catalog");
      setRefreshNonce((value) => value + 1);
      setStatus("Workflow and order reset completed.");
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Reset failed");
      setStatus("");
    }
  }

  async function exportWorkflowJson(): Promise<void> {
    try {
      let payload: WorkflowExportPayload;
      if (editorWorkflowId) {
        const suffix = editorVersionId ? `?versionId=${encodeURIComponent(editorVersionId)}` : "";
        payload = await requestJson<WorkflowExportPayload>(`/workflows/${editorWorkflowId}/export${suffix}`, "GET");
      } else {
        payload = {
          workflow: {
            id: "unsaved-workflow",
            name: editorName,
            description: editorDescription
          },
          version: {
            id: "draft-local",
            version: 0,
            state: "DRAFT",
            status: "INACTIVE"
          },
          flowDefinition: editorFlow(nodes, edges)
        };
      }

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${payload.workflow.name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "workflow"}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("Workflow JSON exported.");
      setError("");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Failed to export workflow JSON");
      setStatus("");
    }
  }

  async function importWorkflowJson(file: File | null): Promise<void> {
    if (!file) return;
    setStatus("Importing workflow JSON...");
    setError("");
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as { workflow?: { name?: string; description?: string | null }; flowDefinition?: CanonicalFlow } | CanonicalFlow;
      const importPayload =
        "flowDefinition" in parsed
          ? {
              name: parsed.workflow?.name ?? file.name.replace(/\.json$/i, ""),
              description: parsed.workflow?.description ?? "",
              flowDefinition: parsed.flowDefinition
            }
          : {
              name: file.name.replace(/\.json$/i, ""),
              description: "",
              flowDefinition: parsed
            };
      const response = await requestJson<{
        workflow: { id: string; name: string; description?: string | null };
        version: WorkflowVersionRecord;
      }>("/workflows/import", "POST", importPayload);
      resetEditor(asCanonicalFlow(importPayload.flowDefinition), {
        workflowId: response.workflow.id,
        versionId: response.version.id,
        name: response.workflow.name,
        description: response.workflow.description ?? "",
        state: response.version.state,
        status: response.version.status
      });
      setEditorMode("editor");
      setSelectedWorkflowId(response.workflow.id);
      setRefreshNonce((value) => value + 1);
      setStatus("Workflow imported as a new draft.");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Failed to import workflow JSON");
      setStatus("");
    }
  }

  async function executeWorkflowTest(): Promise<void> {
    if (!editorVersionId || editorState !== "PUBLISHED") {
      setError("Publish the workflow version before running a tracked test execution.");
      return;
    }
    setExecutingTest(true);
    setStatus("Creating tracked test order...");
    setError("");
    try {
      const input = JSON.parse(testInputJson || "{}") as Record<string, unknown>;
      const response = await requestJson<ExecuteOrderResponse>("/orders/execute", "POST", {
        workflowVersionId: editorVersionId,
        environmentId: testEnvironmentId || undefined,
        input
      });
      setLastTestResult(response);
      setStatus(`Tracked test run started for order ${response.orderId}.`);
      setRefreshNonce((value) => value + 1);
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Failed to execute workflow test");
      setStatus("");
    } finally {
      setExecutingTest(false);
    }
  }

  async function runPlanner(): Promise<void> {
    if (!plannerPrompt.trim()) return;
    setPlannerBusy(true);
    setError("");
    const userMessage: PlannerMessage = {
      id: makeId("planner-msg"),
      role: "user",
      text: plannerPrompt.trim(),
      createdAt: new Date().toISOString()
    };
    setPlannerMessages((current) => [...current, userMessage]);
    try {
      const proposal = await requestJson<PlannerResponse>("/planner/draft", "POST", {
        prompt: plannerPrompt.trim(),
        existingFlowDefinition: editorFlow(nodes, edges)
      });
      const plannerMessage: PlannerMessage = {
        id: makeId("planner-msg"),
        role: "planner",
        text: proposal.summary,
        createdAt: new Date().toISOString(),
        proposal
      };
      setPlannerMessages((current) => [...current, plannerMessage]);
      setPlannerProposal(proposal);
      setPlannerPrompt("");
      setStatus("Planner proposal ready for review.");
    } catch (plannerError) {
      const plannerMessage: PlannerMessage = {
        id: makeId("planner-msg"),
        role: "system",
        text: plannerError instanceof Error ? plannerError.message : "Planner request failed",
        createdAt: new Date().toISOString()
      };
      setPlannerMessages((current) => [...current, plannerMessage]);
      setError(plannerError instanceof Error ? plannerError.message : "Planner request failed");
      setStatus("");
    } finally {
      setPlannerBusy(false);
    }
  }

  function applyPlannerProposal(): void {
    if (!plannerProposal) return;
    resetEditor(plannerProposal.flowDefinition, {
      workflowId: editorWorkflowId,
      versionId: editorVersionId,
      name: editorName,
      description: editorDescription,
      state: editorState,
      status: editorStatus
    });
    setPlannerMessages((current) => [
      ...current,
      {
        id: makeId("planner-msg"),
        role: "system",
        text: "Planner proposal applied to the draft canvas. Save the workflow when you are happy with the changes.",
        createdAt: new Date().toISOString()
      }
    ]);
    setPlannerProposal(null);
    setStatus("Planner changes applied to the editor.");
  }

  function discardPlannerProposal(): void {
    setPlannerProposal(null);
    setStatus("Planner proposal dismissed.");
  }

  function openCatalogView(): void {
    setEditorMode("catalog");
    setPlannerProposal(null);
    setPlannerPrompt("");
  }

  const versionBadge = editorVersionId ? `v${previewDetails?.versions.find((entry) => entry.id === editorVersionId)?.version ?? ""}` : "Draft";
  const canActivate = editorState === "PUBLISHED" && editorStatus !== "ACTIVE";

  if (loading && workflows.length === 0) {
    return <div className="workflow-loading">Loading workflow studio...</div>;
  }

  return (
    <div className="workflow-studio">
      <div className="workflow-status-strip">
        <div>
          <strong>Workflow Studio</strong>
          <span>{editorMode === "catalog" ? "Catalog and preview" : "Canvas editor"}</span>
        </div>
        <div className="workflow-status-messages">
          {status && <span className="workflow-inline-ok">{status}</span>}
          {error && <span className="workflow-inline-error">{error}</span>}
        </div>
      </div>

      {editorMode === "catalog" ? (
        <section className="workflow-catalog-shell">
          <div className="workflow-catalog-header">
            <div>
              <div className="workflow-eyebrow">Workflow Catalog</div>
              <h1>Professional workflow management</h1>
              <p>Browse versions, inspect active flows in read-only mode, and open the editor only when you want to create or modify.</p>
            </div>
            <div className="workflow-catalog-actions">
              <button className="workflow-primary-button" onClick={() => void openCreateWorkflow()}>
                Create Workflow
              </button>
            </div>
          </div>

          <div className="workflow-catalog-grid">
            <div className="workflow-catalog-card">
              <div className="workflow-card-title-row">
                <h2>Workflows</h2>
                <span>{workflows.length} total</span>
              </div>
              <div className="workflow-table-wrapper">
                <table className="workflow-catalog-table">
                  <thead>
                    <tr>
                      <th>Workflow</th>
                      <th>Description</th>
                      <th>Version</th>
                      <th>State</th>
                      <th>Status</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workflows.length === 0 ? (
                      <tr>
                        <td colSpan={6}>
                          <div className="workflow-empty-state">
                            <strong>No workflows yet</strong>
                            <span>Create your first workflow to start using the new canvas editor.</span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                    {workflows.map((workflow) => {
                      const isSelected = workflow.id === selectedWorkflowId;
                      return (
                        <tr
                          key={workflow.id}
                          className={isSelected ? "workflow-row-selected" : ""}
                          onClick={() => {
                            setSelectedWorkflowId(workflow.id);
                            setSelectedPreviewVersionId(workflow.selectedVersionId ?? "");
                          }}
                        >
                          <td>
                            <div className="workflow-name-cell">
                              <strong>{workflow.name}</strong>
                              <span>Updated {formatDate(workflow.updatedAt)}</span>
                            </div>
                          </td>
                          <td>{workflow.description || "No description yet"}</td>
                          <td>{workflow.version ? `v${workflow.version}` : "-"}</td>
                          <td>
                            <span className={statusClass(workflow.state)}>{workflow.state}</span>
                          </td>
                          <td>
                            <span className={statusClass(workflow.status)}>{workflow.status}</span>
                          </td>
                          <td>
                            <div className="workflow-row-actions">
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedWorkflowId(workflow.id);
                                  setSelectedPreviewVersionId(workflow.selectedVersionId ?? "");
                                }}
                              >
                                View
                              </button>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void openModifyWorkflow(workflow.id);
                                }}
                              >
                                Modify
                              </button>
                              <button
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void openCopyWorkflow(workflow.id);
                                }}
                              >
                                Copy
                              </button>
                              <button
                                className="workflow-danger-button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void deleteWorkflow(workflow.id);
                                }}
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="workflow-preview-card">
              <div className="workflow-card-title-row">
                <div>
                  <h2>{previewDetails?.workflow.name ?? "Read-only preview"}</h2>
                  <span>{previewDetails?.workflow.description ?? "Select a workflow to inspect its current design."}</span>
                </div>
                <span className="workflow-readonly-chip">Read only</span>
              </div>

              {previewDetails ? (
                <>
                  <div className="workflow-preview-toolbar">
                    <div className="workflow-preview-version-pills">
                      {previewVersions.map((version) => (
                        <button
                          key={version.id}
                          className={version.id === selectedPreviewVersionId ? "workflow-pill-active" : ""}
                          onClick={() => {
                            setSelectedPreviewVersionId(version.id);
                            setPreviewFlow(asCanonicalFlow(version.nodesJson));
                          }}
                        >
                          v{version.version} · {version.state} · {version.status}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="workflow-preview-canvas">
                    <ReactFlow
                      nodes={previewNodes}
                      edges={previewEdges}
                      nodeTypes={nodeTypes}
                      edgeTypes={edgeTypes}
                      fitView
                      nodesDraggable={false}
                      nodesConnectable={false}
                      elementsSelectable={false}
                      zoomOnDoubleClick={false}
                      proOptions={{ hideAttribution: true }}
                    >
                      <Background color="#1b2432" gap={24} size={1} />
                      <MiniMap pannable zoomable />
                    </ReactFlow>
                  </div>
                </>
              ) : (
                <div className="workflow-empty-preview">
                  <strong>Select a workflow</strong>
                  <span>The active or latest version will open here in read-only mode.</span>
                </div>
              )}
            </div>
          </div>

          {isAdmin ? (
            <div className="workflow-reset-card">
              <div className="workflow-card-title-row">
                <div>
                  <h2>Admin reset</h2>
                  <span>Fresh-start reset for workflows and orders across all users.</span>
                </div>
              </div>
              <div className="workflow-reset-actions">
                <button onClick={() => void previewResetData()}>Preview Reset</button>
                <button className="workflow-danger-button" onClick={() => void executeReset()}>
                  Execute Reset
                </button>
              </div>
              {resetPreview ? (
                <div className="workflow-reset-stats">
                  {Object.entries(resetPreview).map(([key, value]) => (
                    <div key={key} className="workflow-reset-stat">
                      <strong>{value}</strong>
                      <span>{key}</span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : (
        <section className="workflow-editor-shell">
          <div className="workflow-editor-topbar">
            <div className="workflow-editor-title-group">
              <button className="workflow-ghost-button" onClick={openCatalogView}>
                Back to Catalog
              </button>
              <div>
                <div className="workflow-eyebrow">Workflow Editor</div>
                <div className="workflow-topbar-name-row">
                  <input value={editorName} onChange={(event) => setEditorName(event.target.value)} placeholder="Workflow name" />
                  <span className={statusClass(editorState)}>{editorState}</span>
                  <span className={statusClass(editorStatus)}>{editorStatus}</span>
                  <span className="workflow-version-chip">{versionBadge}</span>
                </div>
              </div>
            </div>

            <div className="workflow-editor-actions">
              <button onClick={() => setInspectorCollapsed((value) => !value)}>{inspectorCollapsed ? "Show Inspector" : "Hide Inspector"}</button>
              <label className="workflow-ghost-button workflow-file-button">
                Import JSON
                <input
                  type="file"
                  accept="application/json,.json"
                  onChange={(event) => {
                    void importWorkflowJson(event.target.files?.[0] ?? null);
                    event.target.value = "";
                  }}
                />
              </label>
              <button onClick={() => void exportWorkflowJson()} className="workflow-ghost-button">
                Export JSON
              </button>
              <button onClick={() => void saveDraft()} className="workflow-secondary-button">
                Save Draft
              </button>
              <button onClick={() => void publishDraft()} className="workflow-primary-button">
                Publish
              </button>
              <button onClick={() => void activateVersion()} disabled={!canActivate}>
                Activate
              </button>
            </div>
          </div>

          <div className="workflow-editor-subbar">
            <textarea
              value={editorDescription}
              onChange={(event) => setEditorDescription(event.target.value)}
              placeholder="Describe what this workflow does and when to use it."
              rows={2}
            />
            <div className="workflow-node-palette">
              {NODE_TYPES.map((nodeType) => (
                <button key={nodeType} onClick={() => addNode(nodeType)}>
                  + {nodeType}
                </button>
              ))}
            </div>
          </div>

          <div className="workflow-editor-utility-grid">
            <section className="workflow-template-panel">
              <div className="workflow-card-title-row">
                <div>
                  <h2>Reusable Node Library</h2>
                  <span>Insert shared templates directly into the current workflow canvas.</span>
                </div>
                <a href="/node-library" className="workflow-ghost-link">
                  Manage Library
                </a>
              </div>
              <input
                value={templateSearch}
                onChange={(event) => setTemplateSearch(event.target.value)}
                placeholder="Search templates by name, category, tag, or node type"
              />
              <div className="workflow-template-list">
                {filteredTemplates.length === 0 ? (
                  <div className="workflow-template-empty">No reusable templates match the current filter.</div>
                ) : (
                  filteredTemplates.slice(0, 8).map((template) => (
                    <article key={template.id} className="workflow-template-card">
                      <div className="workflow-template-card-header">
                        <strong>{template.name}</strong>
                        <span className={statusClass(template.access)}>{template.access}</span>
                      </div>
                      <p>{template.description || "No description provided."}</p>
                      <div className="workflow-template-meta">
                        <span>{template.nodeType}</span>
                        <span>{template.category || "General"}</span>
                        <span>Updated {formatDate(template.updatedAt)}</span>
                      </div>
                      <button onClick={() => insertTemplate(template)}>Insert into Canvas</button>
                    </article>
                  ))
                )}
              </div>
            </section>

            <section className="workflow-test-panel">
              <div className="workflow-card-title-row">
                <div>
                  <h2>Test / Execute</h2>
                  <span>Launches a tracked test order through the existing execution path.</span>
                </div>
              </div>
              <label>
                Test Environment
                <select value={testEnvironmentId} onChange={(event) => setTestEnvironmentId(event.target.value)}>
                  <option value="">Use workflow or user default</option>
                  {environments.map((environment) => (
                    <option key={environment.id} value={environment.id}>
                      {environment.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Test Input JSON
                <textarea value={testInputJson} onChange={(event) => setTestInputJson(event.target.value)} rows={7} />
              </label>
              <div className="workflow-test-actions">
                <button
                  onClick={() => void executeWorkflowTest()}
                  className="workflow-primary-button"
                  disabled={executingTest || !editorVersionId || editorState !== "PUBLISHED"}
                >
                  {executingTest ? "Running Test..." : "Test / Execute"}
                </button>
                <span>{editorState === "PUBLISHED" ? "Uses the current published version." : "Publish the draft to enable tracked test execution."}</span>
              </div>
              {lastTestResult ? (
                <div className="workflow-test-result">
                  <strong>Last test run</strong>
                  <span>Order {lastTestResult.orderId}</span>
                  <span>Status {lastTestResult.result.status}</span>
                  <a href={`/orders?orderId=${encodeURIComponent(lastTestResult.orderId)}`}>Open order timeline</a>
                </div>
              ) : null}
            </section>
          </div>

          <div className={`workflow-editor-main${inspectorCollapsed ? " workflow-editor-main-collapsed" : ""}`}>
            <div className="workflow-canvas-stage">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                nodeTypes={nodeTypes}
                edgeTypes={edgeTypes}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={onConnect}
                onNodeClick={(_, node) => setSelectedNodeId(node.id)}
                fitView
                proOptions={{ hideAttribution: true }}
              >
                <Background color="#18202d" gap={24} size={1} />
                <Controls />
                <MiniMap pannable zoomable />
                <Panel position="top-left">
                  <div className="workflow-canvas-label">Canvas</div>
                </Panel>
              </ReactFlow>

              {nodes.length === 0 ? (
                <div className="workflow-editor-empty">
                  <strong>Start with a blank flow</strong>
                  <span>Add trigger, condition, action, or approval nodes from the palette to build the workflow.</span>
                </div>
              ) : null}

              <div className={`workflow-planner-dock${plannerDockOpen ? " workflow-planner-dock-open" : ""}`}>
                <button className="workflow-planner-toggle" onClick={() => setPlannerDockOpen((value) => !value)}>
                  {plannerDockOpen ? "Close Planner" : "Open Planner"}
                </button>
                {plannerDockOpen ? (
                  <div className="workflow-planner-panel">
                    <div className="workflow-planner-header">
                      <div>
                        <strong>Planner Dock</strong>
                        <span>Planner-only suggestions, apply on confirmation.</span>
                      </div>
                    </div>

                    <div className="workflow-planner-thread">
                      {plannerMessages.length === 0 ? (
                        <div className="workflow-planner-empty">
                          Describe the workflow you want, or ask for a patch such as adding approvals, decisions, or follow-up actions.
                        </div>
                      ) : null}
                      {plannerMessages.map((message) => (
                        <div key={message.id} className={`workflow-planner-message workflow-planner-${message.role}`}>
                          <div className="workflow-planner-role">{message.role}</div>
                          <div>{message.text}</div>
                          {message.proposal ? (
                            <div className="workflow-planner-preview-card">
                              <strong>{message.proposal.summary}</strong>
                              <ul>
                                <li>Nodes added: {message.proposal.changePreview.nodesAdded.length}</li>
                                <li>Nodes changed: {message.proposal.changePreview.nodesChanged.length}</li>
                                <li>Edges added: {message.proposal.changePreview.edgesAdded}</li>
                                <li>Approval changes: {message.proposal.changePreview.approvalsChanged.length}</li>
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      ))}
                    </div>

                    <div className="workflow-planner-compose">
                      <textarea
                        value={plannerPrompt}
                        onChange={(event) => setPlannerPrompt(event.target.value)}
                        placeholder={isAdmin ? "Ask the planner to generate or change the workflow..." : "Planner is available to platform admins."}
                        rows={3}
                        disabled={!isAdmin || plannerBusy}
                      />
                      <div className="workflow-planner-actions">
                        <button onClick={() => void runPlanner()} disabled={!isAdmin || plannerBusy || !plannerPrompt.trim()}>
                          {plannerBusy ? "Planning..." : "Generate Proposal"}
                        </button>
                        <button onClick={applyPlannerProposal} disabled={!plannerProposal}>
                          Apply
                        </button>
                        <button onClick={discardPlannerProposal} disabled={!plannerProposal}>
                          Discard
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            {!inspectorCollapsed ? (
              <aside className="workflow-inspector">
                <div className="workflow-inspector-tabs">
                  <button className={inspectorTab === "node" ? "active" : ""} onClick={() => setInspectorTab("node")}>
                    Node
                  </button>
                  <button className={inspectorTab === "execution" ? "active" : ""} onClick={() => setInspectorTab("execution")}>
                    Execution
                  </button>
                  <button className={inspectorTab === "approval" ? "active" : ""} onClick={() => setInspectorTab("approval")}>
                    Approval
                  </button>
                  <button className={inspectorTab === "version" ? "active" : ""} onClick={() => setInspectorTab("version")}>
                    Version
                  </button>
                </div>

                {!selectedNode && inspectorTab !== "version" ? (
                  <div className="workflow-inspector-empty">
                    Select a node to configure its properties.
                  </div>
                ) : null}

                {selectedNode && inspectorTab === "node" ? (
                  <div className="workflow-form-grid">
                    <label>
                      Title
                      <input value={selectedNode.data.label} onChange={(event) => patchSelectedNode({ label: event.target.value })} />
                    </label>
                    <label>
                      Description
                      <textarea
                        rows={3}
                        value={selectedNode.data.description ?? ""}
                        onChange={(event) => patchSelectedNode({ description: event.target.value })}
                      />
                    </label>
                    <label>
                      Node Type
                      <select
                        value={selectedNode.data.nodeType}
                        onChange={(event) =>
                          patchSelectedNode({
                            nodeType: event.target.value as WorkflowNodeType
                          })
                        }
                      >
                        {NODE_TYPES.map((nodeType) => (
                          <option key={nodeType} value={nodeType}>
                            {nodeType}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Integration
                      <select
                        value={selectedNode.data.config.integrationProfileId ?? ""}
                        onChange={(event) =>
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              integrationProfileId: event.target.value || undefined
                            }
                          })
                        }
                      >
                        <option value="">Not attached</option>
                        {integrationProfiles.map((integration) => (
                          <option key={integration.id} value={integration.id}>
                            {integration.name} ({integration.executionType})
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Environment
                      <select
                        value={selectedNode.data.config.environmentId ?? ""}
                        onChange={(event) =>
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              environmentId: event.target.value || undefined
                            }
                          })
                        }
                      >
                        <option value="">Not attached</option>
                        {environments.map((environment) => (
                          <option key={environment.id} value={environment.id}>
                            {environment.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="workflow-inspector-inline-actions">
                      <button onClick={duplicateSelectedNode}>Duplicate Node</button>
                      <button className="workflow-danger-button" onClick={removeSelectedNode}>
                        Remove Node
                      </button>
                    </div>
                  </div>
                ) : null}

                {selectedNode && inspectorTab === "execution" ? (
                  <div className="workflow-form-grid">
                    <label>
                      Failure Policy
                      <select
                        value={selectedNode.data.config.failurePolicy}
                        onChange={(event) =>
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              failurePolicy: event.target.value as FailurePolicy
                            }
                          })
                        }
                      >
                        <option value="RETRY">RETRY</option>
                        <option value="CONTINUE">CONTINUE</option>
                        <option value="ROLLBACK">ROLLBACK</option>
                      </select>
                    </label>
                    <label>
                      Execution Type
                      <select
                        value={selectedNode.data.config.steps[0]?.executionType ?? "SCRIPT"}
                        onChange={(event) =>
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              steps: [
                                {
                                  ...(selectedNode.data.config.steps[0] ?? createDefaultStep(selectedNode.data.nodeType)),
                                  executionType: event.target.value as ExecutionType
                                }
                              ]
                            }
                          })
                        }
                      >
                        <option value="REST">REST</option>
                        <option value="SSH">SSH</option>
                        <option value="NETCONF">NETCONF</option>
                        <option value="SCRIPT">SCRIPT</option>
                      </select>
                    </label>
                    <label>
                      Primary Command / Ref
                      <textarea
                        rows={3}
                        value={selectedNode.data.config.steps[0]?.commandRef ?? ""}
                        onChange={(event) =>
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              steps: [
                                {
                                  ...(selectedNode.data.config.steps[0] ?? createDefaultStep(selectedNode.data.nodeType)),
                                  commandRef: event.target.value
                                }
                              ]
                            }
                          })
                        }
                      />
                    </label>
                    <label>
                      Success Criteria
                      <input
                        value={selectedNode.data.config.steps[0]?.successCriteria ?? ""}
                        onChange={(event) =>
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              steps: [
                                {
                                  ...(selectedNode.data.config.steps[0] ?? createDefaultStep(selectedNode.data.nodeType)),
                                  successCriteria: event.target.value
                                }
                              ]
                            }
                          })
                        }
                      />
                    </label>
                    <label className="workflow-checkbox-row">
                      <input
                        type="checkbox"
                        checked={Boolean(selectedNode.data.config.steps[0]?.loggingEnabled)}
                        onChange={(event) =>
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              steps: [
                                {
                                  ...(selectedNode.data.config.steps[0] ?? createDefaultStep(selectedNode.data.nodeType)),
                                  loggingEnabled: event.target.checked
                                }
                              ]
                            }
                          })
                        }
                      />
                      <span>Enable detailed step logging for this step</span>
                    </label>
                  </div>
                ) : null}

                {selectedNode && inspectorTab === "approval" ? (
                  <div className="workflow-form-grid">
                    <label>
                      Approval Mode
                      <select
                        value={selectedNode.data.config.approvalMode}
                        onChange={(event) => {
                          const nextMode = event.target.value as ApprovalMode;
                          patchSelectedNode({
                            config: {
                              ...selectedNode.data.config,
                              approvalMode: nextMode,
                              approvalRequired: nextMode !== "NONE",
                              approvalTimeoutSec: nextMode === "AUTO_WITH_TIMEOUT" ? selectedNode.data.config.approvalTimeoutSec ?? 300 : undefined,
                              autoDecision: nextMode === "AUTO_WITH_TIMEOUT" ? selectedNode.data.config.autoDecision ?? "APPROVE" : undefined
                            }
                          });
                        }}
                      >
                        <option value="NONE">NONE</option>
                        <option value="MANUAL">MANUAL</option>
                        <option value="AUTO_WITH_TIMEOUT">AUTO_WITH_TIMEOUT</option>
                      </select>
                    </label>

                    {selectedNode.data.config.approvalMode === "AUTO_WITH_TIMEOUT" ? (
                      <>
                        <label>
                          Timeout (seconds)
                          <input
                            type="number"
                            min={1}
                            value={selectedNode.data.config.approvalTimeoutSec ?? 300}
                            onChange={(event) =>
                              patchSelectedNode({
                                config: {
                                  ...selectedNode.data.config,
                                  approvalTimeoutSec: Number(event.target.value || 300)
                                }
                              })
                            }
                          />
                        </label>
                        <label>
                          Auto Decision
                          <select
                            value={selectedNode.data.config.autoDecision ?? "APPROVE"}
                            onChange={(event) =>
                              patchSelectedNode({
                                config: {
                                  ...selectedNode.data.config,
                                  autoDecision: event.target.value as AutoDecision
                                }
                              })
                            }
                          >
                            <option value="APPROVE">APPROVE</option>
                            <option value="REJECT">REJECT</option>
                          </select>
                        </label>
                      </>
                    ) : null}
                  </div>
                ) : null}

                {inspectorTab === "version" ? (
                  <div className="workflow-version-panel">
                    <div className="workflow-version-summary">
                      <span className={statusClass(editorState)}>{editorState}</span>
                      <span className={statusClass(editorStatus)}>{editorStatus}</span>
                    </div>
                    <p>Only one published version can be active at a time. Drafts are never active.</p>
                    <p>Step logging is disabled by default. Turn it on per step in the execution tab when you need detailed correlated traces in OpenSearch.</p>
                    {editorWorkflowId ? (
                      <button className="workflow-ghost-button" onClick={() => void loadWorkflowPreview(editorWorkflowId, editorVersionId)}>
                        Refresh Version Context
                      </button>
                    ) : (
                      <span>Save the draft to create the first workflow version.</span>
                    )}
                  </div>
                ) : null}
              </aside>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}
