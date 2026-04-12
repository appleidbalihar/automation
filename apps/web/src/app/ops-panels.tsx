"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Panel, StatusBadge } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";
import { authHeaderFromStoredToken, fetchIdentity, TOKEN_STORAGE_KEY } from "./auth-client";

interface WorkflowSummary {
  id: string;
  name: string;
}

interface WorkflowVersion {
  id: string;
  status: string;
  version: number;
}

interface WorkflowPublishAudit {
  id: string;
  workflowVersionId: string;
  version: number;
  status: string;
  processedAt?: string;
}

interface RagIndexJob {
  id: string;
  source: string;
  requestedDocuments?: number;
  status: string;
  processedAt?: string;
  correlationId?: string;
}

interface AuthIdentity {
  userId: string;
  roles: string[];
}

interface UserEnvironment {
  id: string;
  name: string;
  ownerId: string;
  isDefault: boolean;
  variablesJson?: Record<string, unknown>;
  updatedAt: string;
}

async function fetchJson<T>(path: string, authHeader?: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (authHeader) {
    headers.authorization = authHeader;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown, authHeader?: string): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (authHeader) {
    headers.authorization = authHeader;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postNoBody(path: string, authHeader?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (authHeader) {
    headers.authorization = authHeader;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
}

function hasRole(identity: AuthIdentity | null, required: string[]): boolean {
  const roles = identity?.roles ?? ["viewer"];
  return required.some((role) => roles.includes(role));
}

function formatRoles(identity: AuthIdentity | null): string {
  const roles = identity?.roles ?? ["viewer"];
  return roles.join(", ");
}

function formatTs(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function OpsPanels(): ReactElement {
  const [authTokenSaved, setAuthTokenSaved] = useState<string>("");
  const [authIdentity, setAuthIdentity] = useState<AuthIdentity | null>(null);
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>("");
  const [selectedWorkflowVersionId, setSelectedWorkflowVersionId] = useState<string>("");
  const [selectedWorkflowVersionNumber, setSelectedWorkflowVersionNumber] = useState<number | null>(null);
  const [publishAudits, setPublishAudits] = useState<WorkflowPublishAudit[]>([]);
  const [ragJobs, setRagJobs] = useState<RagIndexJob[]>([]);
  const [ragSource, setRagSource] = useState<string>("incident-ops");
  const [ragDocuments, setRagDocuments] = useState<string>("2");
  const [environments, setEnvironments] = useState<UserEnvironment[]>([]);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");
  const [environmentName, setEnvironmentName] = useState<string>("default");
  const [environmentVariables, setEnvironmentVariables] = useState<string>("{\n  \"API_BASE_URL\": \"https://example.net\"\n}");
  const [orderId, setOrderId] = useState<string>("");
  const [actionStatus, setActionStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const saved = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
    setAuthTokenSaved(saved);
  }, []);

  useEffect(() => {
    let mounted = true;
    const authHeader = authHeaderFromStoredToken();

    async function load(): Promise<void> {
      try {
        const [identity, workflowList, jobs, envList] = await Promise.all([
          fetchIdentity(),
          fetchJson<WorkflowSummary[]>("/workflows", authHeader),
          fetchJson<RagIndexJob[]>("/rag/jobs", authHeader),
          fetchJson<UserEnvironment[]>("/environments?limit=100", authHeader)
        ]);
        if (!mounted) return;
        setAuthIdentity(identity);
        setWorkflows(workflowList);
        setRagJobs(jobs);
        setEnvironments(envList);
        if (!selectedEnvironmentId && envList[0]?.id) {
          const preferred = envList.find((entry) => entry.isDefault)?.id ?? envList[0].id;
          setSelectedEnvironmentId(preferred);
        }
        const firstWorkflowId = workflowList[0]?.id ?? "";
        if (!selectedWorkflowId && firstWorkflowId) {
          setSelectedWorkflowId(firstWorkflowId);
        }
        setError("");
      } catch (loadError) {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load operations data");
      }
    }

    load().catch(() => undefined);
    const timer = window.setInterval(() => {
      load().catch(() => undefined);
    }, 6000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [authTokenSaved, refreshNonce, selectedWorkflowId]);

  useEffect(() => {
    let mounted = true;
    if (!selectedWorkflowId) {
      setPublishAudits([]);
      return () => {
        mounted = false;
      };
    }
    const authHeader = authHeaderFromStoredToken();
    Promise.all([
      fetchJson<WorkflowPublishAudit[]>(`/workflows/${selectedWorkflowId}/publish-audits`, authHeader),
      fetchJson<{ versions: WorkflowVersion[] }>(`/workflows/${selectedWorkflowId}`, authHeader)
    ])
      .then(([rows, workflowDetails]) => {
        if (!mounted) return;
        setPublishAudits(rows);
        const published = workflowDetails.versions.find((version) => version.status === "PUBLISHED");
        if (published) {
          setSelectedWorkflowVersionId(published.id);
          setSelectedWorkflowVersionNumber(published.version);
        }
      })
      .catch((loadError) => {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load workflow operations data");
      });
    return () => {
      mounted = false;
    };
  }, [authTokenSaved, selectedWorkflowId, refreshNonce]);

  async function refreshOperationsData(): Promise<void> {
    setRefreshNonce((value) => value + 1);
  }

  async function publishWorkflow(): Promise<void> {
    if (!selectedWorkflowId) return;
    setActionStatus("Publishing workflow...");
    try {
      await postNoBody(`/workflows/${selectedWorkflowId}/publish`, authHeaderFromStoredToken());
      setActionStatus("Workflow published successfully.");
      await refreshOperationsData();
    } catch (publishError) {
      setActionStatus(publishError instanceof Error ? publishError.message : "Workflow publish failed");
    }
  }

  async function triggerRagIndex(): Promise<void> {
    setActionStatus("Requesting RAG index...");
    try {
      await postJson(
        "/rag/index",
        {
          source: ragSource,
          documents: Number(ragDocuments)
        },
        authHeaderFromStoredToken()
      );
      setActionStatus("RAG index requested.");
      await refreshOperationsData();
    } catch (indexError) {
      setActionStatus(indexError instanceof Error ? indexError.message : "RAG index request failed");
    }
  }

  async function executeOrder(): Promise<void> {
    if (!selectedWorkflowVersionId) return;
    setActionStatus("Executing order...");
    try {
      const payload = await postJson<{ orderId?: string }>(
        "/orders/execute",
        {
          workflowVersionId: selectedWorkflowVersionId,
          environmentId: selectedEnvironmentId || undefined,
          input: { triggeredFrom: "web-ops-panel" },
          initiatedBy: authIdentity?.userId ?? "web-user"
        },
        authHeaderFromStoredToken()
      );
      if (payload.orderId) {
        setOrderId(payload.orderId);
      }
      setActionStatus("Order execution submitted.");
    } catch (executeError) {
      setActionStatus(executeError instanceof Error ? executeError.message : "Order execute failed");
    }
  }

  async function createEnvironment(): Promise<void> {
    setActionStatus("Creating environment...");
    try {
      const parsedVariables = JSON.parse(environmentVariables) as Record<string, unknown>;
      await postJson(
        "/environments",
        {
          name: environmentName,
          variables: parsedVariables,
          isDefault: environments.length === 0
        },
        authHeaderFromStoredToken()
      );
      setActionStatus("Environment saved.");
      await refreshOperationsData();
    } catch (envError) {
      setActionStatus(envError instanceof Error ? envError.message : "Environment creation failed");
    }
  }

  async function retryOrder(): Promise<void> {
    if (!orderId) return;
    setActionStatus("Submitting retry...");
    try {
      await postNoBody(`/orders/${orderId}/retry`, authHeaderFromStoredToken());
      setActionStatus("Retry queued.");
    } catch (retryError) {
      setActionStatus(retryError instanceof Error ? retryError.message : "Retry failed");
    }
  }

  async function rollbackOrder(): Promise<void> {
    if (!orderId) return;
    setActionStatus("Submitting rollback...");
    try {
      await postNoBody(`/orders/${orderId}/rollback`, authHeaderFromStoredToken());
      setActionStatus("Rollback completed.");
    } catch (rollbackError) {
      setActionStatus(rollbackError instanceof Error ? rollbackError.message : "Rollback failed");
    }
  }

  const canPublish = hasRole(authIdentity, ["admin"]) && Boolean(selectedWorkflowId);
  const canIndex = hasRole(authIdentity, ["admin", "useradmin", "operator"]);
  const canExecute = hasRole(authIdentity, ["admin", "useradmin", "operator"]);
  const canRetryOrRollback = hasRole(authIdentity, ["admin", "useradmin", "operator"]) && orderId.length > 0;

  return (
    <>
      <Panel title="Authentication Context">
        <div className="ops-actions-grid">
          <button type="button" onClick={() => refreshOperationsData().catch(() => undefined)}>
            Refresh Identity
          </button>
        </div>
        <p className="ops-status-line">Session token present: {authTokenSaved ? "yes" : "no"}</p>
        <p className="ops-status-line">User: {authIdentity?.userId ?? "anonymous"}</p>
        <p className="ops-status-line">Roles: {formatRoles(authIdentity)}</p>
      </Panel>

      <Panel title="Operations Actions">
        <div className="ops-actions-grid">
          <button type="button" disabled={!canPublish} onClick={() => publishWorkflow().catch(() => undefined)}>
            Publish Workflow
          </button>
          <button type="button" disabled={!canIndex} onClick={() => triggerRagIndex().catch(() => undefined)}>
            Trigger RAG Index
          </button>
          <button type="button" disabled={!canExecute || !selectedWorkflowVersionId} onClick={() => executeOrder().catch(() => undefined)}>
            Execute Order
          </button>
          <button type="button" disabled={!canRetryOrRollback} onClick={() => retryOrder().catch(() => undefined)}>
            Retry Order
          </button>
          <button type="button" disabled={!canRetryOrRollback} onClick={() => rollbackOrder().catch(() => undefined)}>
            Rollback Order
          </button>
        </div>
        <div className="ops-form-row">
          <label htmlFor="rag-source">RAG Source</label>
          <input id="rag-source" value={ragSource} onChange={(event) => setRagSource(event.target.value)} />
          <label htmlFor="rag-docs">Docs</label>
          <input id="rag-docs" value={ragDocuments} onChange={(event) => setRagDocuments(event.target.value)} />
        </div>
        <div className="ops-form-row">
          <label htmlFor="order-id">Order ID</label>
          <input id="order-id" value={orderId} onChange={(event) => setOrderId(event.target.value)} />
        </div>
        <div className="ops-form-row">
          <label htmlFor="order-env">Order Environment</label>
          <select id="order-env" value={selectedEnvironmentId} onChange={(event) => setSelectedEnvironmentId(event.target.value)}>
            <option value="">No environment</option>
            {environments.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} {entry.isDefault ? "(default)" : ""}
              </option>
            ))}
          </select>
          <span />
          <span />
        </div>
        <div className="ops-form-row">
          <label htmlFor="env-name">New Env Name</label>
          <input id="env-name" value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} />
          <button type="button" onClick={() => createEnvironment().catch(() => undefined)}>
            Save Env
          </button>
          <span />
        </div>
        <div className="ops-form-row">
          <label htmlFor="env-vars">Env JSON</label>
          <textarea
            id="env-vars"
            rows={4}
            value={environmentVariables}
            onChange={(event) => setEnvironmentVariables(event.target.value)}
          />
          <span />
          <span />
        </div>
        <p className="ops-status-line">
          Selected workflow version: {selectedWorkflowVersionNumber ?? "-"} ({selectedWorkflowVersionId || "none"})
        </p>
        <p className="ops-status-line">Action status: {actionStatus || "-"}</p>
      </Panel>

      <Panel title="Workflow Publish Audits">
        <div className="ops-controls">
          <label htmlFor="workflow-select">Workflow</label>
          <select id="workflow-select" value={selectedWorkflowId} onChange={(event) => setSelectedWorkflowId(event.target.value)}>
            <option value="">Select workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name} ({workflow.id.slice(0, 8)})
              </option>
            ))}
          </select>
        </div>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Version</th>
                <th>Status</th>
                <th>Processed</th>
                <th>Workflow Version</th>
              </tr>
            </thead>
            <tbody>
              {publishAudits.length === 0 ? (
                <tr>
                  <td colSpan={4}>No publish audits yet.</td>
                </tr>
              ) : (
                publishAudits.slice(0, 6).map((audit) => (
                  <tr key={audit.id}>
                    <td>{audit.version}</td>
                    <td>
                      <StatusBadge status={audit.status} />
                    </td>
                    <td>{formatTs(audit.processedAt)}</td>
                    <td>
                      <code>{audit.workflowVersionId}</code>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="RAG Index Jobs">
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Status</th>
                <th>Documents</th>
                <th>Processed</th>
                <th>Correlation</th>
              </tr>
            </thead>
            <tbody>
              {ragJobs.length === 0 ? (
                <tr>
                  <td colSpan={5}>No RAG jobs yet.</td>
                </tr>
              ) : (
                ragJobs.slice(0, 8).map((job) => (
                  <tr key={job.id}>
                    <td>{job.source}</td>
                    <td>
                      <StatusBadge status={job.status} />
                    </td>
                    <td>{job.requestedDocuments ?? "-"}</td>
                    <td>{formatTs(job.processedAt)}</td>
                    <td>
                      <code>{job.correlationId ?? "-"}</code>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {error ? <p className="ops-error">{error}</p> : null}
      </Panel>
    </>
  );
}
