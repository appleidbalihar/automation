"use client";

import Link from "next/link";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";
import { loadIntegrations } from "./integrations/api";
import type { Integration } from "./integrations/types";
import { appPath } from "./web-paths";

type Identity = { userId: string; roles: string[] };
type DashboardStats = {
  connectors: number;
  connected: number;
  syncReady: number;
  synced: number;
  syncing: number;
  needsSync: number;
  documents: number;
  users: number | null;
};

type StatTileProps = {
  label: string;
  value: string | number;
  detail: string;
  icon: string;
  trend: string;
  tone?: "good" | "warn" | "neutral";
};

function latestDocumentCount(integration: Integration): number {
  const job = integration.latestSyncJob;
  if (!job) return 0;
  return Math.max(Number(job.filesProcessed ?? 0), Number(job.filesTotal ?? 0));
}

function calculateStats(integrations: Integration[], users: number | null): DashboardStats {
  return integrations.reduce<DashboardStats>(
    (stats, integration) => {
      const status = String(integration.latestSyncJob?.status ?? "never_synced").toLowerCase();
      const isSynced = status === "completed";
      const isSyncing = status === "running" || status === "pending";

      stats.connectors += 1;
      if (integration.credentialConfigured) stats.connected += 1;
      if (integration.syncReady) stats.syncReady += 1;
      if (isSynced) stats.synced += 1;
      if (isSyncing) stats.syncing += 1;
      if (!isSynced && !isSyncing) stats.needsSync += 1;
      stats.documents += latestDocumentCount(integration);
      return stats;
    },
    {
      connectors: 0,
      connected: 0,
      syncReady: 0,
      synced: 0,
      syncing: 0,
      needsSync: 0,
      documents: 0,
      users
    }
  );
}

