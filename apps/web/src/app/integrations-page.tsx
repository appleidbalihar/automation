"use client";

import { useCallback, useEffect, useState } from "react";
import type { ReactElement } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { fetchIdentity } from "./auth-client";
import { loadIntegrations, requestJson } from "./integrations/api";
import { CreateSourceModal } from "./integrations/CreateSourceModal";
import { EditSourceModal } from "./integrations/EditSourceModal";
import { KnowledgeSourcesTable } from "./integrations/KnowledgeSourcesTable";
import { SyncProcessMonitor } from "./integrations/SyncProcessMonitor";
import type { Integration, IntegrationForm, SyncJob } from "./integrations/types";
import { EMPTY_FORM } from "./integrations/types";

type OAuthProvider = "github" | "gitlab" | "googledrive";
type SyncTriggerResponse = { accepted: boolean; syncJobId: string; knowledgeBaseId: string };

export function IntegrationsPage(): ReactElement {
  const searchParams = useSearchParams();
  const [identity, setIdentity] = useState<{ userId: string; roles: string[] } | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [form, setForm] = useState<IntegrationForm>(EMPTY_FORM);
  const [busy, setBusy] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Integration | null>(null);

  const loadAll = useCallback(async (): Promise<void> => {
    const [currentIdentity, items] = await Promise.all([fetchIdentity(), loadIntegrations()]);
    setIdentity(currentIdentity);
    setIntegrations(items);
  }, []);

  useEffect(() => {
    loadAll().catch((e) => setError(e instanceof Error ? e.message : "Failed to load integrations"));
  }, [loadAll]);

  // Handle OAuth callback return (?connected=true or ?oauth_error=...)
  useEffect(() => {
    const connected = searchParams.get("connected");
    const oauthError = searchParams.get("oauth_error");
    const provider = searchParams.get("provider") ?? "";

    if (connected === "true") {
      const label = provider === "google" ? "Google Drive" : provider.charAt(0).toUpperCase() + provider.slice(1);
      setStatus(`${label || "Provider"} connected via OAuth successfully.`);
      loadAll().catch(() => undefined);
      const url = new URL(window.location.href);
      ["connected", "provider", "kbId"].forEach((k) => url.searchParams.delete(k));
      window.history.replaceState({}, "", url.toString());
    } else if (oauthError) {
      setError(`OAuth connect failed: ${oauthError}`);
      const url = new URL(window.location.href);
      ["oauth_error", "provider"].forEach((k) => url.searchParams.delete(k));
      window.history.replaceState({}, "", url.toString());
    }
  }, [searchParams, loadAll]);

  const onMergeSyncJob = useCallback((kbId: string, job: SyncJob) => {
    setIntegrations((prev) => prev.map((i) => (i.id === kbId ? { ...i, latestSyncJob: job } : i)));
  }, []);

  // ── Create (PAT) ────────────────────────────────────────────────────────────
  async function handleCreatePat(): Promise<void> {
    setBusy("create");
    setStatus("");
    setError("");
    try {
      const created = await requestJson<Integration>("/rag/integrations", "POST", {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        sourceType: form.sourceType,
        sourceUrl: form.sourceUrl.trim(),
        sourceBranch: form.sourceBranch.trim() || undefined,
        sourcePath: form.sourcePath.trim() || undefined,
        setDefault: form.setDefault,
        credentials: {
          githubToken: form.githubToken.trim() || undefined,
          gitlabToken: form.gitlabToken.trim() || undefined,
          googleDriveAccessToken: form.googleDriveAccessToken.trim() || undefined,
          googleDriveRefreshToken: form.googleDriveRefreshToken.trim() || undefined
        }
      });
      setIntegrations((c) => [created, ...(form.setDefault ? c.map((i) => ({ ...i, isDefault: false })) : c)]);
      setForm(EMPTY_FORM);
      setCreateModalOpen(false);
      setStatus(`Integration "${created.name}" created.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create integration");
    } finally {
      setBusy("");
    }
  }

  // ── Create + OAuth ──────────────────────────────────────────────────────────
  async function handleCreateOauth(provider: OAuthProvider, appCredentials: { clientId: string; clientSecret: string } | null): Promise<void> {
    setBusy("create");
    setStatus("");
    setError("");
    try {
      // Create the integration record first (no token) then redirect to OAuth
      const created = await requestJson<Integration>("/rag/integrations", "POST", {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        sourceType: provider,
        sourceUrl: form.sourceUrl.trim(),
        sourceBranch: form.sourceBranch.trim() || undefined,
        sourcePath: form.sourcePath.trim() || undefined,
        setDefault: form.setDefault
      });
      // Save app credentials per-integration (after integration exists)
      if (appCredentials?.clientId || appCredentials?.clientSecret) {
        await requestJson(`/rag/integrations/${created.id}/oauth-app-credentials`, "PATCH", {
          clientId: appCredentials.clientId || undefined,
          clientSecret: appCredentials.clientSecret || undefined
        });
      }
      setForm(EMPTY_FORM);
      setCreateModalOpen(false);
      // Fetch the OAuth authorize URL with auth header, then redirect browser
      // Pass clientId inline so api-gateway can use it immediately (avoids Vault timing race)
      const oauthProvider = provider === "googledrive" ? "google" : provider;
      const clientIdParam = appCredentials?.clientId ? `&clientId=${encodeURIComponent(appCredentials.clientId)}` : "";
      const { url } = await requestJson<{ url: string }>(`/oauth/connect/${oauthProvider}?kbId=${created.id}&json=1${clientIdParam}`, "GET");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create integration");
      setBusy("");
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  async function handleDelete(id: string): Promise<void> {
    if (!window.confirm("Delete this knowledge source? This cannot be undone.")) return;
    setBusy(`delete:${id}`);
    setStatus("");
    setError("");
    try {
      await requestJson(`/rag/integrations/${id}`, "DELETE");
      setIntegrations((c) => c.filter((i) => i.id !== id));
      setStatus("Integration removed.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete integration");
    } finally {
      setBusy("");
    }
  }

  // ── Set default ─────────────────────────────────────────────────────────────
  async function handleSetDefault(id: string): Promise<void> {
    setBusy(`default:${id}`);
    setStatus("");
    setError("");
    try {
      await requestJson(`/rag/integrations/${id}/set-default`, "POST");
      setIntegrations((c) => c.map((i) => ({ ...i, isDefault: i.id === id })));
      setStatus("Default knowledge base updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update default integration");
    } finally {
      setBusy("");
    }
  }

  // ── Sync ────────────────────────────────────────────────────────────────────
  async function handleSync(id: string): Promise<void> {
    setBusy(`sync:${id}`);
    setStatus("");
    setError("");
    try {
      const response = await requestJson<SyncTriggerResponse>(`/rag/knowledge-bases/${id}/sync`, "POST");
      const optimisticJob: SyncJob = {
        id: response.syncJobId,
        status: "running",
        errorMessage: null,
        filesProcessed: 0,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null
      };
      onMergeSyncJob(id, optimisticJob);
      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      setStatus("Sync requested.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to trigger sync");
    } finally {
      setBusy("");
    }
  }

  // ── Cancel sync ─────────────────────────────────────────────────────────────
  async function handleCancelSync(id: string): Promise<void> {
    setBusy(`cancel:${id}`);
    setStatus("");
    setError("");
    try {
      await requestJson(`/rag/knowledge-bases/${id}/sync-cancel`, "POST");
      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      setStatus("Sync cancelled.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to cancel sync");
    } finally {
      setBusy("");
    }
  }

  // ── Edit (save source details) ───────────────────────────────────────────────
  async function handleEditSave(id: string, patch: Record<string, unknown>): Promise<void> {
    setBusy(`edit:${id}`);
    setStatus("");
    setError("");
    try {
      await requestJson(`/rag/integrations/${id}`, "PATCH", patch);
      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      const updated = refreshed.find((i) => i.id === id) ?? null;
      setEditTarget(updated);
      setStatus("Integration updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update integration");
    } finally {
      setBusy("");
    }
  }

  // ── Edit — update PAT ────────────────────────────────────────────────────────
  async function handleUpdateToken(integration: Integration, token: string): Promise<void> {
    if (!token.trim()) { setError("Paste a token before saving."); return; }
    const key = integration.sourceType === "gitlab" ? "gitlabToken"
      : integration.sourceType === "googledrive" ? "googleDriveAccessToken"
      : "githubToken";
    setBusy(`token:${integration.id}`);
    setStatus("");
    setError("");
    try {
      await requestJson(`/rag/integrations/${integration.id}`, "PATCH", { credentials: { [key]: token } });
      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      const updated = refreshed.find((i) => i.id === integration.id) ?? null;
      setEditTarget(updated);
      setStatus("Token saved to Vault.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update token");
    } finally {
      setBusy("");
    }
  }

  // ── OAuth reconnect (from edit modal) ───────────────────────────────────────
  async function handleOAuthReconnect(integration: Integration, appCredentials: { clientId: string; clientSecret: string } | null): Promise<void> {
    const provider = integration.sourceType === "googledrive" ? "google" : integration.sourceType;
    try {
      if (appCredentials?.clientId || appCredentials?.clientSecret) {
        await requestJson(`/rag/integrations/${integration.id}/oauth-app-credentials`, "PATCH", {
          clientId: appCredentials.clientId || undefined,
          clientSecret: appCredentials.clientSecret || undefined
        });
      }
      const clientIdParam = appCredentials?.clientId ? `&clientId=${encodeURIComponent(appCredentials.clientId)}` : "";
      const { url } = await requestJson<{ url: string }>(`/oauth/connect/${provider}?kbId=${integration.id}&json=1${clientIdParam}`, "GET");
      window.location.href = url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start OAuth connect");
    }
  }

  // ── OAuth disconnect ─────────────────────────────────────────────────────────
  async function handleOAuthDisconnect(integration: Integration): Promise<void> {
    if (!window.confirm(`Disconnect ${integration.sourceType} OAuth? You can reconnect or use a PAT afterwards.`)) return;
    const provider = integration.sourceType === "googledrive" ? "google" : integration.sourceType;
    setBusy(`oauth-disconnect:${integration.id}`);
    setStatus("");
    setError("");
    try {
      await requestJson(`/oauth/token/${provider}?kbId=${integration.id}`, "DELETE");
      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      const updated = refreshed.find((i) => i.id === integration.id) ?? null;
      setEditTarget(updated);
      setStatus("OAuth disconnected.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect OAuth");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="integrations-page">
      <section className="integrations-hero ops-integrations-hero">
        <div className="ops-integrations-hero-main">
          <h1>Operations AI Setup</h1>
          <p>
            Connect your own source documents to Operations AI. Each user&apos;s source configuration is isolated, stored in Vault, and used
            only for that user&apos;s chat knowledge base.
          </p>
          <p>
            Use <Link href="/operations-ai">Operations AI</Link> for chat once a source is connected and ready.
          </p>
        </div>
        <div className="ops-signed-in-badge" title="Credentials stay in your Vault user path.">
          <span className="ops-signed-in-label">Signed in as</span>
          <strong className="ops-signed-in-user">{identity?.userId ?? "loading…"}</strong>
        </div>
      </section>

      <KnowledgeSourcesTable
        integrations={integrations}
        busy={busy}
        onSetDefault={(id) => void handleSetDefault(id)}
        onSync={(id) => void handleSync(id)}
        onCancelSync={(id) => void handleCancelSync(id)}
        onEdit={(integration) => setEditTarget(integration)}
        onDelete={(id) => void handleDelete(id)}
        status={status}
        error={error}
        onCreateSource={() => { setForm(EMPTY_FORM); setCreateModalOpen(true); }}
      />

      <SyncProcessMonitor integrations={integrations} onMergeSyncJob={onMergeSyncJob} />

      <CreateSourceModal
        open={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        form={form}
        setForm={setForm}
        busy={busy === "create"}
        onSubmitPat={() => void handleCreatePat()}
        onSubmitOauth={(provider, creds) => void handleCreateOauth(provider, creds)}
      />

      <EditSourceModal
        integration={editTarget}
        busy={busy}
        onClose={() => setEditTarget(null)}
        onSave={(id, patch) => void handleEditSave(id, patch)}
        onOAuthReconnect={handleOAuthReconnect}
        onOAuthDisconnect={(integration) => void handleOAuthDisconnect(integration)}
        onUpdateToken={(integration, token) => void handleUpdateToken(integration, token)}
      />
    </div>
  );
}
