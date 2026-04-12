"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";
import { resolveApiBase } from "./api-base";

type SecretItem = {
  path: string;
  key: string;
  value: string;
  version: number;
  updatedAt: string | null;
  purpose?: string;
  ownerId?: string | null;
  resourceType?: string;
  resourceId?: string | null;
  resourceName?: string | null;
  workflowCount?: number | null;
};

type SecretCatalog = {
  totalPaths: number;
  totalSecrets: number;
  items: SecretItem[];
};

type UsageResponse = {
  ref: string;
  usage: {
    integrations: Array<{ id: string; name: string; ownerId: string }>;
    environments: Array<{ id: string; name: string; ownerId: string }>;
    workflows: Array<{ id: string; workflowId: string; version: number }>;
  };
};

function formatTs(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function toVaultRef(path: string, key: string): string {
  return `vault:secret/data/${path}#${key}`;
}

function describeUsage(item: SecretItem): string {
  const resourceType = (item.resourceType ?? "").toLowerCase();
  if (resourceType === "integration") {
    const name = item.resourceName ? `"${item.resourceName}"` : item.resourceId ? `#${item.resourceId}` : "unknown integration";
    return `Integration ${name}`;
  }
  if (resourceType === "environment") {
    const name = item.resourceName ? `"${item.resourceName}"` : item.resourceId ? `#${item.resourceId}` : "unknown environment";
    return `Environment ${name}`;
  }
  if (resourceType === "global") {
    return "Global platform secret";
  }
  return item.resourceId ? `${item.resourceType ?? "resource"} #${item.resourceId}` : "General platform secret";
}

export function AdminSecretsPanel(): ReactElement {
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [items, setItems] = useState<SecretItem[]>([]);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  const [path, setPath] = useState<string>("");
  const [keyName, setKeyName] = useState<string>("");
  const [value, setValue] = useState<string>("");

  const [usage, setUsage] = useState<UsageResponse["usage"] | null>(null);
  const [selectedRef, setSelectedRef] = useState<string>("");

  async function requestJson<T>(pathValue: string, options?: RequestInit): Promise<T> {
    const auth = authHeaderFromStoredToken();
    const response = await fetch(`${resolveApiBase()}${pathValue}`, {
      ...options,
      headers: {
        ...(options?.headers ?? {}),
        ...(auth ? { authorization: auth } : {}),
        "content-type": "application/json"
      }
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
    if (!response.ok) {
      throw new Error(payload.details ?? payload.error ?? `Request failed ${response.status}`);
    }
    return payload as T;
  }

  async function loadCatalog(): Promise<void> {
    const payload = await requestJson<SecretCatalog>("/admin/secrets/catalog?limit=5000");
    setItems(payload.items ?? []);
  }

  async function loadPage(): Promise<void> {
    setLoading(true);
    try {
      const identity = await fetchIdentity();
      const admin = identity.roles.includes("admin");
      setIsAdmin(admin);
      if (admin) await loadCatalog();
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPage().catch(() => undefined);
  }, []);

  async function upsertSecret(): Promise<void> {
    if (!path.trim() || !keyName.trim() || !value) {
      setError("Path, key, and value are required.");
      return;
    }
    setStatus("Saving secret...");
    setError("");
    try {
      await requestJson("/admin/secrets/by-path", {
        method: "POST",
        body: JSON.stringify({
          path: path.trim(),
          key: keyName.trim(),
          value
        })
      });
      setValue("");
      setStatus("Secret saved.");
      await loadCatalog();
    } catch (saveError) {
      setStatus("");
      setError(saveError instanceof Error ? saveError.message : "Failed to save secret");
    }
  }

  async function deleteSecret(): Promise<void> {
    if (!path.trim()) {
      setError("Path is required.");
      return;
    }
    setStatus("Deleting...");
    setError("");
    try {
      await requestJson("/admin/secrets/by-path", {
        method: "DELETE",
        body: JSON.stringify({
          path: path.trim(),
          key: keyName.trim() || undefined
        })
      });
      setStatus("Deleted.");
      await loadCatalog();
    } catch (deleteError) {
      setStatus("");
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete secret");
    }
  }

  async function traceUsage(): Promise<void> {
    const ref = selectedRef.trim();
    if (!ref) {
      setUsage(null);
      return;
    }
    setStatus("Loading usage...");
    setError("");
    try {
      const payload = await requestJson<UsageResponse>(`/admin/secrets/usage?ref=${encodeURIComponent(ref)}`);
      setUsage(payload.usage);
      setStatus("Usage loaded.");
    } catch (usageError) {
      setStatus("");
      setError(usageError instanceof Error ? usageError.message : "Failed to load usage");
    }
  }

  if (!isAdmin && !loading) {
    return (
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Secrets</h1>
        <p>Only platform-admin users can manage Vault secrets.</p>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Secrets</h1>
        <p>All configured Vault secrets are listed here for platform-admin management.</p>
        {status ? <p className="ops-status-line">{status}</p> : null}
        {error ? <p className="ops-error">{error}</p> : null}
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Edit Secret</h3>
        <div className="ops-grid">
          <label>
            Path
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="platform/users/<user>/<group>" />
          </label>
          <label>
            Key
            <input value={keyName} onChange={(event) => setKeyName(event.target.value)} placeholder="apiKey" />
          </label>
          <label>
            Value
            <input value={value} onChange={(event) => setValue(event.target.value)} type="password" placeholder="new value" />
          </label>
          <button type="button" onClick={() => upsertSecret().catch(() => undefined)}>
            Create/Update
          </button>
          <button type="button" onClick={() => deleteSecret().catch(() => undefined)}>
            Delete Key
          </button>
          <button type="button" onClick={() => loadCatalog().catch(() => undefined)}>
            Refresh
          </button>
        </div>
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>All Secrets</h3>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Key</th>
                <th>Purpose</th>
                <th>Used By</th>
                <th>Workflows</th>
                <th>Value</th>
                <th>Version</th>
                <th>Updated</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={9}>{loading ? "Loading..." : "No secrets found."}</td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={`${item.path}:${item.key}`}>
                    <td>{item.path}</td>
                    <td>{item.key}</td>
                    <td>{item.purpose ?? "Platform Secret"}</td>
                    <td>{describeUsage(item)}</td>
                    <td>{item.workflowCount ?? 0}</td>
                    <td>{item.value}</td>
                    <td>{item.version}</td>
                    <td>{formatTs(item.updatedAt)}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => {
                          setPath(item.path);
                          setKeyName(item.key);
                          const ref = toVaultRef(item.path, item.key);
                          setSelectedRef(ref);
                          setUsage(null);
                          setStatus("Loading usage...");
                          setError("");
                          requestJson<UsageResponse>(`/admin/secrets/usage?ref=${encodeURIComponent(ref)}`)
                            .then((payload) => {
                              setUsage(payload.usage);
                              setStatus("Usage loaded.");
                            })
                            .catch((usageError) => {
                              setStatus("");
                              setError(usageError instanceof Error ? usageError.message : "Failed to load usage");
                            });
                        }}
                      >
                        Select
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Usage</h3>
        <p style={{ marginTop: 0 }}>
          Select a secret row to see where it is used. Reference: <code>{selectedRef || "-"}</code>
        </p>
        <div className="ops-grid">
          <button type="button" onClick={() => traceUsage().catch(() => undefined)} disabled={!selectedRef}>
            Refresh Usage
          </button>
        </div>
        {usage ? (
          <>
            <div className="ops-table-wrap" style={{ marginTop: 12 }}>
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Count</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Integrations</td>
                    <td>{usage.integrations.length}</td>
                  </tr>
                  <tr>
                    <td>Environments</td>
                    <td>{usage.environments.length}</td>
                  </tr>
                  <tr>
                    <td>Workflow Versions</td>
                    <td>{usage.workflows.length}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="ops-table-wrap" style={{ marginTop: 12 }}>
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Used In</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Integrations</td>
                    <td>{usage.integrations.length > 0 ? usage.integrations.map((entry) => entry.name).join(", ") : "-"}</td>
                  </tr>
                  <tr>
                    <td>Environments</td>
                    <td>{usage.environments.length > 0 ? usage.environments.map((entry) => entry.name).join(", ") : "-"}</td>
                  </tr>
                  <tr>
                    <td>Workflow Versions</td>
                    <td>
                      {usage.workflows.length > 0
                        ? usage.workflows.map((entry) => `${entry.workflowId}:v${entry.version}`).join(", ")
                        : "-"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p style={{ marginBottom: 0 }}>No usage loaded yet.</p>
        )}
      </section>
    </>
  );
}