async function fetchUserCount(identity: Identity): Promise<number | null> {
  if (!identity.roles.includes("admin")) return null;
  const authorization = authHeaderFromStoredToken();
  const response = await fetch(appPath("/api/admin/users"), {
    headers: authorization ? { authorization } : {},
    cache: "no-store"
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as { users?: unknown[] };
  return Array.isArray(payload.users) ? payload.users.length : null;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function syncStatus(integration: Integration): { label: string; tone: "good" | "warn" | "neutral" } {
  if (!integration.syncReady) return { label: "Setup needed", tone: "warn" };
  const status = String(integration.latestSyncJob?.status ?? "never_synced").toLowerCase();
  if (status === "completed") return { label: "Synced", tone: "good" };
  if (status === "running" || status === "pending") return { label: "Syncing", tone: "neutral" };
  if (status === "failed") return { label: "Review", tone: "warn" };
  return { label: "Ready", tone: "neutral" };
}

function StatTile({ label, value, detail, icon, trend, tone = "neutral" }: StatTileProps): ReactElement {
  return (
    <section className="dashboard-stat-card">
      <div className="dashboard-stat-topline">
        <span className="dashboard-stat-icon">{icon}</span>
        <span className={`dashboard-trend dashboard-trend-${tone}`}>{trend}</span>
      </div>
      <p className="dashboard-stat-label">{label}</p>
      <p className="dashboard-stat-value">{value}</p>
      <p className="dashboard-stat-detail">{detail}</p>
    </section>
  );
}

export function DashboardOverview(): ReactElement {
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [userCount, setUserCount] = useState<number | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let active = true;
    async function loadDashboard(): Promise<void> {
      setLoading(true);
      setError("");
      try {
        const currentIdentity = await fetchIdentity();
        const [loadedIntegrations, loadedUserCount] = await Promise.all([
          loadIntegrations(),
          fetchUserCount(currentIdentity)
        ]);
        if (!active) return;
        setIntegrations(loadedIntegrations);
        setUserCount(loadedUserCount);
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load dashboard stats");
      } finally {
        if (active) setLoading(false);
      }
    }
    void loadDashboard();
    return () => {
      active = false;
    };
  }, []);

  const stats = useMemo(() => calculateStats(integrations, userCount), [integrations, userCount]);
  const defaultConnector = integrations.find((integration) => integration.isDefault);
  const syncedPercent = stats.connectors > 0 ? Math.round((stats.synced / stats.connectors) * 100) : 0;
  const readyPercent = stats.connectors > 0 ? Math.round((stats.syncReady / stats.connectors) * 100) : 0;
  const attentionItems = integrations
    .filter((integration) => !integration.syncReady || String(integration.latestSyncJob?.status ?? "").toLowerCase() === "failed")
    .slice(0, 4);
  const visibleKnowledge = integrations.slice(0, 4);
  const recentActivity = integrations.slice(0, 5);

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="dashboard-eyebrow">Platform Overview</p>
          <h1>Welcome back to RapidRAG</h1>
          <p>Monitor your knowledge sources, sync health, assistant readiness, and team access in one workspace.</p>
        </div>
        <div className="dashboard-hero-actions">
          <Link href="/knowledge-connector" className="dashboard-primary-action">
            Add knowledge source
          </Link>
        </div>
      </section>

      {error ? <p className="ops-error">{error}</p> : null}
      {loading ? <p className="ops-status-line">Loading dashboard stats...</p> : null}

      <div className="dashboard-stat-grid">
        <StatTile label="Knowledge sources" value={stats.connectors} detail={`${stats.connected} credentials configured`} icon="KB" trend={`${readyPercent}% ready`} tone="good" />
        <StatTile label="Indexed documents" value={formatNumber(stats.documents)} detail="Latest processed or discovered files" icon="DOC" trend="+ live" tone="neutral" />
        <StatTile label="Sync coverage" value={`${syncedPercent}%`} detail={`${stats.synced} synced, ${stats.syncing} in progress`} icon="SYNC" trend={`${stats.syncReady} ready`} tone="good" />
        <StatTile label="Needs review" value={stats.needsSync} detail="Waiting for setup, sync, or retry" icon="!" trend={stats.needsSync ? "Action" : "Clear"} tone={stats.needsSync ? "warn" : "good"} />
      </div>

      <div className="dashboard-main-grid">
        <section className="dashboard-panel dashboard-knowledge-panel">
          <div className="dashboard-panel-header">
            <h2>Knowledge sources</h2>
            <Link href="/knowledge-connector">View all</Link>
          </div>
          <div className="dashboard-source-list">
            {visibleKnowledge.length > 0 ? (
              visibleKnowledge.map((integration) => {
                const status = syncStatus(integration);
                return (
                  <div className="dashboard-source-row" key={integration.id}>
                    <div>
                      <strong>{integration.name}</strong>
                      <span>{formatNumber(latestDocumentCount(integration))} files tracked</span>
                    </div>
                    <span className={`dashboard-status-chip dashboard-status-${status.tone}`}>{status.label}</span>
                  </div>
                );
              })
            ) : (
              <p className="dashboard-empty-copy">Connect your first source to start building searchable company knowledge.</p>
            )}
          </div>
        </section>

        <section className="dashboard-assistant-card">
          <div className="dashboard-assistant-header">
            <span>AI</span>
            <strong>Online</strong>
          </div>
          <h2>Ask across your connected knowledge.</h2>
          <p>Use grounded answers from indexed sources, citations, and your team&apos;s current sync state.</p>
          <div className="dashboard-prompt-preview">Try: Which sources changed since the last sync?</div>
          <Link href="/rag-assistant">Open assistant</Link>
        </section>

        <section className="dashboard-panel dashboard-health-panel">
          <div className="dashboard-panel-header">
            <h2>{attentionItems.length ? "Needs attention" : "All clear"}</h2>
            <span className={`dashboard-status-chip dashboard-status-${attentionItems.length ? "warn" : "good"}`}>
              {attentionItems.length ? `${attentionItems.length} issue${attentionItems.length === 1 ? "" : "s"}` : "Healthy"}
            </span>
          </div>
          {attentionItems.length > 0 ? (
            <ul className="dashboard-attention-list">
              {attentionItems.map((integration) => (
                <li key={integration.id}>
                  <strong>{integration.name}</strong>
                  <span>
                    {!integration.syncReady
                      ? "Setup incomplete"
                      : integration.latestSyncJob?.errorMessage ?? "Latest sync failed"}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <ul className="dashboard-check-list">
              <li>{stats.connected} sources have credentials configured</li>
              <li>{stats.syncReady} sources are ready for retrieval</li>
              <li>No failed sync jobs need review</li>
            </ul>
          )}
        </section>
      </div>

      <div className="dashboard-bottom-grid">
        <section className="dashboard-panel dashboard-activity-panel">
          <div className="dashboard-panel-header">
            <h2>Recent source activity</h2>
            <Link href="/logs">View logs</Link>
          </div>
          <ul className="dashboard-timeline">
            {recentActivity.length > 0 ? (
              recentActivity.map((integration) => {
                const status = syncStatus(integration);
                return (
                  <li key={integration.id}>
                    <span className={`dashboard-timeline-dot dashboard-timeline-${status.tone}`} />
                    <div>
                      <strong>{integration.name}</strong>
                      <span>{status.label} - {formatNumber(latestDocumentCount(integration))} tracked files</span>
                    </div>
                  </li>
                );
              })
            ) : (
              <li>
                <span className="dashboard-timeline-dot dashboard-timeline-neutral" />
                <div>
                  <strong>No source activity yet</strong>
                  <span>Add a source and sync it to populate this feed.</span>
                </div>
              </li>
            )}
          </ul>
        </section>

        <section className="dashboard-panel dashboard-quick-panel">
          <h2>Quick actions</h2>
          <div className="dashboard-quick-actions">
            <Link href="/knowledge-connector"><span>+</span><strong>Connect a source</strong></Link>
            <Link href="/chat-channels"><span>#</span><strong>Deploy chat channels</strong></Link>
            <Link href="/ai-agent-prompt"><span>AI</span><strong>Tune assistant prompts</strong></Link>
            <Link href="/rag-stats"><span>%</span><strong>Review analytics</strong></Link>
          </div>
        </section>
      </div>
    </div>
  );
}
