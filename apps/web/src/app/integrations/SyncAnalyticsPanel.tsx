"use client";

import { useEffect, useState } from "react";
import type { SyncAnalyticsKbRow, SyncAnalyticsResponse, SyncAnalyticsSourceRow } from "./api";
import { fetchSyncAnalytics } from "./api";
import { formatDuration } from "./types";

const SOURCE_LABELS: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  googledrive: "Google Drive",
  gdrive: "Google Drive",
  web: "Web",
  upload: "Upload",
};

const SOURCE_ICONS: Record<string, string> = {
  github: "🐙",
  gitlab: "🦊",
  googledrive: "📁",
  gdrive: "📁",
  web: "🌐",
  upload: "📤",
};

function sourceLabel(type: string): string {
  return SOURCE_LABELS[type?.toLowerCase()] ?? type ?? "Unknown";
}

function sourceIcon(type: string): string {
  return SOURCE_ICONS[type?.toLowerCase()] ?? "📦";
}

function fmtFilesPerMin(v: number | null): string {
  if (v == null) return "—";
  return `${v.toFixed(1)}/min`;
}

function fmtMsPerFile(v: number | null): string {
  if (v == null) return "—";
  return formatDuration(v) + "/file";
}

function successBadge(rate: number | null): string {
  if (rate == null) return "—";
  if (rate >= 90) return `✅ ${rate}%`;
  if (rate >= 60) return `⚠️ ${rate}%`;
  return `❌ ${rate}%`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type Tab = "source" | "kb";

export function SyncAnalyticsPanel() {
  const [data, setData] = useState<SyncAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("source");

  useEffect(() => {
    setLoading(true);
    fetchSyncAnalytics()
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : "Failed to load analytics"))
      .finally(() => setLoading(false));
  }, []);

  const fastestSource = data?.bySourceType.length
    ? data.bySourceType[0]
    : null;

  return (
    <section className="integrations-panel ops-sync-analytics">
      <div className="integrations-panel-header ops-sync-analytics-header">
        <div>
          <h2>Sync Analytics</h2>
          <p>Performance stats for the last {data?.retentionDays ?? 30} days. Helps tune indexing timeout values automatically.</p>
        </div>
        <div className="ops-sync-analytics-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "source"}
            className={`ops-analytics-tab${tab === "source" ? " ops-analytics-tab-active" : ""}`}
            onClick={() => setTab("source")}
          >
            By Source Type
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "kb"}
            className={`ops-analytics-tab${tab === "kb" ? " ops-analytics-tab-active" : ""}`}
            onClick={() => setTab("kb")}
          >
            By Knowledge Base
          </button>
        </div>
      </div>

      {loading && <p className="ops-analytics-loading">Loading analytics…</p>}
      {error && <p className="integrations-status-error">{error}</p>}

      {data && !loading && (
        <>
          {/* Fastest source highlight */}
          {fastestSource && tab === "source" && (
            <div className="ops-analytics-highlight">
              <span>⚡ Fastest source type:</span>
              <strong>{sourceIcon(fastestSource.sourceType)} {sourceLabel(fastestSource.sourceType)}</strong>
              <span>{fmtFilesPerMin(fastestSource.avgFilesPerMin)} avg · {fmtMsPerFile(fastestSource.avgMsPerFile)} avg</span>
            </div>
          )}

          {/* By Source Type tab */}
          {tab === "source" && (
            <div className="integrations-table-wrap">
              {data.bySourceType.length === 0 ? (
                <p className="ops-analytics-empty">No completed syncs in the last {data.retentionDays} days.</p>
              ) : (
                <table className="integrations-table ops-analytics-table">
                  <thead>
                    <tr>
                      <th>Source</th>
                      <th>Runs</th>
                      <th>Avg Duration</th>
                      <th>Fastest</th>
                      <th>Files / Min</th>
                      <th>Avg / File</th>
                      <th>Success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.bySourceType.map((row: SyncAnalyticsSourceRow) => (
                      <tr key={row.sourceType}>
                        <td><strong>{sourceIcon(row.sourceType)} {sourceLabel(row.sourceType)}</strong></td>
                        <td>{row.completedRuns} / {row.totalRuns}</td>
                        <td>{formatDuration(row.avgDurationMs)}</td>
                        <td>—</td>
                        <td>{fmtFilesPerMin(row.avgFilesPerMin)}</td>
                        <td>{fmtMsPerFile(row.avgMsPerFile)}</td>
                        <td>{successBadge(row.successRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* By Knowledge Base tab */}
          {tab === "kb" && (
            <div className="integrations-table-wrap">
              {data.byKb.length === 0 ? (
                <p className="ops-analytics-empty">No completed syncs in the last {data.retentionDays} days.</p>
              ) : (
                <table className="integrations-table ops-analytics-table">
                  <thead>
                    <tr>
                      <th>Knowledge Base</th>
                      <th>Source</th>
                      <th>Runs</th>
                      <th>Avg Duration</th>
                      <th>Fastest</th>
                      <th>Slowest</th>
                      <th>Files / Min</th>
                      <th>Success</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byKb.map((row: SyncAnalyticsKbRow) => (
                      <tr key={row.kbName + row.sourceType}>
                        <td><strong>{row.kbName}</strong></td>
                        <td>{sourceIcon(row.sourceType)} {sourceLabel(row.sourceType)}</td>
                        <td>{row.completedRuns} / {row.totalRuns}</td>
                        <td>{formatDuration(row.avgDurationMs)}</td>
                        <td className="ops-analytics-best">{formatDuration(row.minDurationMs)}</td>
                        <td className="ops-analytics-worst">{formatDuration(row.maxDurationMs)}</td>
                        <td>{fmtFilesPerMin(row.avgFilesPerMin)}</td>
                        <td>{successBadge(row.successRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Auto Timeout Tuning insight */}
          <div className="ops-analytics-insight">
            <div className="ops-analytics-insight-title">Auto Timeout Tuning</div>
            <div className="ops-analytics-insight-body">
              <div className="ops-dify-stats-row">
                <span className="ops-dify-stat ops-dify-stat-total">
                  ⏱ {data.currentTimeout.maxAttempts} attempts × 5 s = {formatDuration(data.currentTimeout.maxAttempts * 5000)} timeout
                </span>
                <span className="ops-dify-stat ops-dify-stat-completed">
                  📊 {data.currentTimeout.dataPoints} syncs analysed
                </span>
              </div>
              <p className="ops-analytics-insight-note">{data.currentTimeout.note}</p>
              <p className="ops-analytics-insight-note">
                ✅ This value is applied automatically at the start of each sync — no redeploy needed.
              </p>
            </div>
          </div>

          {/* DB retention badge */}
          <div className={`ops-analytics-retention${data.tableSizeWarning ? " ops-analytics-retention-warn" : ""}`}>
            {data.tableSizeWarning ? "⚠️" : "🗄"} Sync job table: <strong>{fmtBytes(data.approxTableBytes)}</strong>
            &nbsp;·&nbsp;Retention: {data.retentionDays} days
            &nbsp;·&nbsp;Old records cleaned on page load
            {data.tableSizeWarning && <span className="ops-analytics-warn-msg"> — table is large, consider reviewing sync frequency</span>}
          </div>
        </>
      )}
    </section>
  );
}
