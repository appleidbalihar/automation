"use client";

import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { resolveApiBase } from "./api-base";
import { authHeaderFromStoredToken } from "./auth-client";

type TimingAvg = {
  vaultFetchMs: number;
  difyCallMs: number;
  totalPipelineMs: number;
  overheadMs: number;
};

type TimingPercentiles = {
  p50: { vaultFetchMs: number; difyCallMs: number; totalMs: number };
  p90: { vaultFetchMs: number; difyCallMs: number; totalMs: number };
  p99: { vaultFetchMs: number; difyCallMs: number; totalMs: number };
};

type SlowestQuery = {
  totalPipelineMs: number;
  difyCallMs: number;
  vaultFetchMs: number;
  promptLen?: number;
  createdAt: string;
};

type KbBreakdown = {
  knowledgeBaseId: string;
  requestCount: number;
  avgVaultFetchMs: number;
  avgDifyCallMs: number;
  avgTotalMs: number;
};

type KbQuality = {
  knowledgeBaseId: string;
  requests: number;
  retrievalHitRate: number;
  blockRate: number;
  fallbackRate: number;
  avgChunkScore: number | null;
  avgTotalMs: number;
  alertLevel: "ok" | "warn" | "critical";
};

type QualityMetrics = {
  totalEvents: number;
  retrievalHitRate: number;
  hallucinationBlockRate: number;
  fallbackRate: number;
  avgChunkScore: number | null;
  byChannel: { gui: number; slack: number };
  byKnowledgeBase: KbQuality[];
};

type StatsResponse = {
  periodDays: number;
  totalRequests: number;
  message: string;
  averages: TimingAvg | null;
  percentiles: TimingPercentiles | null;
  slowestQueries: SlowestQuery[];
  byKnowledgeBase: KbBreakdown[];
  quality: QualityMetrics | null;
};

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function formatPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function latencyClass(ms: number): string {
  if (ms >= 10000) return "stat-badge stat-badge-critical";
  if (ms >= 5000) return "stat-badge stat-badge-warn";
  if (ms >= 2000) return "stat-badge stat-badge-slow";
  return "stat-badge stat-badge-ok";
}

function hitRateClass(rate: number): string {
  if (rate >= 0.8) return "stat-badge stat-badge-ok";
  if (rate >= 0.6) return "stat-badge stat-badge-slow";
  return "stat-badge stat-badge-critical";
}

function blockRateClass(rate: number): string {
  if (rate <= 0.1) return "stat-badge stat-badge-ok";
  if (rate <= 0.25) return "stat-badge stat-badge-slow";
  return "stat-badge stat-badge-critical";
}

function scoreClass(score: number | null): string {
  if (score === null) return "stat-badge stat-badge-slow";
  if (score >= 0.7) return "stat-badge stat-badge-ok";
  if (score >= 0.5) return "stat-badge stat-badge-slow";
  return "stat-badge stat-badge-critical";
}

function alertBadge(level: "ok" | "warn" | "critical"): ReactElement {
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    ok:       { bg: "#dcfce7", color: "#166534", label: "Healthy" },
    warn:     { bg: "#fef9c3", color: "#854d0e", label: "Monitor" },
    critical: { bg: "#fee2e2", color: "#991b1b", label: "Action needed" }
  };
  const s = styles[level];
  return (
    <span style={{ background: s.bg, color: s.color, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600 }}>
      {s.label}
    </span>
  );
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch { return iso; }
}

async function fetchStats(days: number): Promise<StatsResponse> {
  const auth = authHeaderFromStoredToken();
  if (!auth) throw new Error("Not signed in");
  const res = await fetch(`${resolveApiBase()}/rag/stats?days=${days}`, {
    headers: { authorization: auth }
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(String(err.details ?? err.error ?? `HTTP ${res.status}`));
  }
  return res.json() as Promise<StatsResponse>;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }): ReactElement {
  return (
    <div className="stat-card">
      <p className="stat-card-label">{label}</p>
      <p className="stat-card-value">{value}</p>
      {sub ? <p className="stat-card-sub">{sub}</p> : null}
    </div>
  );
}

