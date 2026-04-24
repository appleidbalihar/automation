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
};

type SecretCatalog = {
  totalPaths: number;
  totalSecrets: number;
  items: SecretItem[];
};

function formatTs(value?: string | null): string {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
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
        <h3 style={{ marginTop: 0 }}>Integration OAuth Credentials</h3>
        <p style={{ marginTop: 0, fontSize: "0.88rem", color: "#475569" }}>
          Per-integration OAuth App credentials (Client ID / Client Secret). Each knowledge source stores its own credentials in Vault.
          To update credentials, open the integration in <a href="/integrations">Operations AI Setup</a> and edit the OAuth tab.
        </p>
        {(() => {
          // Group by (ownerId, resourceId) — find unique integrations that have oauth_client_id or oauth_client_secret
          type IntegrationRow = { userId: string; kbId: string; kbName: string | null; provider: string; hasClientId: boolean; hasClientSecret: boolean; authMethod: string | null };
          const rowMap = new Map<string, IntegrationRow>();
          for (const item of items) {
            if (item.resourceType !== "integration" || !item.ownerId || !item.resourceId) continue;
            const rowKey = `${item.ownerId}:${item.resourceId}`;
            if (!rowMap.has(rowKey)) {
              rowMap.set(rowKey, { userId: item.ownerId, kbId: item.resourceId, kbName: item.resourceName ?? null, provider: "", hasClientId: false, hasClientSecret: false, authMethod: null });
            }
            const row = rowMap.get(rowKey)!;
            if (item.key === "oauth_client_id") row.hasClientId = true;
            if (item.key === "oauth_client_secret") row.hasClientSecret = true;
            if (item.key === "auth_method") row.authMethod = item.value;
            // Infer provider from github_token / auth_method path etc.
            if (item.key === "github_token") row.provider = "github";
            if (item.key === "gitlab_token") row.provider = "gitlab";
            if (item.key === "googledrive_access_token") row.provider = "googledrive";
          }
          const rows = Array.from(rowMap.values());
          if (rows.length === 0) {
            return <p style={{ fontSize: "0.88rem", color: "#64748b" }}>No integrations with stored credentials found.</p>;
          }
          return (
            <div className="ops-table-wrap">
              <table className="ops-table">
                <thead>
                  <tr>
                    <th>User</th>
                    <th>Integration</th>
                    <th>Provider</th>
                    <th>OAuth App</th>
                    <th>Auth Method</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.userId}:${row.kbId}`}>
                      <td>{row.userId}</td>
                      <td>{row.kbName ?? row.kbId}</td>
                      <td>{row.provider || "—"}</td>
                      <td>{row.hasClientId ? "✓ Configured" : "✗ Not set"}</td>
                      <td>{row.authMethod === "oauth" ? "🔗 OAuth" : row.authMethod === "pat" ? "🔑 PAT" : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })()}
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
                <th>Value</th>
                <th>Version</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7}>{loading ? "Loading..." : "No secrets found."}</td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={`${item.path}:${item.key}`}>
                    <td>{item.path}</td>
                    <td>{item.key}</td>
                    <td>{item.purpose ?? "Platform Secret"}</td>
                    <td>{describeUsage(item)}</td>
                    <td>{item.value}</td>
                    <td>{item.version}</td>
                    <td>{formatTs(item.updatedAt)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
