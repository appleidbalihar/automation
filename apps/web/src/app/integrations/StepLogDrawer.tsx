"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { fetchSyncJobLogs } from "./api";

type Props = {
  open: boolean;
  onClose: () => void;
  syncJobId: string | null;
  stepName: string | null;
};

export function StepLogDrawer(props: Props): ReactElement {
  const { open, onClose, syncJobId, stepName } = props;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    if (!open || !syncJobId) {
      setLines([]);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchSyncJobLogs(syncJobId, stepName ?? undefined)
      .then((res) => {
        if (cancelled) return;
        const formatted = (res.logs ?? []).map((entry) => {
          if (entry === null || entry === undefined) return String(entry);
          if (typeof entry === "string") return entry;
          try {
            return JSON.stringify(entry, null, 2);
          } catch {
            return String(entry);
          }
        });
        setLines(formatted);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load logs");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, syncJobId, stepName]);

  return (
    <div className={`ops-log-drawer${open ? " ops-log-drawer-open" : ""}`} aria-hidden={!open}>
      <div className="ops-log-drawer-header">
        <div>
          <h3>Step logs</h3>
          {stepName ? <p className="ops-log-drawer-sub">{stepName}</p> : null}
          <p className="ops-log-drawer-sub mono">syncJobId: {syncJobId ?? "—"}</p>
        </div>
        <button type="button" className="ops-modal-close" onClick={onClose} aria-label="Close drawer">
          ×
        </button>
      </div>
      <div className="ops-log-drawer-body">
        {loading ? <p className="ops-log-drawer-muted">Loading…</p> : null}
        {error ? <p className="ops-log-drawer-error">{error}</p> : null}
        {!loading && !error && lines.length === 0 ? <p className="ops-log-drawer-muted">No log lines for this step.</p> : null}
        {lines.length > 0 ? (
          <pre className="ops-log-drawer-pre">{lines.join("\n---\n")}</pre>
        ) : null}
      </div>
    </div>
  );
}
