"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { Panel, StatusBadge } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";

type ScopeMode = "owned" | "shared" | "all";
type ExecutionType = "REST" | "SSH" | "NETCONF" | "SCRIPT";
type AuthType = "NO_AUTH" | "OAUTH2" | "BASIC" | "MTLS" | "API_KEY" | "OIDC" | "JWT";
type LifecycleState = "ACTIVE" | "INACTIVE" | "TERMINATED";
type AccessMode = "OWNER" | "SHARED" | "ADMIN";
type RestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type ApiKeyLocation = "header" | "query";
type OAuthGrantType = "client_credentials" | "password";
type OAuthClientAuthMethod = "body" | "basic";

interface IntegrationRecord {
  id: string;
  name: string;
  ownerId: string;
  executionType: ExecutionType;
  authType: AuthType;
  lifecycleState: LifecycleState;
  isActive: boolean;
  baseConfigJson?: Record<string, unknown>;
  credentialJson?: Record<string, unknown>;
  access: AccessMode;
  sharedWithUsers?: string[];
  updatedAt: string;
}

interface UserEnvironmentRecord {
  id: string;
  name: string;
  ownerId: string;
  variablesJson?: Record<string, unknown>;
  isDefault: boolean;
  access: AccessMode;
  sharedWithUsers?: string[];
  updatedAt: string;
}

interface IntegrationUsage {
  workflowId: string;
  workflowName: string;
  workflowVersionId: string;
  version: number;
  status: string;
}

type TabMode = "integrations" | "environments";
type EnvEditorMode = "json" | "table";

interface EnvVariableRow {
  key: string;
  value: string;
  enabled: boolean;
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function toText(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function normalizeAuthType(value: unknown): AuthType {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  if (normalized === "NO_AUTH" || normalized === "OAUTH2" || normalized === "BASIC" || normalized === "API_KEY" || normalized === "MTLS" || normalized === "OIDC" || normalized === "JWT") {
    return normalized;
  }
  return "NO_AUTH";
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value ?? {}, null, 2);
}

function formatTs(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function objectToEnvRows(value: unknown): EnvVariableRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>).map(([key, raw]) => ({
    key,
    value: raw === undefined || raw === null ? "" : String(raw),
    enabled: true
  }));
}

function envRowsToObject(rows: EnvVariableRow[]): Record<string, string> {
  const output: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key || !row.enabled) continue;
    output[key] = row.value;
  }
  return output;
}

function parsePostmanEnvironment(input: unknown): { name?: string; variables: Record<string, string> } {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid Postman environment file");
  }
  const payload = input as Record<string, unknown>;
  const name = typeof payload.name === "string" ? payload.name : undefined;
  if (Array.isArray(payload.values)) {
    const rows = payload.values
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => entry as Record<string, unknown>)
      .map((entry) => ({
        key: String(entry.key ?? "").trim(),
        value: String(entry.value ?? ""),
        enabled: entry.enabled !== false
      }))
      .filter((entry) => entry.key.length > 0);
    return { name, variables: envRowsToObject(rows) };
  }
  if (payload.values && typeof payload.values === "object" && !Array.isArray(payload.values)) {
    return { name, variables: Object.fromEntries(Object.entries(payload.values as Record<string, unknown>).map(([key, value]) => [key, String(value ?? "")])) };
  }
  return { name, variables: Object.fromEntries(Object.entries(payload).filter(([key]) => !key.startsWith("_")).map(([key, value]) => [key, String(value ?? "")])) };
}

