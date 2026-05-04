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

type StatsResponse = {
  periodDays: number;
  totalRequests: number;
  message: string;
  averages: TimingAvg | null;
  percentiles: TimingPercentiles | null;
  slowestQueries: SlowestQuery[];
  byKnowledgeBase: KbBreakdown[];
};

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function latencyClass(ms: number): string {
  if (ms >= 10000) return "stat-badge stat-badge-critical";
  if (ms >= 5000) return "stat-badge stat-badge-warn";
  if (ms >= 2000) return "stat-badge stat-badge-slow";
  return "stat-badge stat-badge-ok";
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
        <h1 style={{ margin: 0, color: "#0f172a" }}>⏱ RAG Response Time Stats</h1>
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
        <p style={{ color: "#64748b" }}>Loading timing data…</p>
      ) : error ? (
        <p style={{ color: "#dc2626" }}>Error: {error}</p>
      ) : !stats ? null : (
        <>
          <p style={{ color: "#64748b", marginBottom: 20, fontSize: 13 }}>{stats.message}</p>

          {stats.totalRequests === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "#64748b", background: "#f8fafc", border: "1px dashed #cbd5e1", borderRadius: 10 }}>
              <p style={{ fontSize: 18, margin: "0 0 8px" }}>📊 No data yet</p>
              <p style={{ margin: 0 }}>Send a message in the RAG Assistant to start collecting timing metrics.</p>
            </div>
          ) : (
            <>
              <h3 style={{ marginBottom: 12, color: "#0f172a" }}>Average Response Times ({stats.totalRequests} requests)</h3>
              <div className="stat-grid">
                <StatCard
                  label="Total (end-to-end)"
                  value={formatMs(stats.averages!.totalPipelineMs)}
                  sub="Vault + Dify + overhead"
                />
                <StatCard
                  label="Dify Call (Vector DB + LLM)"
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

              {/* Explanation box */}
              <div style={{ background: "#f0f9ff", border: "1px solid #bae6fd", borderRadius: 10, padding: 16, marginTop: 4, marginBottom: 20 }}>
                <h4 style={{ margin: "0 0 10px", color: "#0c4a6e", fontSize: 14 }}>🔍 Where is the time spent?</h4>
                <p style={{ margin: "0 0 8px", fontSize: 13, color: "#1e3a5f", lineHeight: 1.6 }}>
                  <strong>Dify Call</strong> ({formatMs(stats.averages!.difyCallMs)}) = Vector DB retrieval + LLM summarization.
                  This is almost always the dominant cost. With 8 documents it is faster; with 100+ documents
                  the vector search takes longer, and the LLM prompt grows proportionally.
                </p>
                <p style={{ margin: "0 0 8px", fontSize: 13, color: "#1e3a5f", lineHeight: 1.6 }}>
                  <strong>Vault Fetch</strong> ({formatMs(stats.averages!.vaultFetchMs)}) = reading the API key from HashiCorp Vault.
                  Should be &lt;100ms. If this is slow, Vault itself may be under load.
                </p>
                <p style={{ margin: 0, fontSize: 13, color: "#1e3a5f", lineHeight: 1.6 }}>
                  <strong>Scaling prediction:</strong> With 100 documents (vs current 8), expect Dify call time
                  to increase by ~2–4× due to larger vector index and longer context window for the LLM.
                </p>
              </div>

              {/* Percentiles */}
              {stats.percentiles ? (
                <>
                  <h3 style={{ marginBottom: 10, color: "#0f172a" }}>Latency Percentiles (Total Response Time)</h3>
                  <table className="stat-table">
                    <thead>
                      <tr>
                        <th>Percentile</th>
                        <th>Total</th>
                        <th>Dify Call</th>
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

              {/* Slowest queries */}
              {stats.slowestQueries.length > 0 ? (
                <>
                  <h3 style={{ marginTop: 24, marginBottom: 10, color: "#0f172a" }}>Slowest 5 Queries</h3>
                  <table className="stat-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Total</th>
                        <th>Dify Call</th>
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

              {/* Per-KB breakdown */}
              {stats.byKnowledgeBase && stats.byKnowledgeBase.length > 0 ? (
                <>
                  <h3 style={{ marginTop: 24, marginBottom: 10, color: "#0f172a" }}>Per Knowledge Base</h3>
                  <table className="stat-table">
                    <thead>
                      <tr>
                        <th>Knowledge Base ID</th>
                        <th>Requests</th>
                        <th>Avg Total</th>
                        <th>Avg Dify</th>
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
          )}
        </>
      )}
    </div>
  );
}
