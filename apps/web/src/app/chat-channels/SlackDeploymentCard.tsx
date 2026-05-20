"use client";

import type { ReactElement } from "react";
import type { SlackDeployment } from "./types";

interface Props {
  deployment: SlackDeployment;
  isOwner?: boolean;
  onView: (deployment: SlackDeployment) => void;
  onEdit: (deployment: SlackDeployment) => void;
  onMembers: (deployment: SlackDeployment) => void;
  onDeactivate: (deployment: SlackDeployment) => void;
  onDelete: (deployment: SlackDeployment) => void;
}

export function SlackDeploymentCard({ deployment, isOwner = true, onView, onEdit, onMembers, onDeactivate, onDelete }: Props): ReactElement {
  const isActive = deployment.status === "active";
  const isPending = deployment.status === "pending";

  const statusTone = isActive ? "active" : isPending ? "pending" : deployment.status === "error" ? "error" : "disabled";
  const statusLabel = isActive ? "● Active" : isPending ? "◐ Pending" : deployment.status === "error" ? "✕ Error" : "○ Disabled";

  const accessModeLabel = deployment.requireUserVerification ? "Verified 🔒" : "Open 🌐";
  const shareLabel = deployment.shareScope === "all" ? "Shared with all" : deployment.shareScope === "specific" ? "Shared" : "Private";

  return (
    <tr className="cc-bot-row">
      {/* Bot */}
      <td className="cc-td-bot">
        <div className="cc-bot-cell-name">
          <span className="cc-bot-avatar">
            {deployment.deploymentName.charAt(0).toUpperCase()}
          </span>
          <div>
            <strong className="cc-bot-name">{deployment.deploymentName}</strong>
            <span className="cc-bot-meta">
              {deployment.slackWorkspaceName ?? "Workspace not linked"}
              {deployment.slackChannelName ? ` · #${deployment.slackChannelName}` : ""}
            </span>
          </div>
        </div>
      </td>

      {/* Status */}
      <td className="cc-td-status">
        <span className={`cc-bot-status cc-bot-status-${statusTone}`}>{statusLabel}</span>
      </td>

      {/* Install */}
      <td className="cc-td-install cc-bot-cell-muted">
        {deployment.installMode === "oauth" ? "OAuth install" : "Manual app"}
      </td>

      {/* Access Mode */}
      <td className="cc-td-access">
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <span className="tpl-badge tpl-badge-category">{accessModeLabel}</span>
          <span className="tpl-badge tpl-badge-shared" style={{ fontSize: 11 }}>{shareLabel}</span>
        </div>
      </td>

      {/* Knowledge */}
      <td className="cc-td-knowledge">
        <div className="cc-bot-cell-kb">
          {deployment.kbMappings.length > 0 && (
            <span className="cc-bot-kb-names">
              {deployment.kbMappings.map((kb) => kb.knowledgeBaseName).join(", ")}
            </span>
          )}
          {deployment.kbMappings.length === 0 && (
            <span className="cc-bot-cell-muted">No KBs mapped</span>
          )}
        </div>
      </td>

      {/* Actions */}
      <td className="cc-td-actions">
        <div className="cc-bot-cell-actions">
          <button
            type="button"
            className="cc-bot-action cc-bot-action-ghost"
            onClick={() => onView(deployment)}
          >
            View
          </button>
          {isOwner && (
            <button
              type="button"
              className="cc-bot-action cc-bot-action-ghost"
              onClick={() => onEdit(deployment)}
            >
              Edit
            </button>
          )}
          {isOwner && deployment.requireUserVerification && isActive && (
            <button
              type="button"
              className="cc-bot-action cc-bot-action-ghost"
              onClick={() => onMembers(deployment)}
            >
              Members
            </button>
          )}
          {isOwner && (isActive ? (
            <button
              type="button"
              className="cc-bot-action cc-bot-action-warn"
              onClick={() => onDeactivate(deployment)}
            >
              Deactivate
            </button>
          ) : (
            <button
              type="button"
              className="cc-bot-action cc-bot-action-primary"
              onClick={() => onEdit(deployment)}
            >
              Activate
            </button>
          ))}
          {isOwner && (
            <button
              type="button"
              className="cc-bot-action cc-bot-action-delete"
              onClick={() => onDelete(deployment)}
            >
              Delete
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