async function requestJson<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const auth = authHeaderFromStoredToken();
  if (auth) headers.authorization = auth;
  if (body !== undefined) headers["content-type"] = "application/json";

  const response = await fetch(`${resolveApiBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const raw = await response.text();
  const payload = raw.length > 0 ? JSON.parse(raw) : {};
  if (!response.ok) {
    throw new Error((payload?.warning as string | undefined) ?? (payload?.error as string | undefined) ?? `Request failed ${response.status}`);
  }
  return payload as T;
}

export function IntegrationsManager(): ReactElement {
  const [tab, setTab] = useState<TabMode>("integrations");
  const [identity, setIdentity] = useState<{ userId: string; roles: string[] } | null>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  const [integrationScope, setIntegrationScope] = useState<ScopeMode>("all");
  const [integrationRows, setIntegrationRows] = useState<IntegrationRecord[]>([]);
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string>("");
  const [integrationName, setIntegrationName] = useState<string>("Node Integration");
  const [integrationExecutionType, setIntegrationExecutionType] = useState<ExecutionType>("REST");
  const [integrationAuthType, setIntegrationAuthType] = useState<AuthType>("NO_AUTH");
  const [integrationBaseUrl, setIntegrationBaseUrl] = useState<string>("https://postman-echo.com");
  const [integrationMethod, setIntegrationMethod] = useState<RestMethod>("GET");
  const [integrationHealthPath, setIntegrationHealthPath] = useState<string>("");
  const [basicUsername, setBasicUsername] = useState<string>("");
  const [basicPassword, setBasicPassword] = useState<string>("");
  const [apiKeyName, setApiKeyName] = useState<string>("x-api-key");
  const [apiKeyValue, setApiKeyValue] = useState<string>("");
  const [apiKeyLocation, setApiKeyLocation] = useState<ApiKeyLocation>("header");
  const [oauthGrantType, setOauthGrantType] = useState<OAuthGrantType>("client_credentials");
  const [oauthTokenUrl, setOauthTokenUrl] = useState<string>("");
  const [oauthClientId, setOauthClientId] = useState<string>("");
  const [oauthClientSecret, setOauthClientSecret] = useState<string>("");
  const [oauthScope, setOauthScope] = useState<string>("");
  const [oauthUsername, setOauthUsername] = useState<string>("");
  const [oauthPassword, setOauthPassword] = useState<string>("");
  const [oauthClientAuthMethod, setOauthClientAuthMethod] = useState<OAuthClientAuthMethod>("body");
  const [legacyBearerToken, setLegacyBearerToken] = useState<string>("");
  const [mtlsCert, setMtlsCert] = useState<string>("");
  const [mtlsKey, setMtlsKey] = useState<string>("");
  const [mtlsCa, setMtlsCa] = useState<string>("");
  const [integrationShareUsername, setIntegrationShareUsername] = useState<string>("");
  const [integrationTestEnvironmentId, setIntegrationTestEnvironmentId] = useState<string>("");
  const [integrationUsageWarning, setIntegrationUsageWarning] = useState<IntegrationUsage[]>([]);

  const [environmentScope, setEnvironmentScope] = useState<ScopeMode>("all");
  const [environmentRows, setEnvironmentRows] = useState<UserEnvironmentRecord[]>([]);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>("");
  const [environmentName, setEnvironmentName] = useState<string>("default");
  const [environmentEditorMode, setEnvironmentEditorMode] = useState<EnvEditorMode>("json");
  const [environmentJson, setEnvironmentJson] = useState<string>('{\n  "API_TOKEN": "replace-me"\n}');
  const [environmentRowsEditor, setEnvironmentRowsEditor] = useState<EnvVariableRow[]>([{ key: "", value: "", enabled: true }]);
  const [environmentShareUsername, setEnvironmentShareUsername] = useState<string>("");

  const selectedIntegration = integrationRows.find((entry) => entry.id === selectedIntegrationId) ?? null;
  const selectedEnvironment = environmentRows.find((entry) => entry.id === selectedEnvironmentId) ?? null;

  const canManageSelectedIntegration = selectedIntegration?.access === "OWNER" || selectedIntegration?.access === "ADMIN";
  const canManageSelectedEnvironment = selectedEnvironment?.access === "OWNER" || selectedEnvironment?.access === "ADMIN";

  useEffect(() => {
    fetchIdentity()
      .then((entry) => setIdentity(entry))
      .catch(() => setIdentity(null));
  }, []);

  async function refreshData(): Promise<void> {
    const [integrations, environments] = await Promise.all([
      requestJson<IntegrationRecord[]>(`/integrations?scope=${integrationScope}&limit=200`, "GET"),
      requestJson<UserEnvironmentRecord[]>(`/environments?scope=${environmentScope}&limit=200`, "GET")
    ]);
    setIntegrationRows(integrations);
    setEnvironmentRows(environments);
    if (!selectedIntegrationId && integrations[0]?.id) setSelectedIntegrationId(integrations[0].id);
    if (!selectedEnvironmentId && environments[0]?.id) setSelectedEnvironmentId(environments[0].id);
  }

  useEffect(() => {
    refreshData().catch((loadError) => {
      setError(loadError instanceof Error ? loadError.message : "Failed to load integrations/environments");
    });
    const timer = window.setInterval(() => {
      refreshData().catch(() => undefined);
    }, 10000);
    return () => window.clearInterval(timer);
  }, [integrationScope, environmentScope, selectedEnvironmentId, selectedIntegrationId]);

  useEffect(() => {
    if (!selectedIntegration) return;
    const baseConfig = toObject(selectedIntegration.baseConfigJson);
    const credentials = toObject(selectedIntegration.credentialJson);

    setIntegrationName(selectedIntegration.name);
    setIntegrationExecutionType(selectedIntegration.executionType);
    setIntegrationAuthType(normalizeAuthType(selectedIntegration.authType));
    setIntegrationBaseUrl(toText(baseConfig.baseUrl, ""));
    setIntegrationMethod((toText(baseConfig.method, "GET").toUpperCase() as RestMethod) || "GET");
    setIntegrationHealthPath(toText(baseConfig.healthPath, toText(baseConfig.path, "")));

    setBasicUsername(toText(credentials.username, ""));
    setBasicPassword(toText(credentials.password, ""));
    setApiKeyName(toText(credentials.key, toText(credentials.headerName, "x-api-key")));
    setApiKeyValue(toText(credentials.value, toText(credentials.apiKey, "")));
    setApiKeyLocation(toText(credentials.addTo, toText(credentials.in, "header")).toLowerCase() === "query" ? "query" : "header");
    setOauthGrantType(toText(credentials.grantType, "client_credentials").toLowerCase() === "password" ? "password" : "client_credentials");
    setOauthTokenUrl(toText(credentials.tokenUrl, toText(credentials.accessTokenUrl, "")));
    setOauthClientId(toText(credentials.clientId, ""));
    setOauthClientSecret(toText(credentials.clientSecret, ""));
    setOauthScope(toText(credentials.scope, ""));
    setOauthUsername(toText(credentials.username, ""));
    setOauthPassword(toText(credentials.password, ""));
    setOauthClientAuthMethod(toText(credentials.clientAuthMethod, "body").toLowerCase() === "basic" ? "basic" : "body");
    setLegacyBearerToken(
      toText(
        credentials.accessToken,
        toText(credentials.token, toText(credentials.bearerToken, toText(credentials.idToken, toText(credentials.jwt, ""))))
      )
    );
    setMtlsCert(toText(credentials.cert, toText(credentials.clientCert, toText(credentials.certificate, ""))));
    setMtlsKey(toText(credentials.key, toText(credentials.privateKey, toText(credentials.keyPem, ""))));
    setMtlsCa(toText(credentials.ca, ""));
  }, [selectedIntegrationId, selectedIntegration]);

  useEffect(() => {
    if (!selectedEnvironment) return;
    setEnvironmentName(selectedEnvironment.name);
    const rows = objectToEnvRows(selectedEnvironment.variablesJson ?? {});
    setEnvironmentRowsEditor(rows.length > 0 ? rows : [{ key: "", value: "", enabled: true }]);
    setEnvironmentJson(prettyJson(selectedEnvironment.variablesJson ?? {}));
  }, [selectedEnvironmentId]);

  const authTypes = useMemo<AuthType[]>(() => ["NO_AUTH", "BASIC", "API_KEY", "OAUTH2", "OIDC", "JWT", "MTLS"], []);

  function buildIntegrationPayload(): { baseConfig: Record<string, unknown>; credentials: Record<string, unknown> } {
    const baseConfig: Record<string, unknown> = {
      baseUrl: integrationBaseUrl.trim(),
      method: integrationMethod,
      healthPath: integrationHealthPath.trim() || undefined
    };

    if (integrationAuthType === "NO_AUTH") {
      return { baseConfig, credentials: {} };
    }
    if (integrationAuthType === "BASIC") {
      return {
        baseConfig,
        credentials: {
          username: basicUsername.trim(),
          password: basicPassword
        }
      };
    }
    if (integrationAuthType === "API_KEY") {
      return {
        baseConfig,
        credentials: {
          key: apiKeyName.trim(),
          value: apiKeyValue,
          addTo: apiKeyLocation
        }
      };
    }
    if (integrationAuthType === "OAUTH2") {
      return {
        baseConfig,
        credentials: {
          grantType: oauthGrantType,
          tokenUrl: oauthTokenUrl.trim(),
          clientId: oauthClientId.trim(),
          clientSecret: oauthClientSecret,
          scope: oauthScope.trim() || undefined,
          username: oauthGrantType === "password" ? oauthUsername.trim() : undefined,
          password: oauthGrantType === "password" ? oauthPassword : undefined,
          clientAuthMethod: oauthClientAuthMethod
        }
      };
    }
    if (integrationAuthType === "OIDC" || integrationAuthType === "JWT") {
      return {
        baseConfig,
        credentials: {
          accessToken: legacyBearerToken.trim()
        }
      };
    }
    return {
      baseConfig,
      credentials: {
        cert: mtlsCert,
        key: mtlsKey,
        ca: mtlsCa
      }
    };
  }

  async function createIntegration(): Promise<void> {
    setError("");
    setStatus("Creating node integration...");
    try {
      const { baseConfig, credentials } = buildIntegrationPayload();
      const payload = await requestJson<IntegrationRecord>("/integrations", "POST", {
        name: integrationName.trim(),
        executionType: integrationExecutionType,
        authType: integrationAuthType,
        baseConfig,
        credentials
      });
      setSelectedIntegrationId(payload.id);
      setStatus("Node integration created.");
      await refreshData();
    } catch (createError) {
      setStatus("");
      setError(createError instanceof Error ? createError.message : "Failed to create integration");
    }
  }

  async function updateIntegration(): Promise<void> {
    if (!selectedIntegration) return;
    setError("");
    setStatus("Saving integration changes...");
    try {
      const { baseConfig, credentials } = buildIntegrationPayload();
      await requestJson(`/integrations/${selectedIntegration.id}`, "PATCH", {
        name: integrationName.trim(),
        executionType: integrationExecutionType,
        authType: integrationAuthType,
        baseConfig,
        credentials
      });
      setStatus("Integration updated.");
      await refreshData();
    } catch (updateError) {
      setStatus("");
      setError(updateError instanceof Error ? updateError.message : "Failed to update integration");
    }
  }

  async function shareIntegration(): Promise<void> {
    if (!selectedIntegration || !integrationShareUsername.trim()) return;
    setError("");
    setStatus("Sharing integration...");
    try {
      await requestJson(`/integrations/${selectedIntegration.id}/share`, "POST", {
        username: integrationShareUsername.trim()
      });
      setIntegrationShareUsername("");
      setStatus("Integration shared.");
      await refreshData();
    } catch (shareError) {
      setStatus("");
      setError(shareError instanceof Error ? shareError.message : "Failed to share integration");
    }
  }

  async function duplicateIntegration(): Promise<void> {
    if (!selectedIntegration) return;
    setError("");
    setStatus("Duplicating integration...");
    try {
      const created = await requestJson<IntegrationRecord>(`/integrations/${selectedIntegration.id}/duplicate`, "POST", {
        name: `${selectedIntegration.name} Copy`
      });
      setSelectedIntegrationId(created.id);
      setStatus("Integration duplicated to your ownership.");
      await refreshData();
    } catch (duplicateError) {
      setStatus("");
      setError(duplicateError instanceof Error ? duplicateError.message : "Failed to duplicate integration");
    }
  }

  async function testIntegration(): Promise<void> {
    if (!selectedIntegration) return;
    setError("");
    setStatus("Testing integration authentication...");
    try {
      const result = await requestJson<{ ok: boolean; result?: Record<string, unknown> }>(`/integrations/${selectedIntegration.id}/test`, "POST", {
        environmentId: integrationTestEnvironmentId || undefined
      });
      setStatus(result.ok ? "Integration authentication test passed." : "Integration authentication test failed.");
    } catch (testError) {
      setStatus("");
      setError(testError instanceof Error ? testError.message : "Integration test failed");
    }
  }

  async function updateLifecycle(target: "activate" | "deactivate" | "delete"): Promise<void> {
    if (!selectedIntegration) return;
    setError("");
    setIntegrationUsageWarning([]);
    setStatus(target === "activate" ? "Activating integration..." : target === "deactivate" ? "Deactivating integration..." : "Terminating integration...");
    try {
      if (target === "activate") {
        await requestJson(`/integrations/${selectedIntegration.id}/activate`, "POST");
      } else if (target === "deactivate") {
        await requestJson(`/integrations/${selectedIntegration.id}/deactivate`, "POST");
      } else {
        await requestJson(`/integrations/${selectedIntegration.id}`, "DELETE");
      }
      setStatus(`Integration ${target === "delete" ? "terminated" : `${target}d`} successfully.`);
      if (target === "delete") setSelectedIntegrationId("");
      await refreshData();
    } catch (lcmError: any) {
      setStatus("");
      const message = lcmError instanceof Error ? lcmError.message : "Integration lifecycle action failed";
      setError(message);
      try {
        const usage = await requestJson<{ workflows: IntegrationUsage[] }>(`/integrations/${selectedIntegration.id}/usage`, "GET");
        setIntegrationUsageWarning(usage.workflows ?? []);
      } catch {
        return;
      }
    }
  }

  async function createEnvironment(): Promise<void> {
    setError("");
    setStatus("Creating environment...");
    try {
      const variables =
        environmentEditorMode === "json" ? (JSON.parse(environmentJson) as Record<string, unknown>) : envRowsToObject(environmentRowsEditor);
      const created = await requestJson<UserEnvironmentRecord>("/environments", "POST", {
        name: environmentName.trim(),
        variables,
        isDefault: false
      });
      setSelectedEnvironmentId(created.id);
      setStatus("Environment created.");
      await refreshData();
    } catch (createError) {
      setStatus("");
      setError(createError instanceof Error ? createError.message : "Failed to create environment");
    }
  }

  async function updateEnvironment(): Promise<void> {
    if (!selectedEnvironment) return;
    setError("");
    setStatus("Saving environment changes...");
    try {
      const variables =
        environmentEditorMode === "json" ? (JSON.parse(environmentJson) as Record<string, unknown>) : envRowsToObject(environmentRowsEditor);
      await requestJson(`/environments/${selectedEnvironment.id}`, "PATCH", {
        name: environmentName.trim(),
        variables
      });
      setStatus("Environment updated.");
      await refreshData();
    } catch (updateError) {
      setStatus("");
      setError(updateError instanceof Error ? updateError.message : "Failed to update environment");
    }
  }

  async function shareEnvironment(): Promise<void> {
    if (!selectedEnvironment || !environmentShareUsername.trim()) return;
    setError("");
    setStatus("Sharing environment...");
    try {
      await requestJson(`/environments/${selectedEnvironment.id}/share`, "POST", {
        username: environmentShareUsername.trim()
      });
      setEnvironmentShareUsername("");
      setStatus("Environment shared.");
      await refreshData();
    } catch (shareError) {
      setStatus("");
      setError(shareError instanceof Error ? shareError.message : "Failed to share environment");
    }
  }

  async function duplicateEnvironment(): Promise<void> {
    if (!selectedEnvironment) return;
    setError("");
    setStatus("Duplicating environment...");
    try {
      const created = await requestJson<UserEnvironmentRecord>(`/environments/${selectedEnvironment.id}/duplicate`, "POST", {
        name: `${selectedEnvironment.name} Copy`
      });
      setSelectedEnvironmentId(created.id);
      setStatus("Environment duplicated to your ownership.");
      await refreshData();
    } catch (duplicateError) {
      setStatus("");
      setError(duplicateError instanceof Error ? duplicateError.message : "Failed to duplicate environment");
    }
  }

  async function deleteEnvironment(): Promise<void> {
    if (!selectedEnvironment) return;
    setError("");
    setStatus("Deleting environment...");
    try {
      await requestJson(`/environments/${selectedEnvironment.id}`, "DELETE");
      setSelectedEnvironmentId("");
      setStatus("Environment deleted.");
      await refreshData();
    } catch (deleteError) {
      setStatus("");
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete environment");
    }
  }

  function addEnvironmentRow(): void {
    setEnvironmentRowsEditor((current) => [...current, { key: "", value: "", enabled: true }]);
  }

  function patchEnvironmentRow(index: number, patch: Partial<EnvVariableRow>): void {
    setEnvironmentRowsEditor((current) => current.map((entry, idx) => (idx === index ? { ...entry, ...patch } : entry)));
  }

  function removeEnvironmentRow(index: number): void {
    setEnvironmentRowsEditor((current) => {
      const next = current.filter((_, idx) => idx !== index);
      return next.length > 0 ? next : [{ key: "", value: "", enabled: true }];
    });
  }

  function switchEnvironmentEditorMode(nextMode: EnvEditorMode): void {
    if (nextMode === environmentEditorMode) return;
    if (nextMode === "table") {
      try {
        const parsed = JSON.parse(environmentJson) as Record<string, unknown>;
        const rows = objectToEnvRows(parsed);
        setEnvironmentRowsEditor(rows.length > 0 ? rows : [{ key: "", value: "", enabled: true }]);
      } catch {
        setError("Invalid JSON. Fix JSON before switching to Variable/Value mode.");
        return;
      }
    } else {
      setEnvironmentJson(prettyJson(envRowsToObject(environmentRowsEditor)));
    }
    setError("");
    setEnvironmentEditorMode(nextMode);
  }

  async function importPostmanEnvironment(file: File): Promise<void> {
    const text = await file.text();
    const parsed = JSON.parse(text) as unknown;
    const imported = parsePostmanEnvironment(parsed);
    if (imported.name) setEnvironmentName(imported.name);
    const rows = objectToEnvRows(imported.variables);
    setEnvironmentRowsEditor(rows.length > 0 ? rows : [{ key: "", value: "", enabled: true }]);
    setEnvironmentJson(prettyJson(imported.variables));
    setEnvironmentEditorMode("table");
    setStatus("Postman environment imported.");
    setError("");
  }

  return (
    <>
      <Panel title="External Integrations">
        <div className="integration-header">
          <div>
            <strong>User:</strong> {identity?.userId ?? "unknown"}
          </div>
          <div>
            <strong>Roles:</strong> {(identity?.roles ?? []).join(", ") || "viewer"}
          </div>
        </div>

        <div className="integration-tabs">
          <button type="button" className={tab === "integrations" ? "tab-active" : ""} onClick={() => setTab("integrations")}>
            Add Node Integration
          </button>
          <button type="button" className={tab === "environments" ? "tab-active" : ""} onClick={() => setTab("environments")}>
            Environment
          </button>
        </div>

        {tab === "integrations" ? (
          <>
            <div className="integration-scope-row">
              <span>View:</span>
              <button type="button" className={integrationScope === "owned" ? "chip-active" : ""} onClick={() => setIntegrationScope("owned")}>
                My Integrations
              </button>
              <button type="button" className={integrationScope === "shared" ? "chip-active" : ""} onClick={() => setIntegrationScope("shared")}>
                Shared With Me
              </button>
              <button type="button" className={integrationScope === "all" ? "chip-active" : ""} onClick={() => setIntegrationScope("all")}>
                One-Click All
              </button>
            </div>

            <div className="integration-layout">
              <section className="card">
                <h4>Node Integrations</h4>
                <div className="ops-table-wrap">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Auth</th>
                        <th>Type</th>
                        <th>Owner</th>
                        <th>Status</th>
                        <th>Access</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {integrationRows.length === 0 ? (
                        <tr>
                          <td colSpan={7}>No integrations for selected scope.</td>
                        </tr>
                      ) : (
                        integrationRows.map((entry) => (
                          <tr key={entry.id} className={selectedIntegrationId === entry.id ? "ops-row-selected" : ""} onClick={() => setSelectedIntegrationId(entry.id)}>
                            <td>{entry.name}</td>
                            <td>{entry.authType}</td>
                            <td>{entry.executionType}</td>
                            <td>{entry.ownerId}</td>
                            <td>
                              <StatusBadge status={entry.lifecycleState} />
                            </td>
                            <td>{entry.access}</td>
                            <td>{formatTs(entry.updatedAt)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card">
                <h4>Integration Configuration</h4>
                <div className="ops-form-row">
                  <label>Name</label>
                  <input value={integrationName} onChange={(event) => setIntegrationName(event.target.value)} />
                  <select value={integrationExecutionType} onChange={(event) => setIntegrationExecutionType(event.target.value as ExecutionType)}>
                    <option value="REST">REST</option>
                    <option value="SSH">SSH</option>
                    <option value="NETCONF">NETCONF</option>
                    <option value="SCRIPT">SCRIPT</option>
                  </select>
                  <select value={integrationAuthType} onChange={(event) => setIntegrationAuthType(event.target.value as AuthType)}>
                    {authTypes.map((authType) => (
                      <option key={authType} value={authType}>
                        {authType === "NO_AUTH"
                          ? "No Auth"
                          : authType === "API_KEY"
                          ? "API Key"
                          : authType === "BASIC"
                          ? "Basic Auth"
                          : authType === "OAUTH2"
                          ? "OAuth 2.0"
                          : authType}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="ops-form-row">
                  <label>Base URL</label>
                  <input value={integrationBaseUrl} onChange={(event) => setIntegrationBaseUrl(event.target.value)} placeholder="https://api.example.com" />
                  <select value={integrationMethod} onChange={(event) => setIntegrationMethod(event.target.value as RestMethod)}>
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                    <option value="PUT">PUT</option>
                    <option value="PATCH">PATCH</option>
                    <option value="DELETE">DELETE</option>
                  </select>
                  <input value={integrationHealthPath} onChange={(event) => setIntegrationHealthPath(event.target.value)} placeholder="/health (optional)" />
                </div>
                <section className="integration-auth-panel">
                  <h5>Authorization</h5>
                  {integrationAuthType === "NO_AUTH" ? (
                    <p className="ops-status-line">No Auth selected. Request is sent without authorization header.</p>
                  ) : null}
                  {integrationAuthType === "BASIC" ? (
                    <div className="integration-auth-grid">
                      <label>Username</label>
                      <input value={basicUsername} onChange={(event) => setBasicUsername(event.target.value)} placeholder="username" />
                      <label>Password</label>
                      <input type="password" value={basicPassword} onChange={(event) => setBasicPassword(event.target.value)} placeholder="password or env:VAR" />
                    </div>
                  ) : null}
                  {integrationAuthType === "API_KEY" ? (
                    <div className="integration-auth-grid">
                      <label>Key</label>
                      <input value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value)} placeholder="x-api-key" />
                      <label>Value</label>
                      <input value={apiKeyValue} onChange={(event) => setApiKeyValue(event.target.value)} placeholder="env:API_KEY or literal value" />
                      <label>Add To</label>
                      <select value={apiKeyLocation} onChange={(event) => setApiKeyLocation(event.target.value as ApiKeyLocation)}>
                        <option value="header">Header</option>
                        <option value="query">Query Param</option>
                      </select>
                    </div>
                  ) : null}
                  {integrationAuthType === "OAUTH2" ? (
                    <div className="integration-auth-grid">
                      <label>Grant Type</label>
                      <select value={oauthGrantType} onChange={(event) => setOauthGrantType(event.target.value as OAuthGrantType)}>
                        <option value="client_credentials">Client Credentials</option>
                        <option value="password">Password Credentials</option>
                      </select>
                      <label>Token URL</label>
                      <input value={oauthTokenUrl} onChange={(event) => setOauthTokenUrl(event.target.value)} placeholder="https://idp.example.com/oauth2/token" />
                      <label>Client ID</label>
                      <input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} placeholder="client id" />
                      <label>Client Secret</label>
                      <input type="password" value={oauthClientSecret} onChange={(event) => setOauthClientSecret(event.target.value)} placeholder="client secret or env:VAR" />
                      <label>Scope</label>
                      <input value={oauthScope} onChange={(event) => setOauthScope(event.target.value)} placeholder="scope1 scope2 (optional)" />
                      <label>Client Auth</label>
                      <select value={oauthClientAuthMethod} onChange={(event) => setOauthClientAuthMethod(event.target.value as OAuthClientAuthMethod)}>
                        <option value="body">Send in Body</option>
                        <option value="basic">Basic Auth Header</option>
                      </select>
                      {oauthGrantType === "password" ? (
                        <>
                          <label>Username</label>
                          <input value={oauthUsername} onChange={(event) => setOauthUsername(event.target.value)} placeholder="username" />
                          <label>Password</label>
                          <input type="password" value={oauthPassword} onChange={(event) => setOauthPassword(event.target.value)} placeholder="password or env:VAR" />
                        </>
                      ) : null}
                    </div>
                  ) : null}
                  {integrationAuthType === "OIDC" || integrationAuthType === "JWT" ? (
                    <div className="integration-auth-grid">
                      <label>Bearer Token</label>
                      <input value={legacyBearerToken} onChange={(event) => setLegacyBearerToken(event.target.value)} placeholder="token or env:VAR" />
                    </div>
                  ) : null}
                  {integrationAuthType === "MTLS" ? (
                    <div className="integration-auth-grid">
                      <label>Client Cert PEM</label>
                      <textarea rows={3} value={mtlsCert} onChange={(event) => setMtlsCert(event.target.value)} />
                      <label>Client Key PEM</label>
                      <textarea rows={3} value={mtlsKey} onChange={(event) => setMtlsKey(event.target.value)} />
                      <label>CA PEM (Optional)</label>
                      <textarea rows={3} value={mtlsCa} onChange={(event) => setMtlsCa(event.target.value)} />
                    </div>
                  ) : null}
                </section>
                <div className="ops-actions-grid">
                  <button type="button" onClick={() => createIntegration().catch(() => undefined)}>
                    Create Integration
                  </button>
                  <button type="button" disabled={!selectedIntegration || !canManageSelectedIntegration} onClick={() => updateIntegration().catch(() => undefined)}>
                    Save Changes
                  </button>
                  <button type="button" disabled={!selectedIntegration} onClick={() => duplicateIntegration().catch(() => undefined)}>
                    Duplicate
                  </button>
                </div>
                <div className="ops-form-row">
                  <label>Share Username</label>
                  <input value={integrationShareUsername} onChange={(event) => setIntegrationShareUsername(event.target.value)} placeholder="username" />
                  <button type="button" disabled={!selectedIntegration || !canManageSelectedIntegration} onClick={() => shareIntegration().catch(() => undefined)}>
                    Share
                  </button>
                  <span />
                </div>
                <div className="ops-form-row">
                  <label>Test with Environment</label>
                  <select value={integrationTestEnvironmentId} onChange={(event) => setIntegrationTestEnvironmentId(event.target.value)}>
                    <option value="">No environment</option>
                    {environmentRows.map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.name} ({entry.ownerId})
                      </option>
                    ))}
                  </select>
                  <button type="button" disabled={!selectedIntegration} onClick={() => testIntegration().catch(() => undefined)}>
                    Test Authentication
                  </button>
                  <span />
                </div>
                <div className="ops-actions-grid">
                  <button type="button" disabled={!selectedIntegration || !canManageSelectedIntegration} onClick={() => updateLifecycle("activate").catch(() => undefined)}>
                    Activate
                  </button>
                  <button type="button" disabled={!selectedIntegration || !canManageSelectedIntegration} onClick={() => updateLifecycle("deactivate").catch(() => undefined)}>
                    Deactivate
                  </button>
                  <button type="button" disabled={!selectedIntegration || !canManageSelectedIntegration} onClick={() => updateLifecycle("delete").catch(() => undefined)}>
                    Terminate (Delete)
                  </button>
                </div>

                {integrationUsageWarning.length > 0 ? (
                  <div className="integration-warning">
                    <strong>Cannot deactivate/terminate: integration is used in workflows.</strong>
                    <ul>
                      {integrationUsageWarning.map((workflow) => (
                        <li key={workflow.workflowVersionId}>
                          {workflow.workflowName} (v{workflow.version})
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </section>
            </div>
          </>
        ) : (
          <>
            <div className="integration-scope-row">
              <span>View:</span>
              <button type="button" className={environmentScope === "owned" ? "chip-active" : ""} onClick={() => setEnvironmentScope("owned")}>
                My Environments
              </button>
              <button type="button" className={environmentScope === "shared" ? "chip-active" : ""} onClick={() => setEnvironmentScope("shared")}>
                Shared With Me
              </button>
              <button type="button" className={environmentScope === "all" ? "chip-active" : ""} onClick={() => setEnvironmentScope("all")}>
                One-Click All
              </button>
            </div>

            <div className="integration-layout">
              <section className="card">
                <h4>Environment Collections</h4>
                <div className="ops-table-wrap">
                  <table className="ops-table">
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th>Owner</th>
                        <th>Default</th>
                        <th>Access</th>
                        <th>Updated</th>
                      </tr>
                    </thead>
                    <tbody>
                      {environmentRows.length === 0 ? (
                        <tr>
                          <td colSpan={5}>No environments for selected scope.</td>
                        </tr>
                      ) : (
                        environmentRows.map((entry) => (
                          <tr key={entry.id} className={selectedEnvironmentId === entry.id ? "ops-row-selected" : ""} onClick={() => setSelectedEnvironmentId(entry.id)}>
                            <td>{entry.name}</td>
                            <td>{entry.ownerId}</td>
                            <td>{entry.isDefault ? "Yes" : "No"}</td>
                            <td>{entry.access}</td>
                            <td>{formatTs(entry.updatedAt)}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              <section className="card">
                <h4>Environment Editor</h4>
                <div className="ops-form-row">
                  <label>Name</label>
                  <input value={environmentName} onChange={(event) => setEnvironmentName(event.target.value)} />
                  <button type="button" onClick={() => createEnvironment().catch(() => undefined)}>
                    Create
                  </button>
                  <button type="button" disabled={!selectedEnvironment || !canManageSelectedEnvironment} onClick={() => updateEnvironment().catch(() => undefined)}>
                    Save
                  </button>
                </div>
                <div className="integration-scope-row">
                  <span>Editor:</span>
                  <button type="button" className={environmentEditorMode === "table" ? "chip-active" : ""} onClick={() => switchEnvironmentEditorMode("table")}>
                    Variable / Value
                  </button>
                  <button type="button" className={environmentEditorMode === "json" ? "chip-active" : ""} onClick={() => switchEnvironmentEditorMode("json")}>
                    JSON
                  </button>
                  <label className="file-upload-inline">
                    Import Postman JSON
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        importPostmanEnvironment(file).catch((importError) => {
                          setStatus("");
                          setError(importError instanceof Error ? importError.message : "Failed to import Postman environment");
                        });
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                </div>
                {environmentEditorMode === "json" ? (
                  <div className="ops-form-row">
                    <label>Variables JSON</label>
                    <textarea rows={12} value={environmentJson} onChange={(event) => setEnvironmentJson(event.target.value)} />
                    <span />
                    <span />
                  </div>
                ) : (
                  <div className="env-variable-table-wrap">
                    <table className="ops-table env-variable-table">
                      <thead>
                        <tr>
                          <th>Enabled</th>
                          <th>Variable</th>
                          <th>Value</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {environmentRowsEditor.map((row, index) => (
                          <tr key={`${index}-${row.key}`}>
                            <td>
                              <input type="checkbox" checked={row.enabled} onChange={(event) => patchEnvironmentRow(index, { enabled: event.target.checked })} />
                            </td>
                            <td>
                              <input value={row.key} onChange={(event) => patchEnvironmentRow(index, { key: event.target.value })} placeholder="variable_name" />
                            </td>
                            <td>
                              <input value={row.value} onChange={(event) => patchEnvironmentRow(index, { value: event.target.value })} placeholder="value" />
                            </td>
                            <td>
                              <button type="button" onClick={() => removeEnvironmentRow(index)}>
                                Remove
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button type="button" onClick={addEnvironmentRow}>
                      Add Variable
                    </button>
                  </div>
                )}
                <div className="ops-form-row">
                  <label>Share Username</label>
                  <input value={environmentShareUsername} onChange={(event) => setEnvironmentShareUsername(event.target.value)} placeholder="username" />
                  <button type="button" disabled={!selectedEnvironment || !canManageSelectedEnvironment} onClick={() => shareEnvironment().catch(() => undefined)}>
                    Share
                  </button>
                  <span />
                </div>
                <div className="ops-actions-grid">
                  <button type="button" disabled={!selectedEnvironment} onClick={() => duplicateEnvironment().catch(() => undefined)}>
                    Duplicate
                  </button>
                  <button type="button" disabled={!selectedEnvironment || !canManageSelectedEnvironment} onClick={() => deleteEnvironment().catch(() => undefined)}>
                    Delete
                  </button>
                </div>
              </section>
            </div>
          </>
        )}

        <p className="ops-status-line">Status: {status || "-"}</p>
        {error ? <p className="ops-error">{error}</p> : null}
      </Panel>
    </>
  );
}
