"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { fetchIdentity } from "./auth-client";
import { loadIntegrations, requestJson } from "./integrations/api";
import { CreateSourceModal } from "./integrations/CreateSourceModal";
import { EditSourceModal } from "./integrations/EditSourceModal";
import { KnowledgeSourcesTable } from "./integrations/KnowledgeSourcesTable";
// eslint-disable-next-line import/order
import { SyncProcessMonitor } from "./integrations/SyncProcessMonitor";
import type { Integration, IntegrationForm, SyncJob } from "./integrations/types";
import { EMPTY_FORM } from "./integrations/types";

type OAuthProvider = "github" | "gitlab" | "googledrive";
type SyncTriggerResponse = { accepted: boolean; syncJobId: string; knowledgeBaseId: string };

function normalizeDocumentPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of paths) {
    const path = raw.trim().replace(/^\/+|\/+$/g, "");
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized;
}

// ShareModal is defined here to allow the linter to keep it imported.
// It re-exports ShareKbModal from the integrations folder.
// Keeping it as a named local alias avoids auto-import-removal by the formatter.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ShareKbModal: ShareModal } = require("./integrations/ShareKbModal") as typeof import("./integrations/ShareKbModal");

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
  const [shareTargetId, setShareTargetId] = useState<string | null>(null);

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
      // Build the path fields: send both sourcePaths array and sourcePath (first entry) for backward compat
      const filteredPaths = normalizeDocumentPaths(form.sourcePaths);
      const created = await requestJson<Integration>("/rag/integrations", "POST", {
        name: form.name.trim(),
        projectName: form.projectName.trim() || undefined,
        description: form.description.trim() || undefined,
        sourceType: form.sourceType,
        sourceUrl: form.sourceUrl.trim(),
        sourceBranch: form.sourceBranch.trim() || undefined,
        sourcePaths: filteredPaths.length > 0 ? filteredPaths : undefined,
        sourcePath: filteredPaths[0] ?? undefined,
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
      // Build the path fields: send both sourcePaths array and sourcePath (first entry) for backward compat
      const filteredPaths = normalizeDocumentPaths(form.sourcePaths);
      // Create the integration record first (no token) then redirect to OAuth
      const created = await requestJson<Integration>("/rag/integrations", "POST", {
        name: form.name.trim(),
        projectName: form.projectName.trim() || undefined,
        description: form.description.trim() || undefined,
        sourceType: provider,
        sourceUrl: form.sourceUrl.trim(),
        sourceBranch: form.sourceBranch.trim() || undefined,
        sourcePaths: filteredPaths.length > 0 ? filteredPaths : undefined,
        sourcePath: filteredPaths[0] ?? undefined,
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

  // ── Retry Dify indexing only ────────────────────────────────────────────────
  async function handleRetryFailedIndexing(id: string, options?: { syncJobId?: string; documentIds?: string[] }): Promise<void> {
    const busyKey = options?.documentIds?.length === 1 ? options.documentIds[0] : id;
    setBusy(`retry-indexing:${busyKey}`);
    setStatus("");
    setError("");
    try {
      const response = await requestJson<SyncTriggerResponse>(`/rag/knowledge-bases/${id}/retry-failed-indexing`, "POST", options);
      const optimisticJob: SyncJob = {
        id: response.syncJobId,
        status: "running",
        errorMessage: null,
        filesProcessed: 0,
        createdAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        stepsJson: [
          {
            task: "Retry Failed Indexing",
            stepName: "retry_failed_indexing",
            status: "running",
            startedAt: new Date().toISOString(),
            message: options?.documentIds?.length === 1 ? "Retrying selected Dify document" : "Retrying failed Dify documents"
          }
        ]
      };
      onMergeSyncJob(id, optimisticJob);
      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      setStatus(options?.documentIds?.length === 1 ? "Retry indexing requested for selected file." : "Retry indexing requested.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to retry indexing");
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

  // ── Edit (save source details + auto smart-sync when paths/project change) ───
  async function handleEditSave(
    id: string,
    patch: Record<string, unknown>,
    syncMeta: { addedPaths: string[]; removedPaths: string[]; projectNameChanged: boolean }
  ): Promise<void> {
    setBusy(`edit:${id}`);
    setStatus("");
    setError("");
    try {
      await requestJson(`/rag/integrations/${id}`, "PATCH", patch);
      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      const updated = refreshed.find((i) => i.id === id) ?? null;
      setEditTarget(updated);

      const { addedPaths, removedPaths, projectNameChanged } = syncMeta;
      const hasChanges = addedPaths.length > 0 || removedPaths.length > 0 || projectNameChanged;

      if (hasChanges) {
        // Close the edit modal so user can watch sync progress in the monitor
        setEditTarget(null);

        // Build a human-readable summary
        const parts: string[] = [];
        if (addedPaths.length > 0) parts.push(`${addedPaths.length} path(s) added`);
        if (removedPaths.length > 0) parts.push(`${removedPaths.length} path(s) removed`);
        if (projectNameChanged) parts.push("project name updated");
        setStatus(`Integration saved (${parts.join(", ")}) — starting smart sync…`);

        // Trigger a smart incremental sync passing the diff so the backend/n8n
        // can process only what changed (add new paths, cleanup removed paths).
        // We send the diff in the sync payload so the workflow can act accordingly.
        setBusy(`sync:${id}`);
        try {
          const response = await requestJson<SyncTriggerResponse>(`/rag/knowledge-bases/${id}/sync`, "POST", {
            mode: "smart",
            addedPaths: addedPaths.length > 0 ? addedPaths : undefined,
            removedPaths: removedPaths.length > 0 ? removedPaths : undefined,
            projectNameChanged: projectNameChanged || undefined
          });
          const optimisticJob: SyncJob = {
            id: response.syncJobId,
            status: "running",
            errorMessage: null,
            filesProcessed: 0,
            createdAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: null,
            stepsJson: [
              // Create placeholder steps so user sees what's happening before n8n reports back
              ...removedPaths.map((p) => ({
                task: `Cleanup: ${p}`,
                stepName: `cleanup_path_${p}`,
                status: "pending",
                startedAt: null,
                message: `Remove indexed documents for path "${p}"`
              })),
              ...addedPaths.map((p) => ({
                task: `Index: ${p}`,
                stepName: `index_path_${p}`,
                status: "pending",
                startedAt: null,
                message: `Index new documents for path "${p}"`
              })),
              ...(projectNameChanged ? [{
                task: "Update project name metadata",
                stepName: "update_project_name",
                status: "pending",
                startedAt: null,
                message: "Propagate project name change to indexed documents"
              }] : [])
            ]
          };
          onMergeSyncJob(id, optimisticJob);
          const refreshed2 = await loadIntegrations();
          setIntegrations(refreshed2);
          setStatus(`Smart sync started — monitoring ${parts.join(", ")}.`);
        } catch (syncErr) {
          setError(syncErr instanceof Error ? syncErr.message : "Saved but failed to start sync");
        } finally {
          setBusy("");
        }
      } else {
        setStatus("Integration updated.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update integration");
      setBusy("");
    } finally {
      // Only clear busy if we haven't transferred it to sync state
      if (busy === `edit:${id}`) setBusy("");
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

  // ── Cleanup (remove all indexed documents / Dify KB data for this source) ───
  // Calls the dedicated cleanup endpoint and shows an optimistic deletion-only
  // job in the Sync Monitor so the user can see what's being removed.
  // No upload, fetch, or indexing — only deletion steps are shown.
  async function handleCleanup(id: string): Promise<void> {
    const integration = integrations.find((i) => i.id === id);
    if (!window.confirm(
      `Remove ALL indexed documents and Dify knowledge-base data for "${integration?.name ?? "this source"}"?\n\n` +
      `This ONLY deletes existing data — no files will be fetched or re-indexed.\n` +
      `The integration record stays — you can re-sync to rebuild the index afterwards.\n\nContinue?`
    )) return;

    setBusy(`cleanup:${id}`);
    setStatus("");
    setError("");

    // Show an optimistic deletion-only job immediately so the user sees progress
    const nowIso = new Date().toISOString();
    const optimisticJobId = `cleanup-${id}-${Date.now()}`;
    const optimisticJob: SyncJob = {
      id: optimisticJobId,
      status: "running",
      errorMessage: null,
      filesProcessed: 0,
      createdAt: nowIso,
      startedAt: nowIso,
      completedAt: null,
      stepsJson: [
        {
          task: "Cleanup: Remove documents from Dify knowledge base",
          stepName: "cleanup_dify_documents",
          status: "running",
          startedAt: nowIso,
          message: "Deleting all indexed documents from Dify"
        },
        {
          task: "Cleanup: Clear vector embeddings",
          stepName: "cleanup_vector_embeddings",
          status: "pending",
          startedAt: null,
          message: "Removing all vector embeddings from the knowledge base"
        },
        {
          task: "Cleanup: Reset knowledge base state",
          stepName: "cleanup_reset_state",
          status: "pending",
          startedAt: null,
          message: "Resetting sync status and document counters"
        }
      ]
    };
    onMergeSyncJob(id, optimisticJob);

    try {
      // Call the dedicated cleanup endpoint — this only deletes, never fetches or indexes
      await requestJson(`/rag/knowledge-bases/${id}/cleanup`, "POST");

      // Update the optimistic job to show all steps completed
      const completedIso = new Date().toISOString();
      const completedJob: SyncJob = {
        ...optimisticJob,
        status: "completed",
        completedAt: completedIso,
        stepsJson: [
          {
            task: "Cleanup: Remove documents from Dify knowledge base",
            stepName: "cleanup_dify_documents",
            status: "completed",
            startedAt: nowIso,
            durationMs: Date.now() - new Date(nowIso).getTime(),
            message: "All indexed documents deleted from Dify"
          },
          {
            task: "Cleanup: Clear vector embeddings",
            stepName: "cleanup_vector_embeddings",
            status: "completed",
            startedAt: nowIso,
            message: "All vector embeddings removed"
          },
          {
            task: "Cleanup: Reset knowledge base state",
            stepName: "cleanup_reset_state",
            status: "completed",
            startedAt: nowIso,
            message: "Sync status and counters reset"
          }
        ]
      };
      onMergeSyncJob(id, completedJob);

      const refreshed = await loadIntegrations();
      setIntegrations(refreshed);
      setStatus(`✓ Cleanup complete — all indexed documents removed from "${integration?.name ?? "source"}".`);
    } catch (e) {
      // Mark the job as failed
      const failedJob: SyncJob = {
        ...optimisticJob,
        status: "failed",
        errorMessage: e instanceof Error ? e.message : "Cleanup failed",
        completedAt: new Date().toISOString()
      };
      onMergeSyncJob(id, failedJob);
      setError(e instanceof Error ? e.message : "Failed to clean up knowledge base");
    } finally {
      setBusy("");
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
          <h1>Knowledge Connector</h1>
          <p>
            Connect your source documents to the RAG Assistant. Each user&apos;s source configuration is isolated, stored in Vault, and used
            only for that user&apos;s chat knowledge base.
          </p>
          <p>
            Use <Link href="/rag-assistant">RAG Assistant</Link> for chat once a source is connected and ready.
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
        onRetryFailedIndexing={(id) => void handleRetryFailedIndexing(id)}
        onCancelSync={(id) => void handleCancelSync(id)}
        onEdit={(integration) => setEditTarget(integration)}
        onDelete={(id) => void handleDelete(id)}
        onCleanup={(id) => void handleCleanup(id)}
        onShare={(id) => setShareTargetId(id)}
        status={status}
        error={error}
        onCreateSource={() => { setForm(EMPTY_FORM); setCreateModalOpen(true); }}
      />

      {/* Share KB modal — owner/admin grants chat access to specific users by username */}
      {shareTargetId != null ? (
        <ShareModal
          kbId={shareTargetId}
          kbName={integrations.find((i) => i.id === shareTargetId)?.name ?? shareTargetId}
          onClose={() => setShareTargetId(null)}
        />
      ) : null}

      <SyncProcessMonitor
        integrations={integrations}
        onMergeSyncJob={onMergeSyncJob}
        onRetryFailedIndexing={(id) => void handleRetryFailedIndexing(id)}
        busy={busy}
      />

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
        onSave={(id, patch, syncMeta) => void handleEditSave(id, patch, syncMeta)}
        onOAuthReconnect={handleOAuthReconnect}
        onOAuthDisconnect={(integration) => void handleOAuthDisconnect(integration)}
        onUpdateToken={(integration, token) => void handleUpdateToken(integration, token)}
      />
    </div>
  );
}
