"use client";

import type { ReactElement } from "react";
import { useMemo } from "react";
import type { Integration } from "./types";
import { formatDate, hasFailedDifyIndexing, syncDisabledReason } from "./types";

type Props = {
  integrations: Integration[];
  busy: string;
  onSetDefault: (id: string) => void;
  onSync: (id: string) => void;
  onRetryFailedIndexing: (id: string, options?: { syncJobId?: string; documentIds?: string[] }) => void;
  onCancelSync: (id: string) => void;
  onEdit: (integration: Integration) => void;
  onDelete: (id: string) => void;
  onCleanup: (id: string) => void;
  onShare: (id: string) => void;
  status: string;
  error: string;
  onCreateSource: () => void;
};

function authBadge(authMethod: "oauth" | "pat" | null, credentialConfigured: boolean): ReactElement {
  if (authMethod === "oauth") {
    return <span className="integrations-badge integrations-badge-good">🔗 OAuth</span>;
  }
  if (credentialConfigured) {
    return <span className="integrations-badge integrations-badge-good">🔑 PAT</span>;
  }
  return <span className="integrations-badge integrations-badge-warn">No token</span>;
}

/** Resolve the effective paths to display: prefer sourcePaths array, fall back to legacy sourcePath string. */
function resolvePaths(integration: Integration): string[] {
  if (integration.sourcePaths && integration.sourcePaths.length > 0) return integration.sourcePaths;
  if (integration.sourcePath) return [integration.sourcePath];
  return [];
}

