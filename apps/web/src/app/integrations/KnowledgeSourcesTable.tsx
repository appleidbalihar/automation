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
  /** Optional: if provided, shows the System Prompt config button (admin/useradmin only). */
  onConfigurePrompt?: (id: string) => void;
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
  const { integrations, busy, onSetDefault, onSync, onRetryFailedIndexing, onCancelSync, onEdit, onDelete, onCleanup, onShare, onConfigurePrompt, status, error, onCreateSource } = props;

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
            {status ? <p className="ops-status-ok">{status}</p> : null}
            {error ? <p className="ops-status-error">{error}</p> : null}
          </div>
        </div>
      </div>

      {integrations.length === 0 ? (
        <div className="integrations-empty">
          <p>No sources yet. Create your first knowledge source to get started.</p>
        </div>
      ) : (
        <div className="integrations-table-wrap">
          <table className="integrations-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Source</th>
                <th>Auth</th>
                <th>Status</th>
                <th>Last Sync</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedIntegrations.map((integration) => {
                const paths = resolvePaths(integration);
                const latestJob = integration.latestSyncJob;
                const syncStatus = latestJob?.status ?? "never_synced";
                const isActiveSync = syncStatus === "running" || syncStatus === "pending";
                const failedIndexing = hasFailedDifyIndexing(latestJob);

                return (
                  <tr key={integration.id} className={integration.isDefault ? "integrations-row-default" : ""}>
                    <td>
                      <div className="integrations-name-cell">
                        <span className="integrations-name">{integration.name}</span>
                        {integration.isDefault ? (
                          <span className="integrations-badge integrations-badge-default">Default</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      <div className="integrations-source-cell">
                        <span className="integrations-source-type">{integration.sourceType}</span>
                        <a
                          href={integration.sourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="integrations-source-url"
                          title={integration.sourceUrl}
                        >
                          {integration.sourceUrl.replace(/^https?:\/\//, "").slice(0, 40)}
                          {integration.sourceUrl.length > 47 ? "…" : ""}
                        </a>
                        {integration.sourceBranch ? (
                          <span className="integrations-source-branch">@{integration.sourceBranch}</span>
                        ) : null}
                        {paths.length > 0 ? (
                          <span className="integrations-source-paths" title={paths.join(", ")}>
                            {paths.slice(0, 2).join(", ")}{paths.length > 2 ? ` +${paths.length - 2}` : ""}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td>{authBadge(integration.authMethod, integration.credentialConfigured)}</td>
                    <td>
                      <div className="integrations-status-cell">
                        {integration.chatReady ? (
                          <span className="integrations-badge integrations-badge-good">Chat ready</span>
                        ) : (
                          <span className="integrations-badge integrations-badge-warn">Not ready</span>
                        )}
                        {syncStatus === "completed" ? (
                          <span className="integrations-badge integrations-badge-good">Synced</span>
                        ) : syncStatus === "failed" ? (
                          <span className="integrations-badge integrations-badge-bad" title={latestJob?.errorMessage ?? undefined}>
                            Sync failed
                          </span>
                        ) : syncStatus === "running" || syncStatus === "pending" ? (
                          <span className="integrations-badge integrations-badge-running">Syncing…</span>
                        ) : null}
                        {failedIndexing ? (
                          <span className="integrations-badge integrations-badge-warn">Indexing errors</span>
                        ) : null}
                      </div>
                    </td>
                    <td>
                      {latestJob?.completedAt ? formatDate(latestJob.completedAt) : "Never"}
                    </td>
                    <td>
                      <div className="integrations-actions">
                        {isActiveSync ? (
                          <button
                            type="button"
                            className="ops-action-btn ops-action-cancel"
                            onClick={() => onCancelSync(integration.id)}
                            disabled={busy === `cancel:${integration.id}`}
                            title="Cancel running sync"
                          >
                            {busy === `cancel:${integration.id}` ? "…" : "Cancel"}
                          </button>
                        ) : (
                          <>
                            {failedIndexing ? (
                              <button
                                type="button"
                                className="ops-action-btn ops-action-retry"
                                onClick={() => onRetryFailedIndexing(integration.id)}
                                disabled={busy === `retry:${integration.id}` || !integration.syncReady}
                                title="Retry failed Dify indexing for this source"
                              >
                                {busy === `retry:${integration.id}` ? "Retrying…" : "↺ Retry"}
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={integration.syncReady ? "ops-action-btn ops-action-sync" : "ops-action-btn ops-action-sync ops-action-btn-disabled"}
                              onClick={() => integration.syncReady ? onSync(integration.id) : undefined}
                              disabled={busy === `sync:${integration.id}` || !integration.syncReady}
                              title={integration.syncReady ? "Sync documents from source" : syncDisabledReason(integration)}
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

                        {/* System Prompt — admin/useradmin only, configure per-KB prompt */}
                        {onConfigurePrompt ? (
                          <button
                            type="button"
                            className="ops-action-btn ops-action-prompt"
                            onClick={() => onConfigurePrompt(integration.id)}
                            title="Configure system prompt for this knowledge base (admin/useradmin only)"
                          >
                            🤖 Prompt
                          </button>
                        ) : null}

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
