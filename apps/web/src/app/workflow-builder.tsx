"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Panel, StatusBadge } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";

type FailurePolicy = "RETRY" | "CONTINUE" | "ROLLBACK";
type ExecutionType = "REST" | "SSH" | "NETCONF" | "SCRIPT";

interface WorkflowSummary {
  id: string;
  name: string;
}

interface WorkflowVersionRecord {
  id: string;
  version: number;
  status: string;
  createdAt: string;
  nodesJson?: unknown;
}

interface WorkflowDetailsResponse {
  workflow: {
    id: string;
    name: string;
    description?: string | null;
  };
  versions: WorkflowVersionRecord[];
}

interface BuilderStep {
  id: string;
  name: string;
  executionType: ExecutionType;
  commandRef: string;
  inputVariables: Record<string, string>;
  successCriteria: string;
  retryPolicy: {
    maxRetries: number;
    backoffMs: number;
  };
  rollbackAction?: string;
}

interface BuilderNode {
  id: string;
  name: string;
  order: number;
  configType: string;
  integrationProfileId?: string;
  environmentId?: string;
  approvalRequired: boolean;
  failurePolicy: FailurePolicy;
  steps: BuilderStep[];
}

interface IntegrationProfileRecord {
  id: string;
  name: string;
  ownerId: string;
  executionType: ExecutionType;
  isActive: boolean;
  updatedAt: string;
}

interface UserEnvironmentRecord {
  id: string;
  name: string;
  ownerId: string;
  isDefault: boolean;
  updatedAt: string;
}

const TOKEN_STORAGE_KEY = "ops_bearer_token";

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function createDefaultStep(): BuilderStep {
  return {
    id: makeId("step"),
    name: "New Step",
    executionType: "SCRIPT",
    commandRef: "echo hello",
    inputVariables: {},
    successCriteria: "exit_code=0",
    retryPolicy: {
      maxRetries: 1,
      backoffMs: 200
    }
  };
}

function createDefaultNode(order: number): BuilderNode {
  return {
    id: makeId("node"),
    name: `Node ${order + 1}`,
    order,
    configType: "SIMPLE",
    approvalRequired: false,
    failurePolicy: "RETRY",
    steps: [createDefaultStep()]
  };
}

function normalizeToken(input: string): string {
  return input.trim().replace(/^Bearer\s+/i, "");
}

