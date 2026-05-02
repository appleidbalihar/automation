"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchSyncHistory, fetchSyncStatus, isActiveSyncStatus } from "./api";
import { StepLogDrawer } from "./StepLogDrawer";
import type { Integration, SyncJob } from "./types";
import { formatDate, isFailedDifyIndexingStep, normalizeSyncSteps, stepBadgeVariant, stepStatusEmoji } from "./types";

type Props = {
  integrations: Integration[];
  onMergeSyncJob: (knowledgeBaseId: string, job: SyncJob) => void;
  onRetryFailedIndexing: (knowledgeBaseId: string, options?: { syncJobId?: string; documentIds?: string[] }) => void;
  busy: string;
};

function isNeverSynced(x: unknown): x is { status: "never_synced"; knowledgeBaseId: string } {
  return Boolean(x && typeof x === "object" && (x as { status?: string }).status === "never_synced");
}

export function SyncProcessMonitor(props: Props): ReactElement | null {
  const { integrations, onMergeSyncJob, onRetryFailedIndexing, busy } = props;

  const [kbId, setKbId] = useState<string>("");
  const [historyJobs, setHistoryJobs] = useState<SyncJob[]>([]);
  const [selectedHistoryJobId, setSelectedHistoryJobId] = useState<string | "latest">("latest");
  const [polledJob, setPolledJob] = useState<SyncJob | null>(null);
  const [logDrawer, setLogDrawer] = useState<{ syncJobId: string; stepName: string | null } | null>(null);

  const sortedIntegrations = useMemo(
    () => [...integrations].sort((left, right) => Number(right.isDefault) - Number(left.isDefault)),
    [integrations]
  );

  const pickDefaultKbId = useCallback((): string => {
    const withLatest = sortedIntegrations.find((i) => i.latestSyncJob != null);
    return withLatest?.id ?? sortedIntegrations[0]?.id ?? "";
  }, [sortedIntegrations]);

  useEffect(() => {
    if (kbId && sortedIntegrations.some((i) => i.id === kbId)) return;
    setKbId(pickDefaultKbId());
  }, [sortedIntegrations, kbId, pickDefaultKbId]);

  const selectedKb = useMemo(() => sortedIntegrations.find((i) => i.id === kbId) ?? null, [sortedIntegrations, kbId]);

  const loadHistory = useCallback(async (id: string) => {
    if (!id) {
      setHistoryJobs([]);
      return;
    }
    try {
      const res = await fetchSyncHistory(id, 10);
      setHistoryJobs(res.jobs ?? []);
    } catch {
      setHistoryJobs([]);
    }
  }, []);

  useEffect(() => {
    void loadHistory(kbId);
  }, [kbId, loadHistory]);

  const latestJob = selectedKb?.latestSyncJob ?? null;

  const baseJob: SyncJob | null = useMemo(() => {
    if (selectedHistoryJobId === "latest") return latestJob;
    return historyJobs.find((j) => j.id === selectedHistoryJobId) ?? latestJob;
  }, [selectedHistoryJobId, historyJobs, latestJob]);

  const effectiveJob: SyncJob | null = useMemo(() => {
    if (!baseJob) return null;
    if (polledJob && polledJob.id === baseJob.id) {
      return { ...baseJob, ...polledJob };
    }
    return baseJob;
  }, [baseJob, polledJob]);

  useEffect(() => {
    setPolledJob(null);
  }, [selectedHistoryJobId, kbId]);

  const hasAnyLatest = useMemo(() => integrations.some((i) => i.latestSyncJob != null), [integrations]);
  const showForHistory = historyJobs.length > 0;
  const visible = hasAnyLatest || showForHistory;

  const pollActive = Boolean(effectiveJob && isActiveSyncStatus(effectiveJob.status));
  const viewingJobId = effectiveJob?.id ?? null;

  useEffect(() => {
    if (!kbId || !pollActive || !viewingJobId) return;

    const run = () => {
      void (async () => {
        try {
          const res = await fetchSyncStatus(kbId);
          if (isNeverSynced(res)) return;
          const job = res as SyncJob;
          onMergeSyncJob(kbId, job);
          if (job.id === viewingJobId) setPolledJob(job);
        } catch {
          /* ignore */
        }
      })();
    };

    run();
    const id = window.setInterval(run, 3000);
    return () => window.clearInterval(id);
  }, [kbId, pollActive, viewingJobId, onMergeSyncJob]);

  if (!visible || sortedIntegrations.length === 0) return null;

  const steps = normalizeSyncSteps(effectiveJob?.stepsJson);
  const filesTotal = effectiveJob?.filesTotal ?? 0;
  const filesProcessed = effectiveJob?.filesProcessed ?? 0;
  const progressPct = filesTotal > 0 ? Math.min(100, Math.round((filesProcessed / filesTotal) * 100)) : 0;

  // Check if ANY integration currently has an active sync (for the background banner)
  const anyActiveSyncKbId = integrations.find((i) => {
    const job = i.latestSyncJob;
    return job && isActiveSyncStatus(job.status);
  })?.id ?? null;

  // If the currently viewed KB is not the one with an active sync,
  // and the monitor is showing a different (non-active) KB, show a banner.
  const backgroundSyncRunning = anyActiveSyncKbId !== null && anyActiveSyncKbId !== kbId;
  const backgroundSyncKb = backgroundSyncRunning
    ? integrations.find((i) => i.id === anyActiveSyncKbId) ?? null
    : null;

  return (
    <section className="integrations-panel ops-sync-monitor">
      {/* Banner: a sync is running in background on a different KB */}
      {backgroundSyncRunning && backgroundSyncKb ? (
        <div className="ops-bg-sync-banner">
          <span className="ops-bg-sync-spinner">🔄</span>
          <span>
            Sync running in background for <strong>{backgroundSyncKb.name}</strong>
            {backgroundSyncKb.projectName ? ` (${backgroundSyncKb.projectName})` : ""} —
            <button
              type="button"
              className="ops-bg-sync-switch-btn"
              onClick={() => { setKbId(anyActiveSyncKbId); setSelectedHistoryJobId("latest"); }}
            >
              Switch to view progress
            </button>
          </span>
        </div>
      ) : null}

      <div className="integrations-panel-header ops-sync-monitor-header">
        <div>
          <h2>Sync Process Monitor</h2>
          <p>Live steps from n8n, log drill-down, and sync history. Syncs continue running even if you navigate away.</p>
        </div>
        <div className="ops-sync-monitor-controls">
          <label className="ops-sync-monitor-select">
            <span>Knowledge base</span>
            <select
              value={kbId}
              onChange={(event) => {
                setKbId(event.target.value);
                setSelectedHistoryJobId("latest");
              }}
            >
              {sortedIntegrations.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="ops-sync-monitor-select">
            <span>Sync job</span>
            <select
              value={selectedHistoryJobId}
              onChange={(event) => {
                const v = event.target.value;
                setSelectedHistoryJobId(v === "latest" ? "latest" : v);
              }}
            >
              <option value="latest">Latest{latestJob ? ` (${latestJob.status})` : ""}</option>
              {historyJobs.map((j) => {
                const trigger = String((j as any).trigger ?? "sync");
                const typeIcon = trigger === "cleanup" ? "🗑" : trigger === "retry_failed_indexing" ? "🔁" : "🔄";
                return (
                  <option key={j.id} value={j.id}>
                    {typeIcon} {formatDate(j.createdAt ?? j.startedAt)} — {j.status}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
      </div>

      <div className="ops-sync-monitor-title-row">
        <h3 className="ops-sync-monitor-kb-title">{selectedKb?.name ?? "—"}</h3>
        <div className="ops-sync-progress-bar" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
          <div className="ops-sync-progress-bar-fill" style={{ width: `${filesTotal > 0 ? progressPct : 0}%` }} />
        </div>
        <span className="ops-sync-progress-label">
          {filesTotal > 0 ? `${filesProcessed} / ${filesTotal} files` : `${filesProcessed} files processed`}
        </span>
      </div>

      {effectiveJob?.errorMessage && !isActiveSyncStatus(effectiveJob.status) ? (
        <p className="integrations-status-error ops-sync-job-error">{effectiveJob.errorMessage}</p>
      ) : null}

      <div className="integrations-table-wrap ops-sync-step-wrap">
        <table className="integrations-table ops-sync-step-table">
          <thead>
            <tr>
              <th>Task</th>
              <th>Status</th>
              <th>Started</th>
              <th>Duration</th>
              <th aria-label="Logs" />
            </tr>
          </thead>
          <tbody>
            {effectiveJob && steps.length === 0 ? (
              <tr>
                <td colSpan={5} className="ops-sync-step-empty">
                  No step entries yet. When n8n reports steps to <code>stepsJson</code>, they appear here.
                </td>
              </tr>
            ) : null}
            {steps.map((step) => {
              const variant = stepBadgeVariant(step.status);
              const isErr = variant === "failed" || Boolean(step.errorMessage);
              const canRetryIndexing = isErr && isFailedDifyIndexingStep(step) && effectiveJob?.status === "failed" && Boolean(kbId);

              // Detect smart-sync / cleanup operation type for visual differentiation
              const isCleanupStep = step.logStepName.startsWith("cleanup_") || step.task.startsWith("Cleanup:");
              const isIndexStep = step.logStepName.startsWith("index_path_") || step.task.startsWith("Index:");
              const isProjectNameStep = step.logStepName === "update_project_name";

              return (
                <tr key={step.key} className={isErr ? "is-error" : undefined}>
                  <td>
                    <div className="ops-sync-task-cell">
                      <div className="ops-sync-task-name-row">
                        {isCleanupStep ? <span className="ops-step-op-badge ops-step-op-cleanup">🗑 Cleanup</span> : null}
                        {isIndexStep ? <span className="ops-step-op-badge ops-step-op-index">📥 Index</span> : null}
                        {isProjectNameStep ? <span className="ops-step-op-badge ops-step-op-meta">🏷 Metadata</span> : null}
                        <span>{step.task}</span>
                      </div>
                      {step.errorMessage ? <small className="ops-sync-inline-err">{step.errorMessage}</small> : null}
                      {step.failedDocuments.length > 0 ? (
                        <div className="ops-failed-doc-list">
                          {step.failedDocuments.map((doc, index) => (
                            <div key={`${doc.difyDocId ?? doc.batchId ?? doc.filePath ?? "doc"}-${index}`} className="ops-failed-doc">
                              <strong>{doc.filePath ?? doc.difyDocId ?? "Unknown document"}</strong>
                              {doc.error ? <span>Dify error: {doc.error}</span> : null}
                              {doc.difyDocId ? <small>Dify document: {doc.difyDocId}</small> : null}
                              {canRetryIndexing && doc.difyDocId ? (
                                <button
                                  type="button"
                                  className="ops-action-btn ops-action-retry ops-inline-retry-btn"
                                  onClick={() => void onRetryFailedIndexing(kbId, { syncJobId: effectiveJob.id, documentIds: [doc.difyDocId!] })}
                                  disabled={busy === `retry-indexing:${doc.difyDocId}`}
                                >
                                  {busy === `retry-indexing:${doc.difyDocId}` ? "…" : "Retry file"}
                                </button>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      ) : null}
                      {canRetryIndexing ? (
                        <button
                          type="button"
                          className="ops-action-btn ops-action-retry ops-inline-retry-btn"
                          onClick={() => void onRetryFailedIndexing(kbId, { syncJobId: effectiveJob.id })}
                          disabled={busy === `retry-indexing:${kbId}`}
                        >
                          {busy === `retry-indexing:${kbId}` ? "…" : "Retry indexing"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <span className={`ops-step-badge ops-step-badge-${variant}`}>
                      {stepStatusEmoji(step.status)} {step.status}
                    </span>
                  </td>
                  <td>{formatDate(step.startedAt)}</td>
                  <td>{step.durationLabel}</td>
                  <td>
                    {effectiveJob ? (
                      <button
                        type="button"
                        className="ops-log-icon-btn"
                        title="View logs"
                        aria-label={`View logs for ${step.task}`}
                        onClick={() =>
                          setLogDrawer({
                            syncJobId: effectiveJob.id,
                            stepName: step.logStepName
                          })
                        }
                      >
                        📋
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {logDrawer ? (
        <>
          <button type="button" className="ops-log-drawer-backdrop" aria-label="Close log drawer" onClick={() => setLogDrawer(null)} />
          <StepLogDrawer open onClose={() => setLogDrawer(null)} syncJobId={logDrawer.syncJobId} stepName={logDrawer.stepName} />
        </>
      ) : null}
    </section>
  );
}
