"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";
import { resolveApiBase } from "./api-base";

interface CertServiceStatus {
  service: string;
  endpoint: string;
  severity: "OK" | "WARNING" | "CRITICAL";
  healthOk: boolean;
  validTo?: string;
  daysRemaining?: number | null;
  fingerprint?: string;
  reloadFailures?: number;
  lastReloadAt?: string;
  checkedAt?: string;
  error?: string;
  pendingRotation?: {
    requestId: string;
    queuedAt: string;
    trigger: string;
  } | null;
}

interface CertEventsResponse {
  events: Array<{
    eventType?: string;
    severity?: string;
    service?: string;
    timestamp?: string;
    error?: string;
  }>;
}

function formatTs(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function severityClass(severity: string): string {
  if (severity === "CRITICAL") return "status-error";
  if (severity === "WARNING") return "status-warning";
  return "status-ok";
}

export function SecurityHealthPanel(): ReactElement {
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [services, setServices] = useState<CertServiceStatus[]>([]);
  const [events, setEvents] = useState<CertEventsResponse["events"]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [renewingService, setRenewingService] = useState<string>("");

  async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
    const auth = authHeaderFromStoredToken();
    const response = await fetch(`${resolveApiBase()}${path}`, {
      ...options,
      headers: {
        ...(options?.headers ?? {}),
        ...(auth ? { authorization: auth } : {}),
        "content-type": "application/json"
      }
    });
    const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
    if (!response.ok) {
      throw new Error(payload.details ?? payload.error ?? `Request failed ${response.status}`);
    }
    return payload as T;
  }

  async function loadData(): Promise<void> {
    setLoading(true);
    try {
      const [identity, certificateData, eventData] = await Promise.all([
        fetchIdentity(),
        requestJson<{ services: CertServiceStatus[] }>("/admin/security/certificates"),
        requestJson<CertEventsResponse>("/admin/security/certificates/events?limit=30")
      ]);
      setIsAdmin(identity.roles.includes("admin"));
      setServices(certificateData.services ?? []);
      setEvents(eventData.events ?? []);
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load security health");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData().catch(() => undefined);
    const timer = window.setInterval(() => {
      loadData().catch(() => undefined);
    }, 15000);
    return () => {
      window.clearInterval(timer);
    };
  }, []);

  async function manualRenew(service: string): Promise<void> {
    setRenewingService(service);
    setStatus(`Queueing rotation for ${service}...`);
    setError("");
    try {
      await requestJson(`/admin/security/certificates/${encodeURIComponent(service)}/renew`, {
        method: "POST",
        body: JSON.stringify({
          reason: "Manual renew from security health page"
        })
      });
      setStatus(`Rotation queued for ${service}.`);
      await loadData();
    } catch (renewError) {
      setStatus("");
      setError(renewError instanceof Error ? renewError.message : "Manual renew failed");
    } finally {
      setRenewingService("");
    }
  }

  if (!isAdmin && !loading) {
    return (
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Security Health</h1>
        <p>Only platform-admin users can view certificate operations.</p>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <h1 style={{ marginTop: 0 }}>Security Health</h1>
        <p>Certificate expiry, reload status, and rotation actions for platform services.</p>
        {status ? <p className="ops-status-line">{status}</p> : null}
        {error ? <p className="ops-error">{error}</p> : null}
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Certificates</h3>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Service</th>
                <th>Severity</th>
                <th>Expires</th>
                <th>Days Left</th>
                <th>Reload Failures</th>
                <th>Last Reload</th>
                <th>Pending Rotation</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {services.length === 0 ? (
                <tr>
                  <td colSpan={8}>{loading ? "Loading..." : "No certificate data available."}</td>
                </tr>
              ) : (
                services.map((service) => (
                  <tr key={service.service}>
                    <td>
                      <strong>{service.service}</strong>
                      <div style={{ fontSize: 12, opacity: 0.75 }}>{service.endpoint}</div>
                    </td>
                    <td>
                      <span className={severityClass(service.severity)}>{service.severity}</span>
                    </td>
                    <td>{formatTs(service.validTo)}</td>
                    <td>{service.daysRemaining ?? "-"}</td>
                    <td>{service.reloadFailures ?? 0}</td>
                    <td>{formatTs(service.lastReloadAt)}</td>
                    <td>{service.pendingRotation ? formatTs(service.pendingRotation.queuedAt) : "-"}</td>
                    <td>
                      <button
                        type="button"
                        onClick={() => manualRenew(service.service).catch(() => undefined)}
                        disabled={renewingService === service.service}
                      >
                        {renewingService === service.service ? "Queueing..." : "Run Rotation/Renew"}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h3 style={{ marginTop: 0 }}>Recent Certificate Events</h3>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Service</th>
                <th>Severity</th>
                <th>Event</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {events.length === 0 ? (
                <tr>
                  <td colSpan={5}>No certificate events yet.</td>
                </tr>
              ) : (
                events.map((entry, index) => (
                  <tr key={`${entry.eventType ?? "event"}-${index}`}>
                    <td>{formatTs(entry.timestamp)}</td>
                    <td>{entry.service ?? "-"}</td>
                    <td>{entry.severity ?? "-"}</td>
                    <td>{entry.eventType ?? "-"}</td>
                    <td>{entry.error ?? "-"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

