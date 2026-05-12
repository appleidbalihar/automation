"use client";

import type { ReactElement } from "react";
import type { SlackDeployment } from "./types";

interface Props {
  deployment: SlackDeployment;
  onEdit: (deployment: SlackDeployment) => void;
  onDeactivate: (deployment: SlackDeployment) => void;
  onDelete: (deployment: SlackDeployment) => void;
}

export function SlackDeploymentCard({ deployment, onEdit, onDeactivate, onDelete }: Props): ReactElement {
  const isActive = deployment.status === "active";
  const isPending = deployment.status === "pending";

  const statusTone = isActive ? "active" : isPending ? "pending" : deployment.status === "error" ? "error" : "disabled";
  const statusLabel = isActive ? "● Active" : isPending ? "◐ Pending" : deployment.status === "error" ? "✕ Error" : "○ Disabled";

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

      {/* Knowledge */}
      <td className="cc-td-knowledge">
        <div className="cc-bot-cell-kb">
          <span className="cc-bot-access-primary">
            {deployment.accessMode === "allowlist"
              ? `Allowlist (${deployment.allowedSlackUserIds?.length ?? 0} users)`
              : "All users in workspace"}
          </span>
          {deployment.kbMappings.length > 0 && (
            <span className="cc-bot-kb-names">
              {deployment.kbMappings.map((kb) => kb.knowledgeBaseName).join(", ")}
            </span>
          )}
        </div>
      </td>

      {/* Actions */}
      <td className="cc-td-actions">
        <div className="cc-bot-cell-actions">
          <button
            type="button"
            className="cc-bot-action cc-bot-action-ghost"
            onClick={() => onEdit(deployment)}
          >
            Edit
          </button>
          {isActive ? (
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
              onClick={() => onDeactivate(deployment)}
            >
              Activate
            </button>
          )}
          <button
            type="button"
            className="cc-bot-action cc-bot-action-delete"
            onClick={() => onDelete(deployment)}
          >
            Delete
          </button>
        </div>
      </td>
    </tr>
  );
}