function authHeaderFromStorage(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  if (!stored.trim()) return undefined;
  return `Bearer ${normalizeToken(stored)}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const auth = authHeaderFromStorage();
  if (auth) headers.authorization = auth;

  const response = await fetch(`${resolveApiBase()}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const auth = authHeaderFromStorage();
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

function formatTs(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function WorkflowBuilderPanel(): ReactElement {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [versions, setVersions] = useState<WorkflowVersionRecord[]>([]);

  const [name, setName] = useState<string>("New Workflow");
  const [description, setDescription] = useState<string>("Created from web workflow builder");
  const [nodes, setNodes] = useState<BuilderNode[]>([createDefaultNode(0)]);
  const [integrationProfiles, setIntegrationProfiles] = useState<IntegrationProfileRecord[]>([]);
  const [environments, setEnvironments] = useState<UserEnvironmentRecord[]>([]);
  const [integrationName, setIntegrationName] = useState<string>("");
  const [integrationType, setIntegrationType] = useState<ExecutionType>("REST");
  const [integrationBaseConfig, setIntegrationBaseConfig] = useState<string>('{\n  "baseUrl": "https://api.example.net"\n}');
  const [integrationCredentials, setIntegrationCredentials] = useState<string>('{\n  "authorization": "env:API_TOKEN"\n}');
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  useEffect(() => {
    let mounted = true;
    Promise.all([
      fetchJson<WorkflowSummary[]>("/workflows"),
      fetchJson<IntegrationProfileRecord[]>("/integrations?scope=all"),
      fetchJson<UserEnvironmentRecord[]>("/environments?scope=all")
    ])
      .then(([workflowsRows, integrationsRows, environmentRows]) => {
        if (!mounted) return;
        setIntegrationProfiles(integrationsRows);
        setEnvironments(environmentRows);
        setWorkflows(workflowsRows);
        if (!selectedWorkflowId && workflowsRows[0]?.id) {
          setSelectedWorkflowId(workflowsRows[0].id);
        }
      })
      .catch((loadError) => {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load workflow/integration data");
      });
    return () => {
      mounted = false;
    };
  }, [selectedWorkflowId, refreshNonce]);

  useEffect(() => {
    let mounted = true;
    if (!selectedWorkflowId) {
      setVersions([]);
      return () => {
        mounted = false;
      };
    }

    fetchJson<WorkflowDetailsResponse>(`/workflows/${selectedWorkflowId}`)
      .then((details) => {
        if (!mounted) return;
        setVersions(details.versions);
      })
      .catch((loadError) => {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load workflow versions");
      });

    return () => {
      mounted = false;
    };
  }, [selectedWorkflowId, refreshNonce]);

  function addNode(): void {
    setNodes((current) => [...current, createDefaultNode(current.length)]);
  }

  function removeNode(nodeIndex: number): void {
    setNodes((current) =>
      current
        .filter((_, index) => index !== nodeIndex)
        .map((node, index) => ({ ...node, order: index }))
    );
  }

  function patchNode(nodeIndex: number, patch: Partial<BuilderNode>): void {
    setNodes((current) => current.map((node, index) => (index === nodeIndex ? { ...node, ...patch } : node)));
  }

  function addStep(nodeIndex: number): void {
    setNodes((current) =>
      current.map((node, index) => {
        if (index !== nodeIndex) return node;
        return { ...node, steps: [...node.steps, createDefaultStep()] };
      })
    );
  }

  function removeStep(nodeIndex: number, stepIndex: number): void {
    setNodes((current) =>
      current.map((node, index) => {
        if (index !== nodeIndex) return node;
        const nextSteps = node.steps.filter((_, idx) => idx !== stepIndex);
        return { ...node, steps: nextSteps.length > 0 ? nextSteps : [createDefaultStep()] };
      })
    );
  }

  function patchStep(nodeIndex: number, stepIndex: number, patch: Partial<BuilderStep>): void {
    setNodes((current) =>
      current.map((node, index) => {
        if (index !== nodeIndex) return node;
        return {
          ...node,
          steps: node.steps.map((step, idx) => (idx === stepIndex ? { ...step, ...patch } : step))
        };
      })
    );
  }

  async function saveDraftWorkflow(): Promise<void> {
    setStatus("Saving workflow draft...");
    setError("");
    try {
      const payload = await postJson<{ workflow?: { id: string } }>("/workflows", {
        name,
        description,
        nodes: nodes.map((node, nodeIndex) => ({
          ...node,
          order: nodeIndex
        }))
      });
      const newId = payload.workflow?.id;
      setStatus("Workflow draft created.");
      if (newId) {
        setSelectedWorkflowId(newId);
      }
      setRefreshNonce((value) => value + 1);
    } catch (saveError) {
      setStatus("");
      setError(saveError instanceof Error ? saveError.message : "Failed to save workflow draft");
    }
  }

  async function publishSelectedWorkflow(): Promise<void> {
    if (!selectedWorkflowId) return;
    setStatus("Publishing selected workflow...");
    setError("");
    try {
      await postJson(`/workflows/${selectedWorkflowId}/publish`);
      setStatus("Selected workflow published.");
      setRefreshNonce((value) => value + 1);
    } catch (publishError) {
      setStatus("");
      setError(publishError instanceof Error ? publishError.message : "Failed to publish workflow");
    }
  }

  async function createIntegrationProfile(): Promise<void> {
    if (!integrationName.trim()) return;
    setStatus("Creating integration profile...");
    setError("");
    try {
      const parsedBaseConfig = JSON.parse(integrationBaseConfig) as Record<string, unknown>;
      const parsedCredentials = JSON.parse(integrationCredentials) as Record<string, unknown>;
      await postJson("/integrations", {
        name: integrationName.trim(),
        executionType: integrationType,
        baseConfig: parsedBaseConfig,
        credentials: parsedCredentials
      });
      setIntegrationName("");
      setStatus("Integration profile created.");
      setRefreshNonce((value) => value + 1);
    } catch (createError) {
      setStatus("");
      setError(createError instanceof Error ? createError.message : "Failed to create integration profile");
    }
  }

  const latestPublished = versions.find((version) => version.status === "PUBLISHED");

  return (
    <Panel title="Workflow Builder">
      <div className="builder-top-row">
        <label htmlFor="builder-workflow-select">Workflow</label>
        <select id="builder-workflow-select" value={selectedWorkflowId} onChange={(event) => setSelectedWorkflowId(event.target.value)}>
          <option value="">Select workflow</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name} ({workflow.id.slice(0, 8)})
            </option>
          ))}
        </select>
        <button type="button" onClick={() => publishSelectedWorkflow().catch(() => undefined)} disabled={!selectedWorkflowId}>
          Publish Selected
        </button>
      </div>

      <div className="builder-top-row">
        <label htmlFor="builder-name">Draft Name</label>
        <input id="builder-name" value={name} onChange={(event) => setName(event.target.value)} />
        <button type="button" onClick={() => saveDraftWorkflow().catch(() => undefined)}>
          Save As New Workflow
        </button>
      </div>

      <div className="builder-top-row">
        <label htmlFor="builder-description">Description</label>
        <input id="builder-description" value={description} onChange={(event) => setDescription(event.target.value)} />
        <button type="button" onClick={addNode}>
          Add Node
        </button>
      </div>

      <div className="builder-top-row">
        <label htmlFor="integration-name">Integration</label>
        <input
          id="integration-name"
          value={integrationName}
          onChange={(event) => setIntegrationName(event.target.value)}
          placeholder="Integration profile name"
        />
        <select value={integrationType} onChange={(event) => setIntegrationType(event.target.value as ExecutionType)}>
          <option value="REST">REST</option>
          <option value="SSH">SSH</option>
          <option value="NETCONF">NETCONF</option>
          <option value="SCRIPT">SCRIPT</option>
        </select>
        <button type="button" onClick={() => createIntegrationProfile().catch(() => undefined)}>
          Add Integration
        </button>
      </div>
      <div className="ops-form-row">
        <label htmlFor="integration-base-config">Base Config JSON</label>
        <textarea
          id="integration-base-config"
          rows={3}
          value={integrationBaseConfig}
          onChange={(event) => setIntegrationBaseConfig(event.target.value)}
        />
        <span />
        <span />
      </div>
      <div className="ops-form-row">
        <label htmlFor="integration-credentials">Credentials JSON</label>
        <textarea
          id="integration-credentials"
          rows={3}
          value={integrationCredentials}
          onChange={(event) => setIntegrationCredentials(event.target.value)}
        />
        <span />
        <span />
      </div>

      <p className="ops-status-line">
        Latest published version: {latestPublished?.version ?? "-"} {latestPublished ? <StatusBadge status={latestPublished.status} /> : null}
      </p>
      <p className="ops-status-line">Builder status: {status || "-"}</p>
      {error ? <p className="ops-error">{error}</p> : null}

      <div className="builder-node-list">
        {nodes.map((node, nodeIndex) => (
          <article key={node.id} className="builder-node-card">
            <div className="builder-node-header">
              <strong>Node {nodeIndex + 1}</strong>
              <button type="button" onClick={() => removeNode(nodeIndex)}>
                Remove Node
              </button>
            </div>

            <div className="builder-grid-3">
              <input value={node.name} onChange={(event) => patchNode(nodeIndex, { name: event.target.value })} placeholder="Node name" />
              <select
                value={node.integrationProfileId ?? ""}
                onChange={(event) => patchNode(nodeIndex, { integrationProfileId: event.target.value || undefined })}
              >
                <option value="">No Integration</option>
                {integrationProfiles.map((integration) => (
                  <option key={integration.id} value={integration.id}>
                    {integration.name} ({integration.executionType})
                  </option>
                ))}
              </select>
              <select value={node.environmentId ?? ""} onChange={(event) => patchNode(nodeIndex, { environmentId: event.target.value || undefined })}>
                <option value="">Order Environment (Default)</option>
                {environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>
                    {environment.name} ({environment.ownerId})
                  </option>
                ))}
              </select>
              <select
                value={node.failurePolicy}
                onChange={(event) => patchNode(nodeIndex, { failurePolicy: event.target.value as FailurePolicy })}
              >
                <option value="RETRY">RETRY</option>
                <option value="CONTINUE">CONTINUE</option>
                <option value="ROLLBACK">ROLLBACK</option>
              </select>
              <label className="builder-inline-check">
                <input
                  type="checkbox"
                  checked={node.approvalRequired}
                  onChange={(event) => patchNode(nodeIndex, { approvalRequired: event.target.checked })}
                />
                Approval Required
              </label>
            </div>

            {node.steps.map((step, stepIndex) => (
              <div key={step.id} className="builder-step-card">
                <div className="builder-node-header">
                  <span>Step {stepIndex + 1}</span>
                  <button type="button" onClick={() => removeStep(nodeIndex, stepIndex)}>
                    Remove Step
                  </button>
                </div>
                <div className="builder-grid-3">
                  <input
                    value={step.name}
                    onChange={(event) => patchStep(nodeIndex, stepIndex, { name: event.target.value })}
                    placeholder="Step name"
                  />
                  <select
                    value={step.executionType}
                    onChange={(event) => patchStep(nodeIndex, stepIndex, { executionType: event.target.value as ExecutionType })}
                  >
                    <option value="SCRIPT">SCRIPT</option>
                    <option value="REST">REST</option>
                    <option value="SSH">SSH</option>
                    <option value="NETCONF">NETCONF</option>
                  </select>
                  <input
                    value={step.commandRef}
                    onChange={(event) => patchStep(nodeIndex, stepIndex, { commandRef: event.target.value })}
                    placeholder="Command/endpoint ref"
                  />
                </div>
                <div className="builder-grid-3">
                  <input
                    value={step.successCriteria}
                    onChange={(event) => patchStep(nodeIndex, stepIndex, { successCriteria: event.target.value })}
                    placeholder="Success criteria"
                  />
                  <input
                    type="number"
                    min={0}
                    value={step.retryPolicy.maxRetries}
                    onChange={(event) =>
                      patchStep(nodeIndex, stepIndex, {
                        retryPolicy: { ...step.retryPolicy, maxRetries: Number(event.target.value) }
                      })
                    }
                    placeholder="Max retries"
                  />
                  <input
                    type="number"
                    min={0}
                    value={step.retryPolicy.backoffMs}
                    onChange={(event) =>
                      patchStep(nodeIndex, stepIndex, {
                        retryPolicy: { ...step.retryPolicy, backoffMs: Number(event.target.value) }
                      })
                    }
                    placeholder="Backoff (ms)"
                  />
                </div>
              </div>
            ))}

            <button type="button" onClick={() => addStep(nodeIndex)}>
              Add Step
            </button>
          </article>
        ))}
      </div>

      <div className="ops-table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th>Integration</th>
              <th>Type</th>
              <th>Owner</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {integrationProfiles.length === 0 ? (
              <tr>
                <td colSpan={4}>No integration profiles yet.</td>
              </tr>
            ) : (
              integrationProfiles.map((integration) => (
                <tr key={integration.id}>
                  <td>{integration.name}</td>
                  <td>{integration.executionType}</td>
                  <td>{integration.ownerId}</td>
                  <td>{formatTs(integration.updatedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="ops-table-wrap">
        <table className="ops-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Status</th>
              <th>Created</th>
              <th>Version ID</th>
            </tr>
          </thead>
          <tbody>
            {versions.length === 0 ? (
              <tr>
                <td colSpan={4}>No versions for selected workflow.</td>
              </tr>
            ) : (
              versions.map((version) => (
                <tr key={version.id}>
                  <td>{version.version}</td>
                  <td>
                    <StatusBadge status={version.status} />
                  </td>
                  <td>{formatTs(version.createdAt)}</td>
                  <td>
                    <code>{version.id}</code>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
