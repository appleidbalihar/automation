"use client";

import { useMemo, type ReactElement } from "react";
import type { SlackDeployment } from "./types";

interface Props {
  deployment: SlackDeployment;
  onClose: () => void;
}

function CopyRow({ label, value }: { label: string; value: string }): ReactElement {
  function copyText(): void {
    navigator.clipboard?.writeText(value).catch(() => undefined);
  }
  return (
    <div style={{ marginBottom: 10 }}>
      <p style={{ margin: "0 0 3px", fontSize: 12, color: "#64748b", fontWeight: 600 }}>{label}</p>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          className="tpl-input"
          readOnly
          value={value}
          style={{ fontFamily: "monospace", fontSize: 12, background: "#f8fafc" }}
        />
        <button type="button" className="ops-btn ops-btn-sm ops-btn-ghost" onClick={copyText}>Copy</button>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactElement | string }): ReactElement {
  return (
    <div style={{ display: "flex", gap: 12, marginBottom: 10, alignItems: "flex-start" }}>
      <span style={{ minWidth: 130, fontSize: 12, color: "#64748b", fontWeight: 600, paddingTop: 2 }}>{label}</span>
      <span style={{ fontSize: 13 }}>{value}</span>
    </div>
  );
}

export function SlackDeploymentViewModal({ deployment, onClose }: Props): ReactElement {
  const { webhookUrl, oauthRedirectUrl } = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return {
      webhookUrl: `${origin}/api/slack/events/${deployment.id}`,
      oauthRedirectUrl: `${origin}/api/slack/oauth/callback`
    };
  }, [deployment.id]);

  const statusTone = deployment.status === "active" ? "#059669" : deployment.status === "error" ? "#dc2626" : "#64748b";
  const statusLabel = deployment.status === "active" ? "● Active" : deployment.status === "pending" ? "◐ Pending" : deployment.status === "error" ? "✕ Error" : "○ Disabled";

  const accessMode = deployment.requireUserVerification
    ? <span className="tpl-badge tpl-badge-category">Verified 🔒</span>
    : <span className="tpl-badge tpl-badge-shared">Open 🌐</span>;

  const shareLabel = deployment.shareScope === "all"
    ? "All RapidRAG users"
    : deployment.shareScope === "specific"
      ? "Specific users"
      : "Private (owner only)";

  const kbNames = deployment.requireUserVerification
    ? deployment.kbMappings.map((kb) => kb.knowledgeBaseName).join(", ") || "None"
    : (deployment.defaultKbIds?.length ?? 0) > 0
      ? `${deployment.defaultKbIds?.length} default KB(s)`
      : "None";

  return (
    <div className="ops-modal-overlay" role="presentation" onClick={onClose}>
      <div className="ops-modal-panel" role="dialog" aria-modal="true" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="ops-modal-panel-header">
          <h2>Bot Configuration</h2>
          <button type="button" className="ops-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ops-modal-form" style={{ gap: 0 }}>
          <div style={{ marginBottom: 16 }}>
            <Row label="Name" value={deployment.deploymentName} />
            <Row label="Status" value={<span style={{ color: statusTone, fontWeight: 600 }}>{statusLabel}</span>} />
            <Row label="Workspace" value={deployment.slackWorkspaceName ?? "Not linked"} />
            <Row label="Access mode" value={accessMode} />
            <Row label="Share scope" value={shareLabel} />
            <Row label="Knowledge bases" value={kbNames} />
            {deployment.slackWorkspaceId && <Row label="Slack workspace ID" value={deployment.slackWorkspaceId} />}
          </div>

          <div style={{ background: "#f0fdf4", border: "1px solid #6ee7b7", borderRadius: 8, padding: "12px 14px", marginBottom: 16 }}>
            <p style={{ margin: "0 0 10px", fontSize: 13, fontWeight: 700, color: "#065f46" }}>Slack App URLs</p>
            <CopyRow label="Event Subscriptions Request URL" value={webhookUrl} />
            <CopyRow label="Slash Command /kb Request URL" value={webhookUrl} />
            <CopyRow label="OAuth Redirect URL (OAuth & Permissions)" value={oauthRedirectUrl} />
            {deployment.slackBotUserId && (
              <CopyRow label="Bot User ID (to find bot in Slack)" value={deployment.slackBotUserId} />
            )}
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "#047857" }}>
              Paste each URL into the matching section of your Slack app settings at api.slack.com/apps.
            </p>
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "#047857" }}>
              <strong>Required bot event:</strong> In Event Subscriptions → Subscribe to bot events → <strong>Add Bot User Event</strong> → add <code>message.im</code>. Without this, DM messages will not be delivered.
            </p>
          </div>

          {deployment.requireUserVerification && (
            <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 16px" }}>
              Verified mode — members connect their Slack ID via the Members panel. Each user gets answers from their own knowledge bases.
            </p>
          )}
          {!deployment.requireUserVerification && (
            <p style={{ fontSize: 12, color: "#64748b", margin: "0 0 16px" }}>
              Open access mode — any Slack user who messages this bot receives answers from the configured default knowledge bases. No per-user registration required.
            </p>
          )}

          <div className="ops-modal-footer">
            <button type="button" className="ops-btn ops-btn-primary" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}
