import {
  normalizeWorkflowFlow,
  type NodeTemplateAccess,
  type NodeTemplateConfig,
  type NodeTemplateDefinition,
  type NodeTemplateRecord,
  type NodeTemplateSummary,
  type WorkflowFlowDefinition,
  type WorkflowNodeType
} from "@platform/contracts";

type NodeTemplateRow = {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  category: string | null;
  tagsJson: unknown;
  nodeType: string;
  configJson: unknown;
  metadataJson: unknown;
  createdAt: Date;
  updatedAt: Date;
  shares?: Array<{ sharedWithUserId: string }>;
};

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

function normalizeNodeType(value: unknown): WorkflowNodeType {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "TRIGGER" || normalized === "CONDITION" || normalized === "ACTION" || normalized === "APPROVAL") {
    return normalized;
  }
  return "ACTION";
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function normalizeTemplateConfig(nodeType: WorkflowNodeType, config: unknown): NodeTemplateConfig {
  const flow: WorkflowFlowDefinition = normalizeWorkflowFlow({
    schemaVersion: "v2",
    nodes: [
      {
        id: "template-node",
        type: "task",
        label: "Template Node",
        position: { x: 0, y: 0 },
        config: {
          ...(toRecord(config) ?? {}),
          nodeType
        }
      }
    ],
    edges: []
  });
  return flow.nodes[0].config;
}

export function normalizeNodeTemplateDefinition(input: unknown): NodeTemplateDefinition {
  const value = toRecord(input) ?? {};
  const nodeType = normalizeNodeType(value.config && typeof value.config === "object" ? (value.config as Record<string, unknown>).nodeType : value.nodeType);
  return {
    schemaVersion: "v1",
    name: String(value.name ?? "").trim() || "Untitled Template",
    description: typeof value.description === "string" ? value.description.trim() || undefined : undefined,
    category: typeof value.category === "string" ? value.category.trim() || undefined : undefined,
    tags: toStringArray(value.tags),
    config: normalizeTemplateConfig(nodeType, value.config),
    metadata: toRecord(value.metadata)
  };
}

function sharedWithUsers(row: NodeTemplateRow): string[] {
  return (row.shares ?? []).map((entry) => entry.sharedWithUserId);
}

export function nodeTemplateAccess(row: NodeTemplateRow, requester: string, admin: boolean): NodeTemplateAccess {
  if (admin && row.ownerId !== requester) return "ADMIN";
  if (row.ownerId === requester) return "OWNER";
  return "SHARED";
}

export function mapNodeTemplateSummary(row: NodeTemplateRow, requester: string, admin: boolean): NodeTemplateSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    tags: toStringArray(row.tagsJson),
    nodeType: normalizeNodeType(row.nodeType),
    access: nodeTemplateAccess(row, requester, admin),
    ownerId: row.ownerId,
    sharedWithUsers: sharedWithUsers(row),
    updatedAt: row.updatedAt.toISOString()
  };
}

export function mapNodeTemplateRecord(row: NodeTemplateRow, requester: string, admin: boolean): NodeTemplateRecord {
  const definition = normalizeNodeTemplateDefinition({
    name: row.name,
    description: row.description ?? undefined,
    category: row.category ?? undefined,
    tags: toStringArray(row.tagsJson),
    config: row.configJson,
    metadata: row.metadataJson
  });
  return {
    ...mapNodeTemplateSummary(row, requester, admin),
    createdAt: row.createdAt.toISOString(),
    metadata: definition.metadata,
    config: definition.config
  };
}