export function KnowledgeSourcesTable(props: Props): ReactElement {
  const { integrations, busy, onSetDefault, onSync, onRetryFailedIndexing, onCancelSync, onEdit, onDelete, onCleanup, onShare, status, error, onCreateSource } = props;

  const sortedIntegrations = useMemo(
    () => [...integrations].sort((a, b) => Number(b.isDefault) - Number(a.isDefault)),
    [integrations]
  );

  return (
    <section className="integrations-panel">
      <div className="integrations-panel-header ops-sources-header">
        <div>
          <h2>My Knowledge Sources</h2>
          <p>Source details, readiness, sync state, and actions are all managed in one place.</p>
        </div>
        <div className="ops-sources-header-right">
          <button type="button" className="sync-btn-ready ops-create-source-btn" onClick={onCreateSource}>
            + Create Source
          </button>
          <div className="integrations-status-stack">
            {status ? <span className="integrations-status-success">{status}</span> : null}
            {error ? <span className="integrations-status-error">{error}</span> : null}
          </div>
        </div>
      </div>

      {sortedIntegrations.length === 0 ? (
        <div className="integrations-empty-state">
          <strong>No sources connected yet.</strong>
          <span>Use &quot;+ Create Source&quot; to add your first knowledge source.</span>
        </div>
      ) : (
        <div className="integrations-table-wrap">
          <table className="integrations-table">
            <thead>
              <tr>
                <th>Source</th>
                <th>Project</th>
                <th>Type</th>
                <th>Location</th>
                <th>Auth</th>
                <th>Status</th>
                <th>Latest Sync</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedIntegrations.map((integration) => {
                const job = integration.latestSyncJob;
                const syncRunning = job && ["running", "pending"].includes(String(job.status).toLowerCase());
                const canRetryIndexing = hasFailedDifyIndexing(job);
                const paths = resolvePaths(integration);

                return (
                  <tr key={integration.id}>
                    {/* Source name */}
                    <td>
                      <div className="integrations-source-cell">
                        <strong>
                          {integration.name}
                          {integration.isDefault ? <span className="ops-default-chip"> Default</span> : null}
                        </strong>
                        <span className="ops-source-desc">{integration.description || "No description provided."}</span>
                      </div>
                    </td>

                    {/* Project name */}
                    <td>
                      {integration.projectName ? (
                        <span className="ops-project-chip">{integration.projectName}</span>
                      ) : (
                        <span className="ops-source-desc">—</span>
                      )}
                    </td>

                    {/* Type */}
                    <td>
                      <span className="ops-type-chip">{integration.sourceType}</span>
                    </td>

                    {/* Location */}
                    <td>
                      <div className="integrations-location-cell">
                        <span className="ops-url-text">{integration.sourceUrl}</span>
                        {integration.sourceBranch ? (
                          <small className="ops-branch-label">⎇ {integration.sourceBranch}</small>
                        ) : null}
                        {paths.length > 0 ? (
                          <div className="ops-paths-list">
                            {paths.map((p, idx) => (
                              <small key={idx} className="ops-path-item">📁 {p}</small>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    </td>

                    {/* Auth method */}
                    <td>{authBadge(integration.authMethod, integration.credentialConfigured)}</td>

                    {/* Readiness */}
                    <td>
                      <div className="ops-status-stack">
                        <span className={`integrations-badge${integration.chatReady ? " integrations-badge-good" : " integrations-badge-bad"}`}>
                          {integration.chatReady ? "Ready" : "Awaiting provisioning"}
                        </span>
                        {!integration.workflowAssigned ? (
                          <span className="integrations-badge integrations-badge-bad">No workflow</span>
                        ) : null}
                      </div>
                    </td>

                    {/* Latest sync */}
                    <td>
                      <div className="integrations-sync-cell">
                        <span>{job ? job.status : "Never run"}</span>
                        <small>{formatDate(job?.createdAt ?? job?.startedAt)}</small>
                        {job ? (
                          <small>
                            {job.filesProcessed ?? 0}
                            {job.filesTotal != null ? ` / ${job.filesTotal}` : ""} files
                          </small>
                        ) : null}
                        {job?.errorMessage ? <em className="ops-sync-error">{job.errorMessage}</em> : null}
                      </div>
                    </td>

                    {/* Actions */}
                    <td>
                      <div className="ops-row-actions">
                        {syncRunning ? (
                          <button
                            type="button"
                            className="ops-action-btn ops-action-cancel"
                            onClick={() => void onCancelSync(integration.id)}
                            disabled={busy === `cancel:${integration.id}`}
                          >
                            {busy === `cancel:${integration.id}` ? "…" : "Cancel"}
                          </button>
                        ) : (
                          <>
                            {canRetryIndexing ? (
                              <button
                                type="button"
                                className="ops-action-btn ops-action-retry"
                                onClick={() => void onRetryFailedIndexing(integration.id)}
                                disabled={busy === `retry-indexing:${integration.id}`}
                                title="Retry only the Dify documents that failed indexing"
                              >
                                {busy === `retry-indexing:${integration.id}` ? "…" : "Retry indexing"}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={`ops-action-btn${integration.syncReady ? " ops-action-sync" : " ops-action-sync-disabled"}`}
                              onClick={() => void onSync(integration.id)}
                              disabled={!integration.syncReady || busy === `sync:${integration.id}`}
                              title={integration.syncReady ? "Trigger a full sync for this knowledge source" : syncDisabledReason(integration)}
                            >
                              {busy === `sync:${integration.id}` ? "Syncing…" : "⟳ Sync"}
                            </button>
                          </>
                        )}

                        <button
                          type="button"
                          className="ops-action-btn ops-action-edit"
                          onClick={() => onEdit(integration)}
                          title="Edit source settings"
                        >
                          Edit
                        </button>

                        {/* Share — allow owner/admin to grant chat access to other users */}
                        <button
                          type="button"
                          className="ops-action-btn ops-action-share"
                          onClick={() => onShare(integration.id)}
                          title="Share this knowledge base with other users (chat access only)"
                        >
                          🔗 Share
                        </button>

                        {!integration.isDefault ? (
                          <button
                            type="button"
                            className="ops-action-btn ops-action-default"
                            onClick={() => void onSetDefault(integration.id)}
                            disabled={busy === `default:${integration.id}`}
                            title="Set as default knowledge base"
                          >
                            {busy === `default:${integration.id}` ? "…" : "Default"}
                          </button>
                        ) : null}

                        {/* Cleanup button — removes all indexed documents for this source */}
                        <button
                          type="button"
                          className="ops-action-btn ops-action-cleanup"
                          onClick={() => void onCleanup(integration.id)}
                          disabled={busy === `cleanup:${integration.id}`}
                          title="Remove all indexed documents and Dify knowledge base data for this source"
                        >
                          {busy === `cleanup:${integration.id}` ? "…" : "🗑 Cleanup"}
                        </button>

                        <button
                          type="button"
                          className="ops-action-btn ops-action-delete"
                          onClick={() => void onDelete(integration.id)}
                          disabled={busy === `delete:${integration.id}`}
                          title="Delete this integration entirely"
                        >
                          {busy === `delete:${integration.id}` ? "…" : "Delete"}
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
    </section>
  );
}
