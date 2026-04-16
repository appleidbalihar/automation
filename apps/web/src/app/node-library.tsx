"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, ReactElement } from "react";
import { authHeaderFromStoredToken } from "./auth-client";
import { resolveApiBase } from "./api-base";
import { AuthGate } from "./auth-gate";
import { NavigationSidebar } from "./navigation-sidebar";

type WorkflowNodeType = "TRIGGER" | "CONDITION" | "ACTION" | "APPROVAL";
type FailurePolicy = "RETRY" | "CONTINUE" | "ROLLBACK";
type ApprovalMode = "NONE" | "MANUAL" | "AUTO_WITH_TIMEOUT";
type AutoDecision = "APPROVE" | "REJECT";
type ExecutionType = "REST" | "SSH" | "NETCONF" | "SCRIPT";
type NodeTemplateAccess = "OWNER" | "SHARED" | "ADMIN";
type ScopeFilter = "all" | "mine" | "shared";
type ModalMode = "create" | "view" | "update" | "share" | "delete";
type EditorViewMode = "form" | "json";

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

interface NodeTemplateConfig {
  nodeType: WorkflowNodeType;
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
  config: NodeTemplateConfig;
  metadata?: Record<string, unknown>;
}

interface NodeTemplateEditorState {
  id?: string;
  name: string;
  description: string;
  category: string;
  tags: string;
  nodeType: WorkflowNodeType;
  configType: string;
  integrationProfileId: string;
  environmentId: string;
  approvalMode: ApprovalMode;
  approvalTimeoutSec: number;
  autoDecision: AutoDecision;
  failurePolicy: FailurePolicy;
  steps: BuilderStep[];
  metadataText: string;
  access?: NodeTemplateAccess;
  ownerId?: string;
  sharedWithUsers: string[];
}

function authHeaders(hasBody: boolean): Record<string, string> {
  const authorization = authHeaderFromStoredToken();
  if (!authorization) {
    throw new Error("You are not signed in.");
  }
  return {
    authorization,
    ...(hasBody ? { "content-type": "application/json" } : {})
  };
}

