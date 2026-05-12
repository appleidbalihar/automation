"use client";

import { useEffect, useState, type ReactElement } from "react";
import { deactivateSlackDeployment, deleteSlackDeployment, fetchSlackDeployments } from "./api";
import { ConnectSlackWizard } from "./ConnectSlackWizard";
import { SlackDeploymentCard } from "./SlackDeploymentCard";
import type { SlackDeployment } from "./types";

/** Platform channel cards — shows Slack (live) + coming-soon placeholders */
const CHANNEL_PLATFORMS = [
  { key: "slack",   label: "Slack",          desc: "Bot DMs, channel mentions, slash commands",   status: "live"   },
  { key: "telegram",label: "Telegram",       desc: "Bot API for 1:1 and group chats",             status: "soon"   },
  { key: "gchat",   label: "Google Chat",    desc: "Workspace bot for spaces and DMs",            status: "soon"   },
  { key: "teams",   label: "Microsoft Teams",desc: "Channel & personal scope bot",                status: "soon"   },
] as const;

function PlatformIcon({ platform }: { platform: string }): ReactElement {
  const gradients: Record<string, [string, string]> = {
    slack:    ["#0f766e", "#0891b2"],
    telegram: ["#2b6cb0", "#3182ce"],
    gchat:    ["#065f46", "#0891b2"],
    teams:    ["#4f46e5", "#7c3aed"],
  };
  const labels: Record<string, string> = { slack: "#", telegram: "✈", gchat: "G", teams: "T" };
  const [c1, c2] = gradients[platform] ?? ["#64748b", "#94a3b8"];
  const id = `pg-${platform}`;
  return (
    <span className="cc-platform-icon">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" aria-hidden="true">
        <rect width="36" height="36" rx="10" fill={`url(#${id})`} />
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="36" y2="36" gradientUnits="userSpaceOnUse">
            <stop stopColor={c1} />
            <stop offset="1" stopColor={c2} />
          </linearGradient>
        </defs>
        <text x="18" y="23" textAnchor="middle" fill="#fff" fontSize="13" fontWeight="900" fontFamily="sans-serif">
          {labels[platform] ?? "?"}
        </text>
      </svg>
    </span>
  );
}

export function ChatChannelsPage(): ReactElement {
  const [deployments, setDeployments] = useState<SlackDeployment[]>([]);
  const [modalDeployment, setModalDeployment] = useState<SlackDeployment | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      setDeployments(await fetchSlackDeployments());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function removeDeployment(item: SlackDeployment): Promise<void> {
    if (!window.confirm(`Delete "${item.deploymentName}"? This cannot be undone.`)) return;
    try {
      await deleteSlackDeployment(item.id);
      setDeployments((prev) => prev.filter((d) => d.id !== item.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const hasSlack = deployments.length > 0;

  return (
    <div className="cc-page">
      {/* ── Page header ──────────────────────────────────────────────── */}
      <div className="cc-page-header">
        <div>
          <p className="cc-eyebrow">Integrations</p>
          <h1 className="cc-page-title">Chat Channels</h1>
          <p className="cc-page-subtitle">
            Connect your knowledge bases to Slack and other messaging platforms.
            Telegram and Google Chat are coming soon.
          </p>
        </div>
        <div className="cc-header-actions">
          <button
            type="button"
            className="cc-btn-secondary"
            onClick={() => load()}
            disabled={loading}
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {error ? <p className="cc-error">{error}</p> : null}

      {/* ── Platform cards ───────────────────────────────────────────── */}
      <div className="cc-platform-grid">
        {CHANNEL_PLATFORMS.map((platform) => (
          <div key={platform.key} className="cc-platform-card">
            <div className="cc-platform-card-top">
              <PlatformIcon platform={platform.key} />
              <span className={`cc-status-badge cc-status-${platform.status}`}>
                {platform.status === "live"
                  ? (hasSlack ? "Connected" : "Not connected")
                  : "Coming soon"}
              </span>
            </div>
            <h3 className="cc-platform-name">{platform.label}</h3>
            <p className="cc-platform-desc">{platform.desc}</p>
            {platform.status === "live" ? (
              <button
                type="button"
                className="cc-platform-action"
                onClick={() => setModalDeployment(null)}
              >
                {hasSlack ? "Manage" : "Connect"}
              </button>
            ) : (
              <button type="button" className="cc-platform-action cc-platform-action-muted" disabled>
                Notify me
              </button>
            )}
          </div>
        ))}
      </div>

      {/* ── Connected bots table ──────────────────────────────────────── */}
      <div className="cc-bots-section">
        <div className="cc-bots-header">
          <div>
            <h2 className="cc-bots-title">Connected bots</h2>
            <p className="cc-bots-subtitle">Manage installations, audiences, and KB bindings.</p>
          </div>
        </div>

        {loading ? (
          <p className="cc-loading">Loading deployments…</p>
        ) : deployments.length === 0 ? (
          <div className="cc-bots-empty">
            <p>No Slack bots connected yet.</p>
            <button
              type="button"
              className="cc-btn-primary"
              onClick={() => setModalDeployment(null)}
            >
              + Connect Slack
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
                  <th className="cc-th-knowledge">Knowledge</th>
                  <th className="cc-th-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {deployments.map((deployment) => (
                  <SlackDeploymentCard
                    key={deployment.id}
                    deployment={deployment}
                    onEdit={(item) => setModalDeployment(item)}
                    onDeactivate={(item) =>
                      deactivateSlackDeployment(item.id)
                        .then(load)
                        .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                    }
                    onDelete={(item) => removeDeployment(item).catch((err) => setError(err instanceof Error ? err.message : String(err)))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── CTA banner + Security panel ──────────────────────────────── */}
      <div className="cc-bottom-grid">
        <div className="cc-cta-banner">
          <span className="cc-cta-badge">✦ New</span>
          <h2 className="cc-cta-title">
            Bring RapidRAG into <span className="cc-cta-accent">every conversation</span>
          </h2>
          <p className="cc-cta-body">
            Install the Slack app, choose your knowledge bases, and your team can ask
            questions right where they already work.
          </p>
          <div className="cc-cta-actions">
            <button
              type="button"
              className="cc-cta-btn-primary"
              onClick={() => setModalDeployment(null)}
            >
              ⊞ Add to Slack
            </button>
            <a href="https://rapidrag.io/docs/slack" target="_blank" rel="noreferrer" className="cc-cta-btn-ghost">
              Read the guide →
            </a>
          </div>
        </div>

        <div className="cc-security-panel">
          <div className="cc-security-header">
            <span className="cc-security-icon">◎</span>
            <h3 className="cc-security-title">Security &amp; scopes</h3>
          </div>
          <p className="cc-security-body">
            Bots use OAuth with the minimum scopes required:{" "}
            <code>chat:write</code>, <code>im:history</code>, <code>users:read</code>.
          </p>
          <a href="https://rapidrag.io/docs/slack-permissions" target="_blank" rel="noreferrer" className="cc-security-link">
            Review permissions →
          </a>
        </div>
      </div>

      {/* ── Modals / drawers ─────────────────────────────────────────── */}
      {modalDeployment !== undefined ? (
        <ConnectSlackWizard
          existing={modalDeployment}
          onClose={() => setModalDeployment(undefined)}
          onSaved={() => load()}
        />
      ) : null}
    </div>
  );
}
