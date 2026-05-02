"use client";

import { useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";
import { resolveApiBase } from "./api-base";

type SecretItem = {
  path: string;
  key: string;
  value: string;
  valueMasked?: boolean;
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

type SecretModalMode = "view" | "edit" | "create";

type SecretModalState = {
  mode: SecretModalMode;
  item?: SecretItem;
  path: string;
  keyName: string;
  value: string;
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

function modalTitle(mode: SecretModalMode): string {
  if (mode === "create") return "New Secret";
  if (mode === "edit") return "Edit Secret";
  return "View Secret";
}

export function AdminSecretsPanel(): ReactElement {
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [items, setItems] = useState<SecretItem[]>([]);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [modal, setModal] = useState<SecretModalState | null>(null);

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

  async function saveSecret(): Promise<void> {
    if (!modal) return;
    if (!modal.path.trim() || !modal.keyName.trim()) {
      setError("Path and key are required.");
      return;
    }
    if (!modal.value) {
      setError("Value is required. Masked secrets must be replaced with a new value.");
      return;
    }
    setStatus("Saving secret...");
    setError("");
    try {
      await requestJson("/admin/secrets/by-path", {
        method: "POST",
        body: JSON.stringify({
          path: modal.path.trim(),
          key: modal.keyName.trim(),
          value: modal.value
        })
      });
      setModal(null);
      setStatus("Secret saved.");
      await loadCatalog();
    } catch (saveError) {
      setStatus("");
      setError(saveError instanceof Error ? saveError.message : "Failed to save secret");
    }
  }

  async function deleteSecretKey(pathValue: string, key: string): Promise<void> {
    const ok = window.confirm(`Delete ${pathValue}#${key} from Vault?`);
    if (!ok) return;
    setStatus("Deleting secret key...");
    setError("");
    try {
      await requestJson("/admin/secrets/by-path", {
        method: "DELETE",
        body: JSON.stringify({ path: pathValue, key })
      });
      setModal(null);
      setStatus("Secret key deleted.");
      await loadCatalog();
    } catch (deleteError) {
      setStatus("");
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete secret key");
    }
  }

  async function deleteSecretPath(pathValue: string): Promise<void> {
    const ok = window.confirm(`Delete the entire Vault path ${pathValue}?`);
    if (!ok) return;
    setStatus("Deleting secret path...");
    setError("");
    try {
      await requestJson("/admin/secrets/by-path", {
        method: "DELETE",
        body: JSON.stringify({ path: pathValue })
      });
      setModal(null);
      setStatus("Secret path deleted.");
      await loadCatalog();
    } catch (deleteError) {
      setStatus("");
      setError(deleteError instanceof Error ? deleteError.message : "Failed to delete secret path");
    }
  }

  function openCreateModal(): void {
    setModal({
      mode: "create",
      path: "",
      keyName: "",
      value: ""
    });
    setError("");
  }

  function openViewModal(item: SecretItem): void {
    setModal({
      mode: "view",
      item,
      path: item.path,
      keyName: item.key,
      value: item.valueMasked ? "" : item.value
    });
    setError("");
  }

  function openEditModal(item: SecretItem): void {
    setModal({
      mode: "edit",
      item,
      path: item.path,
      keyName: item.key,
      value: item.valueMasked ? "" : item.value
    });
    setError("");
  }

  const integrationRows = useMemo(() => {
    type IntegrationRow = {
      userId: string;
      kbId: string;
      kbName: string | null;
      provider: string;
      hasClientId: boolean;
      hasClientSecret: boolean;
      authMethod: string | null;
    };
    const rowMap = new Map<string, IntegrationRow>();
    for (const item of items) {
      if (item.resourceType !== "integration" || !item.ownerId || !item.resourceId) continue;
      const rowKey = `${item.ownerId}:${item.resourceId}`;
      if (!rowMap.has(rowKey)) {
        rowMap.set(rowKey, {
          userId: item.ownerId,
          kbId: item.resourceId,
          kbName: item.resourceName ?? null,
          provider: "",
          hasClientId: false,
          hasClientSecret: false,
          authMethod: null
        });
      }
      const row = rowMap.get(rowKey)!;
      if (item.key === "oauth_client_id") row.hasClientId = true;
      if (item.key === "oauth_client_secret") row.hasClientSecret = true;
      if (item.key === "auth_method") row.authMethod = item.valueMasked ? null : item.value;
      if (item.key === "github_token") row.provider = "github";
      if (item.key === "gitlab_token") row.provider = "gitlab";
      if (item.key === "gdrive_token" || item.key === "googledrive_access_token") row.provider = "googledrive";
    }
    return Array.from(rowMap.values());
  }, [items]);

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
          Per-integration OAuth App credentials are stored in Vault. To update OAuth details, open the integration in{" "}
          <a href="/integrations">Operations AI Setup</a> and edit the OAuth tab.
        </p>
        {integrationRows.length === 0 ? (
          <p style={{ fontSize: "0.88rem", color: "#64748b" }}>No integrations with stored credentials found.</p>
        ) : (
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
                {integrationRows.map((row) => (
                  <tr key={`${row.userId}:${row.kbId}`}>
                    <td>{row.userId}</td>
                    <td>{row.kbName ?? row.kbId}</td>
                    <td>{row.provider || "-"}</td>
                    <td>{row.hasClientId ? "Configured" : "Not set"}</td>
                    <td>{row.authMethod === "oauth" ? "OAuth" : row.authMethod === "pat" ? "PAT" : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="ops-section-heading">
          <h3 style={{ margin: 0 }}>All Secrets</h3>
          <div className="ops-row-actions">
            <button type="button" onClick={openCreateModal}>
              New Secret
            </button>
            <button type="button" onClick={() => loadCatalog().catch(() => undefined)}>
              Refresh
            </button>
          </div>
        </div>
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
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={8}>{loading ? "Loading..." : "No secrets found."}</td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr key={`${item.path}:${item.key}`}>
                    <td>{item.path}</td>
                    <td>{item.key}</td>
                    <td>{item.purpose ?? "Platform Secret"}</td>
                    <td>{describeUsage(item)}</td>
                    <td>{item.valueMasked ? "***" : item.value}</td>
                    <td>{item.version}</td>
                    <td>{formatTs(item.updatedAt)}</td>
                    <td>
                      <div className="ops-row-actions">
                        <button type="button" onClick={() => openViewModal(item)}>
                          View
                        </button>
                        <button type="button" onClick={() => openEditModal(item)}>
                          Edit
                        </button>
                        <button type="button" onClick={() => deleteSecretKey(item.path, item.key).catch(() => undefined)}>
                          Delete Key
                        </button>
                        <button type="button" onClick={() => deleteSecretPath(item.path).catch(() => undefined)}>
                          Delete Path
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {modal ? (
        <div className="ops-modal-overlay" role="presentation" onClick={() => setModal(null)}>
          <div className="ops-modal-panel ops-modal-narrow" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <div className="ops-modal-panel-header">
              <h2>{modalTitle(modal.mode)}</h2>
              <button type="button" className="ops-modal-close" onClick={() => setModal(null)} aria-label="Close">
                x
              </button>
            </div>
            <p className="ops-modal-lead">
              {modal.item?.valueMasked
                ? "This value is sensitive and remains masked. Enter a replacement value to update it."
                : "Non-sensitive values such as URLs, workflow IDs, and model names can be viewed and edited here."}
            </p>
            <div className="integrations-form-grid ops-modal-form">
              <label className="integrations-form-span-2">
                Path
                <input
                  value={modal.path}
                  disabled={modal.mode === "view"}
                  onChange={(event) => setModal((current) => current ? { ...current, path: event.target.value } : current)}
                  placeholder="platform/global/dify/config"
                />
              </label>
              <label>
                Key
                <input
                  value={modal.keyName}
                  disabled={modal.mode === "view"}
                  onChange={(event) => setModal((current) => current ? { ...current, keyName: event.target.value } : current)}
                  placeholder="model_api_base"
                />
              </label>
              <label>
                Version
                <input value={modal.item?.version ?? "-"} disabled />
              </label>
              <label className="integrations-form-span-2">
                Value
                <input
                  value={modal.item?.valueMasked && modal.mode === "view" ? "***" : modal.value}
                  disabled={modal.mode === "view"}
                  type={modal.item?.valueMasked ? "password" : "text"}
                  onChange={(event) => setModal((current) => current ? { ...current, value: event.target.value } : current)}
                  placeholder={modal.item?.valueMasked ? "Enter replacement value" : "value"}
                />
              </label>
              <label>
                Updated
                <input value={formatTs(modal.item?.updatedAt)} disabled />
              </label>
              <label>
                Purpose
                <input value={modal.item?.purpose ?? (modal.mode === "create" ? "New platform secret" : "Platform Secret")} disabled />
              </label>
            </div>
            <div className="ops-modal-footer-nav ops-modal-footer-nav-spread" style={{ marginTop: 14 }}>
              <button type="button" className="ops-modal-back-btn" onClick={() => setModal(null)}>
                Close
              </button>
              <div className="ops-row-actions">
                {modal.mode === "view" && modal.item ? (
                  <button type="button" onClick={() => openEditModal(modal.item!)}>
                    Edit
                  </button>
                ) : null}
                {modal.mode !== "view" ? (
                  <button type="button" onClick={() => saveSecret().catch(() => undefined)}>
                    Save
                  </button>
                ) : null}
                {modal.item ? (
                  <>
                    <button type="button" onClick={() => deleteSecretKey(modal.item!.path, modal.item!.key).catch(() => undefined)}>
                      Delete Key
                    </button>
                    <button type="button" onClick={() => deleteSecretPath(modal.item!.path).catch(() => undefined)}>
                      Delete Path
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