async function requestJson<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method,
    headers: authHeaders(body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  const payload = raw ? safeParseJson(raw) : {};
  if (!response.ok) {
    const details =
      (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).details) ||
      (payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).error) ||
      `HTTP ${response.status}`;
    throw new Error(String(details));
  }
  return payload as T;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function formatDate(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function createDefaultStep(index: number, nodeType: WorkflowNodeType): BuilderStep {
  return {
    id: makeId("step"),
    name: `${nodeType} Step ${index + 1}`,
    executionType: nodeType === "TRIGGER" ? "REST" : "SCRIPT",
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

function createDefaultEditor(nodeType: WorkflowNodeType = "ACTION"): NodeTemplateEditorState {
  return {
    name: "Untitled Template",
    description: "",
    category: "operations",
    tags: "",
    nodeType,
    configType: "SIMPLE",
    integrationProfileId: "",
    environmentId: "",
    approvalMode: nodeType === "APPROVAL" ? "MANUAL" : "NONE",
    approvalTimeoutSec: 300,
    autoDecision: "APPROVE",
    failurePolicy: "RETRY",
    steps: [createDefaultStep(0, nodeType)],
    metadataText: JSON.stringify({}, null, 2),
    sharedWithUsers: []
  };
}

function cloneStep(step: BuilderStep, index: number, nodeType: WorkflowNodeType): BuilderStep {
  return {
    id: step.id || makeId("step"),
    name: step.name || `${nodeType} Step ${index + 1}`,
    executionType: step.executionType,
    commandRef: step.commandRef,
    inputVariables: { ...(step.inputVariables ?? {}) },
    successCriteria: step.successCriteria,
    successConditions: Array.isArray(step.successConditions) ? [...step.successConditions] : [step.successCriteria || "exit_code=0"],
    timeoutSec: step.timeoutSec ?? 60,
    requestTemplate: step.requestTemplate ?? "",
    expectedResponse: step.expectedResponse ?? "",
    loggingEnabled: Boolean(step.loggingEnabled),
    retryPolicy: {
      maxRetries: Number(step.retryPolicy?.maxRetries ?? 1),
      backoffMs: Number(step.retryPolicy?.backoffMs ?? 250)
    },
    rollbackAction: step.rollbackAction ?? ""
  };
}

function editorFromRecord(record: NodeTemplateRecord): NodeTemplateEditorState {
  return {
    id: record.id,
    name: record.name,
    description: record.description ?? "",
    category: record.category ?? "",
    tags: record.tags.join(", "),
    nodeType: record.nodeType,
    configType: record.config.configType,
    integrationProfileId: record.config.integrationProfileId ?? "",
    environmentId: record.config.environmentId ?? "",
    approvalMode: record.config.approvalMode,
    approvalTimeoutSec: record.config.approvalTimeoutSec ?? 300,
    autoDecision: record.config.autoDecision ?? "APPROVE",
    failurePolicy: record.config.failurePolicy,
    steps: (record.config.steps ?? []).map((step, index) => cloneStep(step, index, record.nodeType)),
    metadataText: JSON.stringify(record.metadata ?? {}, null, 2),
    access: record.access,
    ownerId: record.ownerId,
    sharedWithUsers: record.sharedWithUsers
  };
}

function editorToConfig(editor: NodeTemplateEditorState): NodeTemplateConfig {
  return {
    nodeType: editor.nodeType,
    configType: editor.configType || "SIMPLE",
    integrationProfileId: editor.integrationProfileId.trim() || undefined,
    environmentId: editor.environmentId.trim() || undefined,
    approvalRequired: editor.approvalMode !== "NONE",
    approvalMode: editor.approvalMode,
    approvalTimeoutSec: editor.approvalMode === "AUTO_WITH_TIMEOUT" ? Math.max(1, Number(editor.approvalTimeoutSec || 300)) : undefined,
    autoDecision: editor.approvalMode === "AUTO_WITH_TIMEOUT" ? editor.autoDecision : undefined,
    failurePolicy: editor.failurePolicy,
    steps: editor.steps.map((step, index) => ({
      ...cloneStep(step, index, editor.nodeType),
      successConditions:
        Array.isArray(step.successConditions) && step.successConditions.length > 0
          ? step.successConditions.map((condition) => condition.trim()).filter(Boolean)
          : [step.successCriteria || "exit_code=0"]
    }))
  };
}

function editorToJson(editor: NodeTemplateEditorState): string {
  return JSON.stringify(
    {
      schemaVersion: "v1",
      name: editor.name,
      description: editor.description || undefined,
      category: editor.category || undefined,
      tags: editor.tags
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
      config: editorToConfig(editor),
      metadata: JSON.parse(editor.metadataText || "{}")
    },
    null,
    2
  );
}

function editorFromJson(text: string, fallback?: NodeTemplateEditorState): NodeTemplateEditorState {
  const payload = JSON.parse(text) as {
    name?: string;
    description?: string;
    category?: string;
    tags?: string[];
    config?: Partial<NodeTemplateConfig>;
    metadata?: Record<string, unknown>;
  };
  const nodeType = (payload.config?.nodeType ?? fallback?.nodeType ?? "ACTION") as WorkflowNodeType;
  const defaults = fallback ?? createDefaultEditor(nodeType);
  return {
    ...defaults,
    name: String(payload.name ?? defaults.name),
    description: String(payload.description ?? defaults.description),
    category: String(payload.category ?? defaults.category),
    tags: Array.isArray(payload.tags) ? payload.tags.join(", ") : defaults.tags,
    nodeType,
    configType: String(payload.config?.configType ?? defaults.configType),
    integrationProfileId: String(payload.config?.integrationProfileId ?? defaults.integrationProfileId),
    environmentId: String(payload.config?.environmentId ?? defaults.environmentId),
    approvalMode: (payload.config?.approvalMode ?? defaults.approvalMode) as ApprovalMode,
    approvalTimeoutSec: Number(payload.config?.approvalTimeoutSec ?? defaults.approvalTimeoutSec),
    autoDecision: (payload.config?.autoDecision ?? defaults.autoDecision) as AutoDecision,
    failurePolicy: (payload.config?.failurePolicy ?? defaults.failurePolicy) as FailurePolicy,
    steps:
      Array.isArray(payload.config?.steps) && payload.config.steps.length > 0
        ? payload.config.steps.map((step, index) => cloneStep(step as BuilderStep, index, nodeType))
        : defaults.steps,
    metadataText: JSON.stringify(payload.metadata ?? JSON.parse(defaults.metadataText), null, 2)
  };
}

function rowsFromObject(value: Record<string, string>): Array<{ key: string; value: string }> {
  const entries = Object.entries(value);
  return entries.length > 0 ? entries.map(([key, rowValue]) => ({ key, value: rowValue })) : [{ key: "", value: "" }];
}

function objectFromRows(rows: Array<{ key: string; value: string }>): Record<string, string> {
  return rows.reduce<Record<string, string>>((accumulator, row) => {
    const key = row.key.trim();
    if (key) accumulator[key] = row.value;
    return accumulator;
  }, {});
}

function StepFormCard(props: {
  step: BuilderStep;
  index: number;
  nodeType: WorkflowNodeType;
  readOnly: boolean;
  onChange: (step: BuilderStep) => void;
  onRemove: () => void;
}): ReactElement {
  const [inputRows, setInputRows] = useState<Array<{ key: string; value: string }>>(rowsFromObject(props.step.inputVariables ?? {}));
  const [successRows, setSuccessRows] = useState<string[]>(
    Array.isArray(props.step.successConditions) && props.step.successConditions.length > 0
      ? [...props.step.successConditions]
      : [props.step.successCriteria || "exit_code=0"]
  );

  useEffect(() => {
    setInputRows(rowsFromObject(props.step.inputVariables ?? {}));
    setSuccessRows(
      Array.isArray(props.step.successConditions) && props.step.successConditions.length > 0
        ? [...props.step.successConditions]
        : [props.step.successCriteria || "exit_code=0"]
    );
  }, [props.step]);

  function patch(patchValue: Partial<BuilderStep>): void {
    props.onChange({
      ...props.step,
      ...patchValue,
      successConditions: patchValue.successConditions ?? successRows,
      inputVariables: patchValue.inputVariables ?? objectFromRows(inputRows)
    });
  }

  return (
    <section className="node-library-step-card">
      <div className="node-library-step-header">
        <div>
          <strong>Command {props.index + 1}</strong>
          <span>Step IDs are unique and auto-generated by the platform.</span>
        </div>
        {!props.readOnly ? (
          <button type="button" className="node-library-danger-button" onClick={props.onRemove}>
            Remove
          </button>
        ) : null}
      </div>

      <div className="node-library-form-grid">
        <label>
          Step ID
          <input value={props.step.id} readOnly disabled />
        </label>
        <label>
          Step Name
          <input value={props.step.name} disabled={props.readOnly} onChange={(event) => patch({ name: event.target.value })} />
        </label>
        <label>
          Execution Type
          <select
            value={props.step.executionType}
            disabled={props.readOnly}
            onChange={(event) => patch({ executionType: event.target.value as ExecutionType })}
          >
            <option value="REST">REST</option>
            <option value="SSH">SSH</option>
            <option value="NETCONF">NETCONF</option>
            <option value="SCRIPT">SCRIPT</option>
          </select>
        </label>
        <label>
          Timeout (seconds)
          <input
            type="number"
            min={0}
            value={props.step.timeoutSec ?? 60}
            disabled={props.readOnly}
            onChange={(event) => patch({ timeoutSec: Math.max(0, Number(event.target.value || 0)) })}
          />
        </label>
        <label className="node-library-form-span-2">
          Command / Script / API Ref
          <textarea
            rows={3}
            value={props.step.commandRef}
            disabled={props.readOnly}
            onChange={(event) => patch({ commandRef: event.target.value })}
          />
        </label>
        <label className="node-library-form-span-2">
          Request Payload / Request Template
          <textarea
            rows={4}
            value={props.step.requestTemplate ?? ""}
            disabled={props.readOnly}
            onChange={(event) => patch({ requestTemplate: event.target.value })}
          />
        </label>
        <label className="node-library-form-span-2">
          Expected Response
          <textarea
            rows={4}
            value={props.step.expectedResponse ?? ""}
            disabled={props.readOnly}
            onChange={(event) => patch({ expectedResponse: event.target.value })}
          />
        </label>
        <label>
          Legacy Success Criteria
          <input
            value={props.step.successCriteria}
            disabled={props.readOnly}
            onChange={(event) => patch({ successCriteria: event.target.value })}
          />
        </label>
        <label>
          Rollback Action
          <input
            value={props.step.rollbackAction ?? ""}
            disabled={props.readOnly}
            onChange={(event) => patch({ rollbackAction: event.target.value })}
          />
        </label>
        <label>
          Max Retries
          <input
            type="number"
            min={0}
            value={props.step.retryPolicy.maxRetries}
            disabled={props.readOnly}
            onChange={(event) =>
              patch({
                retryPolicy: {
                  ...props.step.retryPolicy,
                  maxRetries: Math.max(0, Number(event.target.value || 0))
                }
              })
            }
          />
        </label>
        <label>
          Retry Backoff (ms)
          <input
            type="number"
            min={0}
            value={props.step.retryPolicy.backoffMs}
            disabled={props.readOnly}
            onChange={(event) =>
              patch({
                retryPolicy: {
                  ...props.step.retryPolicy,
                  backoffMs: Math.max(0, Number(event.target.value || 0))
                }
              })
            }
          />
        </label>
        <label className="node-library-checkbox-row">
          <input
            type="checkbox"
            checked={props.step.loggingEnabled}
            disabled={props.readOnly}
            onChange={(event) => patch({ loggingEnabled: event.target.checked })}
          />
          <span>Enable detailed step logging</span>
        </label>
      </div>

      <div className="node-library-subsection">
        <div className="node-library-subsection-header">
          <strong>Input Variables</strong>
          {!props.readOnly ? (
            <button type="button" className="node-library-secondary-button" onClick={() => setInputRows((current) => [...current, { key: "", value: "" }])}>
              Add Variable
            </button>
          ) : null}
        </div>
        <div className="node-library-keyvalue-list">
          {inputRows.map((row, index) => (
            <div key={`${props.step.id}-input-${index}`} className="node-library-keyvalue-row">
              <input
                value={row.key}
                placeholder="name"
                disabled={props.readOnly}
                onChange={(event) => {
                  const next = [...inputRows];
                  next[index] = { ...next[index], key: event.target.value };
                  setInputRows(next);
                  patch({ inputVariables: objectFromRows(next) });
                }}
              />
              <input
                value={row.value}
                placeholder="value"
                disabled={props.readOnly}
                onChange={(event) => {
                  const next = [...inputRows];
                  next[index] = { ...next[index], value: event.target.value };
                  setInputRows(next);
                  patch({ inputVariables: objectFromRows(next) });
                }}
              />
              {!props.readOnly ? (
                <button
                  type="button"
                  className="node-library-danger-button"
                  onClick={() => {
                    const next = inputRows.filter((_, rowIndex) => rowIndex !== index);
                    const normalized = next.length > 0 ? next : [{ key: "", value: "" }];
                    setInputRows(normalized);
                    patch({ inputVariables: objectFromRows(normalized) });
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      <div className="node-library-subsection">
        <div className="node-library-subsection-header">
          <strong>Success Conditions</strong>
          {!props.readOnly ? (
            <button type="button" className="node-library-secondary-button" onClick={() => setSuccessRows((current) => [...current, ""])}>
              Add Success Condition
            </button>
          ) : null}
        </div>
        <div className="node-library-success-list">
          {successRows.map((condition, index) => (
            <div key={`${props.step.id}-success-${index}`} className="node-library-success-row">
              <input
                value={condition}
                placeholder="200 OK, 201 Created, exit_code=0, response.status=READY"
                disabled={props.readOnly}
                onChange={(event) => {
                  const next = [...successRows];
                  next[index] = event.target.value;
                  setSuccessRows(next);
                  patch({ successConditions: next });
                }}
              />
              {!props.readOnly ? (
                <button
                  type="button"
                  className="node-library-danger-button"
                  onClick={() => {
                    const next = successRows.filter((_, rowIndex) => rowIndex !== index);
                    const normalized = next.length > 0 ? next : [props.step.successCriteria || "exit_code=0"];
                    setSuccessRows(normalized);
                    patch({ successConditions: normalized });
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function EditorModal(props: {
  mode: ModalMode;
  viewMode: EditorViewMode;
  editor: NodeTemplateEditorState;
  shareUsername: string;
  busy: boolean;
  error: string;
  onClose: () => void;
  onToggleViewMode: (mode: EditorViewMode) => void;
  onEditorChange: (editor: NodeTemplateEditorState) => void;
  onShareUsernameChange: (value: string) => void;
  onSubmit: () => void;
  onDeleteConfirm: () => void;
  onShareSubmit: () => void;
  onShareRemove: (username: string) => void;
}): ReactElement {
  const readOnly = props.mode === "view";
  const [jsonDraft, setJsonDraft] = useState<string>("");
  const [jsonError, setJsonError] = useState<string>("");
  const title =
    props.mode === "create"
      ? "Create Template"
      : props.mode === "update"
        ? "Update Template"
        : props.mode === "share"
          ? "Share Template"
          : props.mode === "delete"
            ? "Delete Template"
            : "View Template";

  const jsonText = useMemo(() => editorToJson(props.editor), [props.editor]);

  useEffect(() => {
    setJsonDraft(jsonText);
    setJsonError("");
  }, [jsonText, props.mode]);

  if (props.mode === "delete") {
    return (
      <div className="node-library-modal-backdrop" onClick={props.onClose}>
        <div className="node-library-modal" onClick={(event) => event.stopPropagation()}>
          <div className="node-library-section-header">
            <div>
              <h2>{title}</h2>
              <p>This action will remove the template and its sharing metadata.</p>
            </div>
          </div>
          <div className="node-library-delete-copy">
            <strong>{props.editor.name}</strong>
            <span>{props.editor.description || "No description provided."}</span>
          </div>
          {props.error ? <div className="node-library-inline-error">{props.error}</div> : null}
          <div className="node-library-modal-actions">
            <button className="node-library-secondary-button" onClick={props.onClose}>
              Cancel
            </button>
            <button className="node-library-danger-button" onClick={props.onDeleteConfirm} disabled={props.busy}>
              {props.busy ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (props.mode === "share") {
    return (
      <div className="node-library-modal-backdrop" onClick={props.onClose}>
        <div className="node-library-modal" onClick={(event) => event.stopPropagation()}>
          <div className="node-library-section-header">
            <div>
              <h2>{title}</h2>
              <p>Share this template with other engineers while keeping ownership and immutable step identifiers.</p>
            </div>
          </div>
          {props.error ? <div className="node-library-inline-error">{props.error}</div> : null}
          <div className="node-library-share-row">
            <input
              value={props.shareUsername}
              onChange={(event) => props.onShareUsernameChange(event.target.value)}
              placeholder="username"
            />
            <button className="node-library-primary-button" onClick={props.onShareSubmit} disabled={props.busy || !props.shareUsername.trim()}>
              {props.busy ? "Sharing..." : "Share"}
            </button>
          </div>
          <div className="node-library-share-list">
            {props.editor.sharedWithUsers.length === 0 ? (
              <div className="node-library-empty">No shared users yet.</div>
            ) : (
              props.editor.sharedWithUsers.map((username) => (
                <div key={username} className="node-library-share-chip">
                  <span>{username}</span>
                  <button onClick={() => props.onShareRemove(username)} disabled={props.busy}>
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="node-library-modal-actions">
            <button className="node-library-secondary-button" onClick={props.onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="node-library-modal-backdrop" onClick={props.onClose}>
      <div className="node-library-modal node-library-modal-wide" onClick={(event) => event.stopPropagation()}>
        <div className="node-library-section-header">
          <div>
            <h2>{title}</h2>
            <p>Switch between structured form mode and strict JSON mode. Step IDs stay unique and auto-generated.</p>
          </div>
          <div className="node-library-toggle-row">
            <button
              className={props.viewMode === "form" ? "active" : ""}
              type="button"
              onClick={() => props.onToggleViewMode("form")}
            >
              Form
            </button>
            <button
              className={props.viewMode === "json" ? "active" : ""}
              type="button"
              onClick={() => props.onToggleViewMode("json")}
            >
              JSON
            </button>
          </div>
        </div>

        {props.error ? <div className="node-library-inline-error">{props.error}</div> : null}

        {props.viewMode === "json" ? (
          <div className="node-library-json-editor">
            <textarea
              rows={28}
              value={jsonDraft}
              disabled={readOnly}
              onChange={(event) => setJsonDraft(event.target.value)}
              onBlur={() => {
                if (readOnly) return;
                try {
                  props.onEditorChange(editorFromJson(jsonDraft, props.editor));
                  setJsonError("");
                } catch (error) {
                  setJsonError(error instanceof Error ? error.message : "Invalid JSON");
                }
              }}
              spellCheck={false}
            />
            {jsonError ? <div className="node-library-inline-error">{jsonError}</div> : null}
          </div>
        ) : (
          <div className="node-library-modal-body">
            <div className="node-library-form-grid">
              <label>
                Name
                <input
                  value={props.editor.name}
                  disabled={readOnly}
                  onChange={(event) => props.onEditorChange({ ...props.editor, name: event.target.value })}
                />
              </label>
              <label>
                Category
                <input
                  value={props.editor.category}
                  disabled={readOnly}
                  onChange={(event) => props.onEditorChange({ ...props.editor, category: event.target.value })}
                />
              </label>
              <label>
                Node Type
                <select
                  value={props.editor.nodeType}
                  disabled={readOnly}
                  onChange={(event) => props.onEditorChange({ ...props.editor, nodeType: event.target.value as WorkflowNodeType })}
                >
                  <option value="TRIGGER">TRIGGER</option>
                  <option value="CONDITION">CONDITION</option>
                  <option value="ACTION">ACTION</option>
                  <option value="APPROVAL">APPROVAL</option>
                </select>
              </label>
              <label>
                Tags
                <input
                  value={props.editor.tags}
                  disabled={readOnly}
                  onChange={(event) => props.onEditorChange({ ...props.editor, tags: event.target.value })}
                />
              </label>
              <label className="node-library-form-span-2">
                Description
                <textarea
                  rows={3}
                  value={props.editor.description}
                  disabled={readOnly}
                  onChange={(event) => props.onEditorChange({ ...props.editor, description: event.target.value })}
                />
              </label>
            </div>

            <section className="node-library-step-card">
              <div className="node-library-section-header">
                <div>
                  <h3>Node Defaults</h3>
                  <p>These defaults apply to the node template before users insert it into a workflow.</p>
                </div>
              </div>
              <div className="node-library-form-grid">
                <label>
                  Config Type
                  <input
                    value={props.editor.configType}
                    disabled={readOnly}
                    onChange={(event) => props.onEditorChange({ ...props.editor, configType: event.target.value })}
                  />
                </label>
                <label>
                  Failure Policy
                  <select
                    value={props.editor.failurePolicy}
                    disabled={readOnly}
                    onChange={(event) => props.onEditorChange({ ...props.editor, failurePolicy: event.target.value as FailurePolicy })}
                  >
                    <option value="RETRY">RETRY</option>
                    <option value="CONTINUE">CONTINUE</option>
                    <option value="ROLLBACK">ROLLBACK</option>
                  </select>
                </label>
                <label>
                  Integration Profile ID
                  <input
                    value={props.editor.integrationProfileId}
                    disabled={readOnly}
                    onChange={(event) => props.onEditorChange({ ...props.editor, integrationProfileId: event.target.value })}
                  />
                </label>
                <label>
                  Environment ID
                  <input
                    value={props.editor.environmentId}
                    disabled={readOnly}
                    onChange={(event) => props.onEditorChange({ ...props.editor, environmentId: event.target.value })}
                  />
                </label>
                <label>
                  Approval Mode
                  <select
                    value={props.editor.approvalMode}
                    disabled={readOnly}
                    onChange={(event) => props.onEditorChange({ ...props.editor, approvalMode: event.target.value as ApprovalMode })}
                  >
                    <option value="NONE">NONE</option>
                    <option value="MANUAL">MANUAL</option>
                    <option value="AUTO_WITH_TIMEOUT">AUTO_WITH_TIMEOUT</option>
                  </select>
                </label>
                <label>
                  Approval Timeout (seconds)
                  <input
                    type="number"
                    min={1}
                    value={props.editor.approvalTimeoutSec}
                    disabled={readOnly || props.editor.approvalMode !== "AUTO_WITH_TIMEOUT"}
                    onChange={(event) => props.onEditorChange({ ...props.editor, approvalTimeoutSec: Math.max(1, Number(event.target.value || 300)) })}
                  />
                </label>
                <label>
                  Auto Decision
                  <select
                    value={props.editor.autoDecision}
                    disabled={readOnly || props.editor.approvalMode !== "AUTO_WITH_TIMEOUT"}
                    onChange={(event) => props.onEditorChange({ ...props.editor, autoDecision: event.target.value as AutoDecision })}
                  >
                    <option value="APPROVE">APPROVE</option>
                    <option value="REJECT">REJECT</option>
                  </select>
                </label>
                <label className="node-library-form-span-2">
                  Metadata JSON
                  <textarea
                    rows={6}
                    value={props.editor.metadataText}
                    disabled={readOnly}
                    onChange={(event) => props.onEditorChange({ ...props.editor, metadataText: event.target.value })}
                    spellCheck={false}
                  />
                </label>
              </div>
            </section>

            <section className="node-library-step-section">
              <div className="node-library-section-header">
                <div>
                  <h3>Commands / Steps</h3>
                  <p>Form mode supports multiple commands by adding multiple steps to the template.</p>
                </div>
                {!readOnly ? (
                  <button
                    type="button"
                    className="node-library-primary-button"
                    onClick={() =>
                      props.onEditorChange({
                        ...props.editor,
                        steps: [...props.editor.steps, createDefaultStep(props.editor.steps.length, props.editor.nodeType)]
                      })
                    }
                  >
                    Add Command
                  </button>
                ) : null}
              </div>
              <div className="node-library-step-list">
                {props.editor.steps.map((step, index) => (
                  <StepFormCard
                    key={step.id}
                    step={step}
                    index={index}
                    nodeType={props.editor.nodeType}
                    readOnly={readOnly}
                    onChange={(nextStep) =>
                      props.onEditorChange({
                        ...props.editor,
                        steps: props.editor.steps.map((currentStep) => (currentStep.id === step.id ? nextStep : currentStep))
                      })
                    }
                    onRemove={() =>
                      props.onEditorChange({
                        ...props.editor,
                        steps:
                          props.editor.steps.length > 1
                            ? props.editor.steps.filter((currentStep) => currentStep.id !== step.id)
                            : props.editor.steps
                      })
                    }
                  />
                ))}
              </div>
            </section>
          </div>
        )}

        <div className="node-library-modal-actions">
          <button className="node-library-secondary-button" onClick={props.onClose}>
            Close
          </button>
          {!readOnly ? (
            <button className="node-library-primary-button" onClick={props.onSubmit} disabled={props.busy}>
              {props.busy ? "Saving..." : props.mode === "create" ? "Create Template" : "Save Changes"}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function NodeLibraryPanel(): ReactElement {
  const [templates, setTemplates] = useState<NodeTemplateSummary[]>([]);
  const [scope, setScope] = useState<ScopeFilter>("all");
  const [loading, setLoading] = useState<boolean>(true);
  const [busy, setBusy] = useState<boolean>(false);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [modalMode, setModalMode] = useState<ModalMode | null>(null);
  const [viewMode, setViewMode] = useState<EditorViewMode>("form");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [editor, setEditor] = useState<NodeTemplateEditorState>(createDefaultEditor());
  const [shareUsername, setShareUsername] = useState<string>("");

  const selectedSummary = useMemo(
    () => templates.find((template) => template.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId]
  );

  async function loadTemplates(nextScope = scope): Promise<void> {
    setLoading(true);
    try {
      const payload = await requestJson<NodeTemplateSummary[]>(`/node-templates?scope=${encodeURIComponent(nextScope)}`, "GET");
      setTemplates(payload);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load node templates");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadTemplates(scope);
  }, [scope]);

  async function openModal(mode: ModalMode, templateId?: string): Promise<void> {
    setError("");
    setStatus("");
    setViewMode("form");
    setShareUsername("");

    if (!templateId) {
      setSelectedTemplateId("");
      setEditor(createDefaultEditor());
      setModalMode(mode);
      return;
    }

    setBusy(true);
    try {
      const payload = await requestJson<NodeTemplateRecord>(`/node-templates/${templateId}`, "GET");
      setSelectedTemplateId(templateId);
      setEditor(editorFromRecord(payload));
      setModalMode(mode);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load template details");
    } finally {
      setBusy(false);
    }
  }

  function closeModal(): void {
    setModalMode(null);
    setShareUsername("");
    setError("");
  }

  async function saveTemplate(): Promise<void> {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const payload = {
        name: editor.name.trim(),
        description: editor.description.trim() || undefined,
        category: editor.category.trim() || undefined,
        tags: editor.tags
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean),
        config: editorToConfig(editor),
        metadata: JSON.parse(editor.metadataText || "{}")
      };
      const record = editor.id
        ? await requestJson<NodeTemplateRecord>(`/node-templates/${editor.id}`, "PATCH", payload)
        : await requestJson<NodeTemplateRecord>("/node-templates", "POST", payload);
      await loadTemplates(scope);
      setSelectedTemplateId(record.id);
      setEditor(editorFromRecord(record));
      setModalMode(null);
      setStatus(editor.id ? "Template updated." : "Template created.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Failed to save template");
    } finally {
      setBusy(false);
    }
  }

  async function deleteTemplate(): Promise<void> {
    if (!editor.id) return;
    setBusy(true);
    setError("");
    setStatus("");
    try {
      await requestJson<{ deleted: boolean }>(`/node-templates/${editor.id}`, "DELETE");
      await loadTemplates(scope);
      setModalMode(null);
      setSelectedTemplateId("");
      setEditor(createDefaultEditor());
      setStatus("Template deleted.");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete template");
    } finally {
      setBusy(false);
    }
  }

  async function duplicateTemplate(templateId: string): Promise<void> {
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const record = await requestJson<NodeTemplateRecord>(`/node-templates/${templateId}/duplicate`, "POST", {});
      await loadTemplates(scope);
      setStatus("Template duplicated.");
      setSelectedTemplateId(record.id);
    } catch (duplicateError) {
      setError(duplicateError instanceof Error ? duplicateError.message : "Failed to duplicate template");
    } finally {
      setBusy(false);
    }
  }

  async function exportTemplate(templateId: string): Promise<void> {
    setBusy(true);
    setError("");
    try {
      const payload = await requestJson<Record<string, unknown>>(`/node-templates/${templateId}/export`, "GET");
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${selectedSummary?.name?.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "node-template"}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus("Template JSON exported.");
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : "Failed to export template JSON");
    } finally {
      setBusy(false);
    }
  }

  async function shareTemplate(): Promise<void> {
    if (!editor.id || !shareUsername.trim()) return;
    setBusy(true);
    setError("");
    try {
      const record = await requestJson<NodeTemplateRecord>(`/node-templates/${editor.id}/share`, "POST", {
        username: shareUsername.trim()
      });
      setEditor(editorFromRecord(record));
      setShareUsername("");
      await loadTemplates(scope);
      setStatus("Template shared.");
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : "Failed to share template");
    } finally {
      setBusy(false);
    }
  }

  async function unshareTemplate(username: string): Promise<void> {
    if (!editor.id) return;
    setBusy(true);
    setError("");
    try {
      const record = await requestJson<NodeTemplateRecord>(`/node-templates/${editor.id}/share/${encodeURIComponent(username)}`, "DELETE");
      setEditor(editorFromRecord(record));
      await loadTemplates(scope);
      setStatus("Shared access removed.");
    } catch (shareError) {
      setError(shareError instanceof Error ? shareError.message : "Failed to update sharing");
    } finally {
      setBusy(false);
    }
  }

  async function importTemplate(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const raw = await file.text();
      const payload = JSON.parse(raw) as Record<string, unknown>;
      const record = await requestJson<NodeTemplateRecord>("/node-templates/import", "POST", payload);
      await loadTemplates(scope);
      setSelectedTemplateId(record.id);
      setStatus("Template imported.");
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Failed to import template JSON");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthGate>
      <main className="app-shell">
        <NavigationSidebar />
        <section className="workspace">
          <section className="node-library-page">
            <header className="node-library-header">
              <div>
                <p className="node-library-eyebrow">Reusable Workflow Authoring</p>
                <h1>Node Library</h1>
                <p className="node-library-subtitle">
                  Manage reusable node templates with list-first operations, popup-based editing, form and JSON modes, immutable step IDs,
                  configurable timeouts, and multiple success conditions.
                </p>
              </div>
              <div className="node-library-header-note">
                <strong>Template safety defaults</strong>
                <span>Step IDs are auto-generated and read-only, detailed logging stays off by default, and users can define request plus expected-response checks per command.</span>
              </div>
            </header>

            <section className="node-library-shell">
              <div className="node-library-toolbar">
                <div className="node-library-scope-row">
                  <button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>
                    All
                  </button>
                  <button className={scope === "mine" ? "active" : ""} onClick={() => setScope("mine")}>
                    Mine
                  </button>
                  <button className={scope === "shared" ? "active" : ""} onClick={() => setScope("shared")}>
                    Shared
                  </button>
                </div>
                <div className="node-library-toolbar">
                  <label className="node-library-secondary-button node-library-file-button">
                    Import JSON
                    <input type="file" accept="application/json,.json" onChange={(event) => void importTemplate(event)} />
                  </label>
                  <button className="node-library-secondary-button" onClick={() => void (selectedTemplateId ? exportTemplate(selectedTemplateId) : Promise.resolve())} disabled={!selectedTemplateId || busy}>
                    Export JSON
                  </button>
                  <button className="node-library-primary-button" onClick={() => void openModal("create")} disabled={busy}>
                    Create Template
                  </button>
                </div>
              </div>

              {status ? <div className="node-library-inline-ok">{status}</div> : null}
              {error && !modalMode ? <div className="node-library-inline-error">{error}</div> : null}

              <div className="node-library-table-wrap">
                <table className="node-library-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Category</th>
                      <th>Node Type</th>
                      <th>Owner</th>
                      <th>Description</th>
                      <th>Access</th>
                      <th>Updated</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td colSpan={8}>
                          <div className="node-library-empty">Loading templates...</div>
                        </td>
                      </tr>
                    ) : templates.length === 0 ? (
                      <tr>
                        <td colSpan={8}>
                          <div className="node-library-empty">No node templates configured yet for this scope.</div>
                        </td>
                      </tr>
                    ) : (
                      templates.map((template) => (
                        <tr key={template.id}>
                          <td><strong>{template.name}</strong></td>
                          <td>{template.category || "-"}</td>
                          <td>{template.nodeType}</td>
                          <td>{template.ownerId}</td>
                          <td>{template.description || "No description provided."}</td>
                          <td>{template.access}</td>
                          <td>{formatDate(template.updatedAt)}</td>
                          <td>
                            <div className="node-library-row-actions">
                              <button onClick={() => void openModal("view", template.id)} disabled={busy}>View</button>
                              <button onClick={() => void openModal("update", template.id)} disabled={busy}>Update</button>
                              <button onClick={() => void duplicateTemplate(template.id)} disabled={busy}>Duplicate</button>
                              <button onClick={() => void openModal("share", template.id)} disabled={busy}>Share</button>
                              <button onClick={() => void openModal("delete", template.id)} disabled={busy}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            {modalMode ? (
              <EditorModal
                mode={modalMode}
                viewMode={viewMode}
                editor={editor}
                shareUsername={shareUsername}
                busy={busy}
                error={error}
                onClose={closeModal}
                onToggleViewMode={setViewMode}
                onEditorChange={setEditor}
                onShareUsernameChange={setShareUsername}
                onSubmit={() => void saveTemplate()}
                onDeleteConfirm={() => void deleteTemplate()}
                onShareSubmit={() => void shareTemplate()}
                onShareRemove={(username) => void unshareTemplate(username)}
              />
            ) : null}
          </section>
        </section>
      </main>
    </AuthGate>
  );
}
