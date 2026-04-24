"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Panel } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";

const TOKEN_STORAGE_KEY = "ops_bearer_token";

interface ExecutionLog {
  id: string;
  orderId: string;
  nodeId?: string | null;
  stepId?: string | null;
  severity: string;
  source: string;
  message: string;
  durationMs?: number | null;
  createdAt: string;
}

interface TimelineEvent {
  type: "STATUS_TRANSITION" | "STEP_EXECUTION" | "EXECUTION_LOG";
  timestamp: string;
  data: Record<string, unknown>;
}

interface TimelineResponse {
  orderId: string;
  events: TimelineEvent[];
}

function normalizeToken(input: string): string {
  return input.trim().replace(/^Bearer\s+/i, "");
}

function authHeader(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const token = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  if (!token.trim()) return undefined;
  return `Bearer ${normalizeToken(token)}`;
}

async function fetchJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const auth = authHeader();
  if (auth) {
    headers.authorization = auth;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

function formatTs(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export function LogsExplorer(): ReactElement {
  const [orderId, setOrderId] = useState<string>("");
  const [severity, setSeverity] = useState<string>("");
  const [source, setSource] = useState<string>("");
  const [messageContains, setMessageContains] = useState<string>("");
  const [logs, setLogs] = useState<ExecutionLog[]>([]);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  useEffect(() => {
    let active = true;

    async function loadLogs(): Promise<void> {
      const query = new URLSearchParams();
      query.set("limit", "200");
      if (orderId.trim()) query.set("orderId", orderId.trim());
      if (severity.trim()) query.set("severity", severity.trim());
      if (source.trim()) query.set("source", source.trim());
      if (messageContains.trim()) query.set("messageContains", messageContains.trim());

      try {
        setStatus("Loading logs...");
        const result = await fetchJson<ExecutionLog[]>(`/logs?${query.toString()}`);
        if (!active) return;
        setLogs(result);
        setStatus(`Loaded ${result.length} logs.`);
        setError("");
      } catch (loadError) {
        if (!active) return;
        setStatus("");
        setError(loadError instanceof Error ? loadError.message : "Failed to load logs");
      }
    }

    void loadLogs();
    return () => {
      active = false;
    };
  }, [orderId, severity, source, messageContains, refreshNonce]);

  useEffect(() => {
    let active = true;
    if (!orderId.trim()) {
      setTimeline([]);
      return () => {
        active = false;
      };
    }
    fetchJson<TimelineResponse>(`/logs/timeline?orderId=${encodeURIComponent(orderId.trim())}`)
      .then((payload) => {
        if (!active) return;
        setTimeline(payload.events);
      })
      .catch(() => {
        if (!active) return;
        setTimeline([]);
      });
    return () => {
      active = false;
    };
  }, [orderId, refreshNonce]);

  return (
    <>
      <Panel title="Logs Explorer">
        <div className="builder-top-row">
          <label htmlFor="logs-order-id">Order ID</label>
          <input id="logs-order-id" value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="Optional order id" />
          <button type="button" onClick={() => setRefreshNonce((value) => value + 1)}>
            Refresh
          </button>
        </div>
        <div className="builder-top-row">
          <label htmlFor="logs-severity">Severity</label>
          <input id="logs-severity" value={severity} onChange={(event) => setSeverity(event.target.value)} placeholder="INFO / ERROR / ..." />
          <span />
        </div>
        <div className="builder-top-row">
          <label htmlFor="logs-source">Source</label>
          <input id="logs-source" value={source} onChange={(event) => setSource(event.target.value)} placeholder="api-gateway / workflow-service / ..." />
          <span />
        </div>
        <div className="builder-top-row">
          <label htmlFor="logs-message">Message Contains</label>
          <input
            id="logs-message"
            value={messageContains}
            onChange={(event) => setMessageContains(event.target.value)}
            placeholder="substring filter"
          />
          <span />
        </div>
        <p className="ops-status-line">Status: {status || "-"}</p>
        {error ? <p className="ops-error">{error}</p> : null}

        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Order</th>
                <th>Severity</th>
                <th>Source</th>
                <th>Message</th>
                <th>Node/Step</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={7}>No logs found.</td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id}>
                    <td>{formatTs(log.createdAt)}</td>
                    <td>{log.orderId}</td>
                    <td>{log.severity}</td>
                    <td>{log.source}</td>
                    <td>{log.message}</td>
                    <td>
                      {log.nodeId ?? "-"}/{log.stepId ?? "-"}
                    </td>
                    <td>{log.durationMs ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Order Timeline View">
        <p className="ops-status-line">Timeline order: {orderId || "-"}</p>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Type</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {timeline.length === 0 ? (
                <tr>
                  <td colSpan={3}>No timeline loaded.</td>
                </tr>
              ) : (
                timeline.slice(-50).reverse().map((event, index) => (
                  <tr key={`${event.timestamp}-${event.type}-${index}`}>
                    <td>{formatTs(event.timestamp)}</td>
                    <td>{event.type}</td>
                    <td>
                      <code>{JSON.stringify(event.data)}</code>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
