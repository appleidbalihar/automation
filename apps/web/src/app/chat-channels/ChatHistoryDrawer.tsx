"use client";

import { useEffect, useState, type ReactElement } from "react";
import { clearAllChannelHistory, clearChannelThread, fetchChannelHistory } from "./api";
import type { ChannelChatThreadSummary, SlackDeployment } from "./types";

interface Props {
  deployment: SlackDeployment | null;
  onClose: () => void;
}

export function ChatHistoryDrawer({ deployment, onClose }: Props): ReactElement | null {
  const [threads, setThreads] = useState<ChannelChatThreadSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(cursor?: string): Promise<void> {
    if (!deployment) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchChannelHistory(deployment.id, cursor);
      setThreads((current) => cursor ? [...current, ...response.threads] : response.threads);
      setNextCursor(response.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (deployment) void load();
  }, [deployment?.id]);

  if (!deployment) return null;

  return (
    <>
      <button type="button" className="ops-log-drawer-backdrop" aria-label="Close history drawer" onClick={onClose} />
      <aside className="ops-log-drawer ops-log-drawer-open" aria-hidden={false}>
        <div className="ops-log-drawer-header">
          <div>
            <h2>History</h2>
            <p className="ops-log-drawer-sub">{deployment.deploymentName}</p>
          </div>
          <button type="button" className="ops-modal-close" onClick={onClose} aria-label="Close drawer">×</button>
        </div>
        <div className="ops-log-drawer-body">
          {error ? <p className="ops-log-drawer-error">{error}</p> : null}
          {threads.map((thread) => (
            <div key={thread.id} className="ops-card" style={{ marginBottom: 10 }}>
              <strong>{thread.externalUserId ?? thread.externalThreadKey}</strong>
              <p>{thread.messageCount ?? 0} messages · {new Date(thread.lastMessageAt).toLocaleString()}</p>
              <button type="button" onClick={() => clearChannelThread(deployment.id, thread.id).then(() => load())}>Clear</button>
            </div>
          ))}
          {!loading && threads.length === 0 ? <p className="ops-log-drawer-muted">No channel history yet.</p> : null}
          {nextCursor ? <button type="button" onClick={() => load(nextCursor)} disabled={loading}>Load older</button> : null}
          <button type="button" onClick={() => clearAllChannelHistory(deployment.id).then(() => load())} disabled={threads.length === 0}>Clear All</button>
        </div>
      </aside>
    </>
  );
}
