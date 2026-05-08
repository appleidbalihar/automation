"use client";

import Link from "next/link";
import type { ReactElement } from "react";
import { useEffect, useMemo, useState } from "react";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";
import { loadIntegrations } from "./integrations/api";
import type { Integration } from "./integrations/types";

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
  const response = await fetch("/api/admin/users", {
    headers: authorization ? { authorization } : {},
    cache: "no-store"
  });
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => ({}))) as { users?: unknown[] };
  return Array.isArray(payload.users) ? payload.users.length : null;
}

function StatTile({ label, value, detail }: { label: string; value: string | number; detail: string }): ReactElement {
  return (
    <section className="dashboard-stat-card">
      <p className="dashboard-stat-label">{label}</p>
      <p className="dashboard-stat-value">{value}</p>
      <p className="dashboard-stat-detail">{detail}</p>
    </section>
  );
}

export function DashboardOverview(): ReactElement {
  const [identity, setIdentity] = useState<Identity | null>(null);
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
        setIdentity(currentIdentity);
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
  const attentionItems = integrations
    .filter((integration) => !integration.syncReady || String(integration.latestSyncJob?.status ?? "").toLowerCase() === "failed")
    .slice(0, 4);

  return (
    <div className="dashboard-page">
      <section className="dashboard-hero">
        <div>
          <p className="dashboard-eyebrow">Platform Overview</p>
          <h1>RAG operations dashboard</h1>
          <p>
            Track connector readiness, sync health, indexed documents, and user coverage from one place.
          </p>
        </div>
        <div className="dashboard-user-pill">
          <span>Signed in</span>
          <strong>{identity?.userId ?? "loading..."}</strong>
        </div>
      </section>

      {error ? <p className="ops-error">{error}</p> : null}
      {loading ? <p className="ops-status-line">Loading dashboard stats...</p> : null}

      <div className="dashboard-stat-grid">
        <StatTile label="Connectors" value={stats.connectors} detail={`${stats.connected} with credentials configured`} />
        <StatTile label="Sync Ready" value={stats.syncReady} detail={`${stats.synced} synced, ${stats.syncing} syncing`} />
        <StatTile label="Needs Sync" value={stats.needsSync} detail="Never synced, failed, or waiting for setup" />
        <StatTile label="Documents" value={stats.documents} detail="Latest processed or discovered source files" />
        <StatTile label="Users" value={stats.users ?? "N/A"} detail={stats.users === null ? "Visible to platform admins" : "Keycloak users in realm"} />
      </div>

      <div className="dashboard-action-grid">
        <section className="dashboard-panel">
          <h2>Knowledge status</h2>
          <p>
            {defaultConnector
              ? `Default knowledge base: ${defaultConnector.name}.`
              : "No default knowledge base is selected yet."}
          </p>
          <Link href="/knowledge-connector">Manage connectors</Link>
        </section>

        <section className="dashboard-panel">
          <h2>RAG Assistant</h2>
          <p>Ask grounded questions across your connected and synced knowledge bases.</p>
          <Link href="/rag-assistant">Open RAG Assistant</Link>
        </section>

        <section className="dashboard-panel">
          <h2>Attention needed</h2>
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
            <p>All visible connectors are ready or synced.</p>
          )}
        </section>
      </div>
    </div>
  );
}
