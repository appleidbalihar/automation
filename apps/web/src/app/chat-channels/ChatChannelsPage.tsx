"use client";

import { useEffect, useState, type ReactElement } from "react";
import {
  deactivateSlackDeployment,
  deleteSlackDeployment,
  fetchMyConnections,
  fetchSharedSlackDeployments,
  fetchSlackDeployments
} from "./api";
import { ConnectSlackWizard } from "./ConnectSlackWizard";
import { SlackDeploymentCard } from "./SlackDeploymentCard";
import { SlackDeploymentViewModal } from "./SlackDeploymentViewModal";
import { SlackMembersPanel } from "./SlackMembersPanel";
import type { SlackDeployment } from "./types";

type MyConnection = { deploymentId: string; slackUserId: string; kbIds: string[]; status: string };

export function ChatChannelsPage(): ReactElement {
  const [ownedBots, setOwnedBots] = useState<SlackDeployment[]>([]);
  const [allAccessibleBots, setAllAccessibleBots] = useState<SlackDeployment[]>([]);
  const [myConnections, setMyConnections] = useState<MyConnection[]>([]);
  const [modalDeployment, setModalDeployment] = useState<SlackDeployment | null | undefined>();
  const [connectToBot, setConnectToBot] = useState<SlackDeployment | null>(null);
  const [viewDeployment, setViewDeployment] = useState<SlackDeployment | null>(null);
  const [membersDeployment, setMembersDeployment] = useState<SlackDeployment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [successBanner, setSuccessBanner] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [owned, shared, connections] = await Promise.all([
        fetchSlackDeployments(),
        fetchSharedSlackDeployments().catch(() => [] as SlackDeployment[]),
        fetchMyConnections().catch(() => [] as MyConnection[])
      ]);
      setOwnedBots(owned);
      setMyConnections(connections);
      const ownedIds = new Set(owned.map((d) => d.id));
      const uniqueShared = shared.filter((d) => !ownedIds.has(d.id));
      setAllAccessibleBots([...owned, ...uniqueShared]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("slack_identity") === "true") {
      setSuccessBanner("You are now connected. Message the bot in Slack to get started.");
      window.history.replaceState({}, "", window.location.pathname);
      void load();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function removeDeployment(item: SlackDeployment): Promise<void> {
    if (!window.confirm(`Delete "${item.deploymentName}"? This cannot be undone.`)) return;
    try {
      await deleteSlackDeployment(item.id);
      setOwnedBots((prev) => prev.filter((d) => d.id !== item.id));
      setAllAccessibleBots((prev) => prev.filter((d) => d.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const connectionMap = new Map(myConnections.map((c) => [c.deploymentId, c]));

  return (
    <div className="cc-page">
      {/* ── Page header ──────────────────────────────────────────────── */}
      <div className="cc-page-header">
        <div>
          <p className="cc-eyebrow">Integrations</p>
          <h1 className="cc-page-title">Chat Channels</h1>
          <p className="cc-page-subtitle">
            Create and manage Slack bots, then link your Slack identity to start chatting with your knowledge bases.
          </p>
        </div>
        <div className="cc-header-actions">
          <button
            type="button"
            className="cc-btn-secondary"
            onClick={() => void load()}
            disabled={loading}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {successBanner && (
        <div style={{ background: "#f0fdf4", border: "1px solid #6ee7b7", borderRadius: 8, padding: "10px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ color: "#065f46", fontWeight: 600 }}>✓ {successBanner}</span>
          <button type="button" className="ops-btn ops-btn-sm ops-btn-ghost" onClick={() => setSuccessBanner(null)}>✕</button>
        </div>
      )}
      {error ? <p className="cc-error">{error}</p> : null}

      {/* ══ SECTION 1 — BOT MANAGEMENT ══════════════════════════════════ */}
      <div className="cc-bots-section">
        <div className="cc-bots-header">
          <div>
            <h2 className="cc-bots-title">My Bots</h2>
            <p className="cc-bots-subtitle">Bots you own — create, configure, share, and manage.</p>
          </div>
          <button type="button" className="cc-btn-primary" onClick={() => setModalDeployment(null)}>
            + Create a bot
          </button>
        </div>

        {loading ? (
          <p className="cc-loading">Loading…</p>
        ) : ownedBots.length === 0 ? (
          <div className="cc-bots-empty">
            <p>No bots created yet.</p>
            <button type="button" className="cc-btn-primary" onClick={() => setModalDeployment(null)}>
              + Create a bot
            </button>
          </div>
        ) : (
          <div className="cc-bots-table-wrap">
            <table className="cc-bots-table">
              <thead>
                <tr>
                  <th className="cc-th-bot">Bot</th>
                  <th className="cc-th-status">Status</th>
                  <th className="cc-th-install">Install</th>
                  <th className="cc-th-access">Access Mode</th>
                  <th className="cc-th-knowledge">Knowledge</th>
                  <th className="cc-th-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {ownedBots.map((deployment) => (
                  <SlackDeploymentCard
                    key={deployment.id}
                    deployment={deployment}
                    isOwner={true}
                    onView={(item) => setViewDeployment(item)}
                    onEdit={(item) => setModalDeployment(item)}
                    onMembers={(item) => setMembersDeployment(item)}
                    onDeactivate={(item) =>
                      deactivateSlackDeployment(item.id)
                        .then(load)
                        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                    }
                    onDelete={(item) =>
                      removeDeployment(item).catch((err) => setError(err instanceof Error ? err.message : String(err)))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ══ SECTION 2 — MY SLACK CONNECTIONS ════════════════════════════ */}
      <div className="cc-bots-section">
        <div className="cc-bots-header">
          <div>
            <h2 className="cc-bots-title">My Slack Connections</h2>
            <p className="cc-bots-subtitle">
              All bots you can access — link your Slack identity to each one and choose which knowledge bases to use.
            </p>
          </div>
        </div>

        {loading ? (
          <p className="cc-loading">Loading…</p>
        ) : allAccessibleBots.length === 0 ? (
          <div className="cc-bots-empty">
            <p>No bots available. Create a bot above, or ask your admin to share one with you.</p>
          </div>
        ) : (
          <div className="cc-bots-table-wrap">
            <table className="cc-bots-table">
              <thead>
                <tr>
                  <th className="cc-th-bot">Bot</th>
                  <th className="cc-th-access">Access Mode</th>
                  <th style={{ minWidth: 160 }}>Your Slack ID</th>
                  <th className="cc-th-knowledge">Your KBs</th>
                  <th className="cc-th-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {allAccessibleBots.map((bot) => {
                  const conn = connectionMap.get(bot.id);
                  const linked = conn != null && !conn.slackUserId.startsWith("rapidrag:");
                  return (
                    <tr key={bot.id} className="cc-bot-row">
                      <td className="cc-td-bot">
                        <div className="cc-bot-cell-name">
                          <span className="cc-bot-avatar">{bot.deploymentName.charAt(0).toUpperCase()}</span>
                          <div>
                            <strong className="cc-bot-name">{bot.deploymentName}</strong>
                            <span className="cc-bot-meta">{bot.slackWorkspaceName ?? "Workspace not linked"}</span>
                          </div>
                        </div>
                      </td>
                      <td className="cc-td-access">
                        <span className={`tpl-badge ${bot.requireUserVerification ? "tpl-badge-category" : "tpl-badge-shared"}`}>
                          {bot.requireUserVerification ? "Verified 🔒" : "Open 🌐"}
                        </span>
                      </td>
                      <td>
                        {linked ? (
                          <code style={{ fontSize: 12 }}>{conn!.slackUserId}</code>
                        ) : (
                          <span style={{ color: "#d97706", fontWeight: 600, fontSize: 13 }}>Not linked</span>
                        )}
                      </td>
                      <td className="cc-td-knowledge cc-bot-cell-muted">
                        {linked && conn!.kbIds.length > 0
                          ? conn!.kbIds.length === 1 ? "1 KB" : `${conn!.kbIds.length} KBs`
                          : "—"}
                      </td>
                      <td className="cc-td-actions">
                        <div className="cc-bot-cell-actions">
                          <button
                            type="button"
                            className={linked ? "cc-bot-action" : "cc-bot-action cc-bot-action-primary"}
                            onClick={() => setConnectToBot(bot)}
                          >
                            {linked ? "Update" : "Connect"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Modals / drawers ─────────────────────────────────────────── */}
      {modalDeployment !== undefined ? (
        <ConnectSlackWizard
          existing={modalDeployment}
          onClose={() => setModalDeployment(undefined)}
          onSaved={() => { void load(); setModalDeployment(undefined); }}
        />
      ) : null}

      {connectToBot !== null ? (
        <ConnectSlackWizard
          connectTo={connectToBot}
          onClose={() => setConnectToBot(null)}
          onSaved={() => { void load(); setConnectToBot(null); }}
        />
      ) : null}

      {viewDeployment !== null ? (
        <SlackDeploymentViewModal
          deployment={viewDeployment}
          onClose={() => setViewDeployment(null)}
        />
      ) : null}

      {membersDeployment !== null ? (
        <SlackMembersPanel
          deployment={membersDeployment}
          onClose={() => setMembersDeployment(null)}
        />
      ) : null}
    </div>
  );
}