export function RagStats(): ReactElement {
  const [days, setDays] = useState<number>(7);
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    fetchStats(days)
      .then((data) => { if (active) { setStats(data); setLoading(false); } })
      .catch((err) => { if (active) { setError(err instanceof Error ? err.message : String(err)); setLoading(false); } });
    return () => { active = false; };
  }, [days]);

  return (
    <div className="card" style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <h1 style={{ margin: 0, color: "#0f172a" }}>RAG Analytics</h1>
        <select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", color: "#0f172a", fontSize: 13 }}
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
        </select>
      </div>

      {loading ? (
        <p style={{ color: "#64748b" }}>Loading stats…</p>
      ) : error ? (
        <p style={{ color: "#dc2626" }}>Error: {error}</p>
      ) : !stats ? null : (
        <>
          <p style={{ color: "#64748b", marginBottom: 20, fontSize: 13 }}>{stats.message}</p>

          {stats.totalRequests === 0 && !stats.quality ? (
            <div style={{ padding: 32, textAlign: "center", color: "#64748b", background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 10 }}>
              <p style={{ fontSize: 18, margin: "0 0 8px" }}>📊 No data yet</p>
              <p style={{ margin: 0 }}>Send a message in the RAG Assistant to start collecting metrics.</p>
            </div>
          ) : (
            <>
              {/* ── Answer Quality ──────────────────────────────────────────────── */}
              {stats.quality ? (
                <>
                  <h3 style={{ marginBottom: 12, color: "#0f172a" }}>Answer Quality ({stats.quality.totalEvents} requests tracked)</h3>

                  {/* Diagnostic alert */}
                  {stats.quality.byKnowledgeBase.some(kb => kb.alertLevel === "critical") ? (
                    <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10, padding: 14, marginBottom: 16, fontSize: 13, color: "#7f1d1d" }}>
                      <strong>⚠ One or more knowledge bases have a high block rate.</strong> This usually means the chat model
                      is generating answers that don&apos;t match the retrieved content. The system will attempt to synthesize
                      answers directly from retrieved chunks as a fallback, but consider switching to a larger or
                      instruction-tuned model for better results.
                    </div>
                  ) : null}

                  <div className="stat-grid">
                    <StatCard
                      label="Retrieval Hit Rate"
                      value={formatPct(stats.quality.retrievalHitRate)}
                      sub="Questions where chunks were found"
                    />
                    <StatCard
                      label="Hallucination Block Rate"
                      value={formatPct(stats.quality.hallucinationBlockRate)}
                      sub="Answers blocked by guard"
                    />
                    <StatCard
                      label="Fallback Rate"
                      value={formatPct(stats.quality.fallbackRate)}
                      sub="Answers using fallback synthesis"
                    />
                    <StatCard
                      label="Avg Chunk Score"
                      value={stats.quality.avgChunkScore !== null ? stats.quality.avgChunkScore.toFixed(2) : "—"}
                      sub="Avg similarity of retrieved chunks"
                    />
                  </div>

                  <div style={{ display: "flex", gap: 12, marginTop: 8, marginBottom: 20, fontSize: 12, color: "#64748b" }}>
                    <span>GUI: {stats.quality.byChannel.gui} requests</span>
                    <span>Slack: {stats.quality.byChannel.slack} requests</span>
                  </div>

                  {/* Per-KB quality table */}
                  {stats.quality.byKnowledgeBase.length > 0 ? (
                    <>
                      <h3 style={{ marginBottom: 10, color: "#0f172a" }}>Per Knowledge Base — Quality</h3>
                      <table className="stat-table">
                        <thead>
                          <tr>
                            <th>Knowledge Base</th>
                            <th>Requests</th>
                            <th>Hit Rate</th>
                            <th>Block %</th>
                            <th>Fallback %</th>
                            <th>Avg Score</th>
                            <th>Avg Time</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.quality.byKnowledgeBase.map((kb) => (
                            <tr key={kb.knowledgeBaseId}>
                              <td style={{ fontFamily: "monospace", fontSize: 11, color: "#334155" }}>{kb.knowledgeBaseId.slice(-12)}</td>
                              <td style={{ color: "#334155" }}>{kb.requests}</td>
                              <td><span className={hitRateClass(kb.retrievalHitRate)}>{formatPct(kb.retrievalHitRate)}</span></td>
                              <td><span className={blockRateClass(kb.blockRate)}>{formatPct(kb.blockRate)}</span></td>
                              <td style={{ color: "#334155" }}>{formatPct(kb.fallbackRate)}</td>
                              <td><span className={scoreClass(kb.avgChunkScore)}>{kb.avgChunkScore !== null ? kb.avgChunkScore.toFixed(2) : "—"}</span></td>
                              <td style={{ color: "#334155" }}>{formatMs(kb.avgTotalMs)}</td>
                              <td>{alertBadge(kb.alertLevel)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : null}

                  <div style={{ height: 1, background: "#e2e8f0", margin: "28px 0 24px" }} />
                </>
              ) : null}

              {/* ── Response Timing ─────────────────────────────────────────────── */}
              {stats.totalRequests > 0 ? (
                <>
                  <h3 style={{ marginBottom: 12, color: "#0f172a" }}>Response Timing ({stats.totalRequests} requests)</h3>
                  <div className="stat-grid">
                    <StatCard
                      label="Total (end-to-end)"
                      value={formatMs(stats.averages!.totalPipelineMs)}
                      sub="Vault + AI Agent + overhead"
                    />
                    <StatCard
                      label="AI Agent Call (Vector DB + LLM)"
                      value={formatMs(stats.averages!.difyCallMs)}
                      sub="Main bottleneck — embedding + generation"
                    />
                    <StatCard
                      label="Vault Secret Fetch"
                      value={formatMs(stats.averages!.vaultFetchMs)}
                      sub="API key lookup (should be <100ms)"
                    />
                    <StatCard
                      label="Overhead"
                      value={formatMs(stats.averages!.overheadMs)}
                      sub="DB + serialization + network"
                    />
                  </div>

                  <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: 16, marginTop: 4, marginBottom: 20 }}>
                    <h4 style={{ margin: "0 0 10px", color: "#0c4a6e", fontSize: 14 }}>🔍 Where is the time spent?</h4>
                    <p style={{ margin: "0 0 8px", fontSize: 13, color: "#1e3a5f", lineHeight: 1.6 }}>
                      <strong>AI Agent Call</strong> ({formatMs(stats.averages!.difyCallMs)}) = Vector DB retrieval + LLM summarization.
                      This is almost always the dominant cost.
                    </p>
                    <p style={{ margin: "0 0 8px", fontSize: 13, color: "#1e3a5f", lineHeight: 1.6 }}>
                      <strong>Vault Fetch</strong> ({formatMs(stats.averages!.vaultFetchMs)}) = reading the API key from HashiCorp Vault.
                      Should be &lt;100ms. If this is slow, Vault itself may be under load.
                    </p>
                    <p style={{ margin: 0, fontSize: 13, color: "#1e3a5f", lineHeight: 1.6 }}>
                      <strong>Scaling prediction:</strong> With 100 documents (vs current 8), expect AI Agent call time
                      to increase by ~2–4× due to larger vector index and longer context window for the LLM.
                    </p>
                  </div>

                  {stats.percentiles ? (
                    <>
                      <h3 style={{ marginBottom: 10, color: "#0f172a" }}>Latency Percentiles</h3>
                      <table className="stat-table">
                        <thead>
                          <tr>
                            <th>Percentile</th>
                            <th>Total</th>
                            <th>AI Agent</th>
                            <th>Vault Fetch</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr>
                            <td><strong>P50 (median)</strong></td>
                            <td><span className={latencyClass(stats.percentiles.p50.totalMs)}>{formatMs(stats.percentiles.p50.totalMs)}</span></td>
                            <td style={{ color: "#334155" }}>{formatMs(stats.percentiles.p50.difyCallMs)}</td>
                            <td style={{ color: "#334155" }}>{formatMs(stats.percentiles.p50.vaultFetchMs)}</td>
                          </tr>
                          <tr>
                            <td><strong>P90</strong></td>
                            <td><span className={latencyClass(stats.percentiles.p90.totalMs)}>{formatMs(stats.percentiles.p90.totalMs)}</span></td>
                            <td style={{ color: "#334155" }}>{formatMs(stats.percentiles.p90.difyCallMs)}</td>
                            <td style={{ color: "#334155" }}>{formatMs(stats.percentiles.p90.vaultFetchMs)}</td>
                          </tr>
                          <tr>
                            <td><strong>P99</strong></td>
                            <td><span className={latencyClass(stats.percentiles.p99.totalMs)}>{formatMs(stats.percentiles.p99.totalMs)}</span></td>
                            <td style={{ color: "#334155" }}>{formatMs(stats.percentiles.p99.difyCallMs)}</td>
                            <td style={{ color: "#334155" }}>{formatMs(stats.percentiles.p99.vaultFetchMs)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </>
                  ) : null}

                  {stats.slowestQueries.length > 0 ? (
                    <>
                      <h3 style={{ marginTop: 24, marginBottom: 10, color: "#0f172a" }}>Slowest 5 Queries</h3>
                      <table className="stat-table">
                        <thead>
                          <tr>
                            <th>Time</th>
                            <th>Total</th>
                            <th>AI Agent</th>
                            <th>Vault</th>
                            <th>Prompt Chars</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.slowestQueries.map((q, i) => (
                            <tr key={i}>
                              <td style={{ fontSize: 12, color: "#64748b" }}>{formatTime(q.createdAt)}</td>
                              <td><span className={latencyClass(q.totalPipelineMs)}>{formatMs(q.totalPipelineMs)}</span></td>
                              <td style={{ color: "#334155" }}>{formatMs(q.difyCallMs)}</td>
                              <td style={{ color: "#334155" }}>{formatMs(q.vaultFetchMs)}</td>
                              <td style={{ color: "#334155" }}>{q.promptLen ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : null}

                  {stats.byKnowledgeBase && stats.byKnowledgeBase.length > 0 ? (
                    <>
                      <h3 style={{ marginTop: 24, marginBottom: 10, color: "#0f172a" }}>Per Knowledge Base — Timing</h3>
                      <table className="stat-table">
                        <thead>
                          <tr>
                            <th>Knowledge Base ID</th>
                            <th>Requests</th>
                            <th>Avg Total</th>
                            <th>Avg AI Agent</th>
                            <th>Avg Vault</th>
                          </tr>
                        </thead>
                        <tbody>
                          {stats.byKnowledgeBase.map((kb) => (
                            <tr key={kb.knowledgeBaseId}>
                              <td style={{ fontFamily: "monospace", fontSize: 12, color: "#334155" }}>{kb.knowledgeBaseId.slice(-12)}</td>
                              <td style={{ color: "#334155" }}>{kb.requestCount}</td>
                              <td><span className={latencyClass(kb.avgTotalMs)}>{formatMs(kb.avgTotalMs)}</span></td>
                              <td style={{ color: "#334155" }}>{formatMs(kb.avgDifyCallMs)}</td>
                              <td style={{ color: "#334155" }}>{formatMs(kb.avgVaultFetchMs)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  ) : null}
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
