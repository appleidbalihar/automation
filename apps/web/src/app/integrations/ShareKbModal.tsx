"use client";

import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { resolveApiBase } from "../api-base";
import { authHeaderFromStoredToken } from "../auth-client";

type KbShare = {
  id: string;
  knowledgeBaseId: string;
  sharedWithId: string;
  sharedById: string;
  permission: string;
  createdAt: string;
};

type Props = {
  kbId: string;
  kbName: string;
  onClose: () => void;
};

function buildHeaders(hasBody: boolean): Record<string, string> {
  const authorization = authHeaderFromStoredToken();
  if (!authorization) throw new Error("Not signed in");
  return {
    authorization,
    ...(hasBody ? { "content-type": "application/json" } : {})
  };
}

async function apiCall<T>(path: string, method: string, body?: unknown): Promise<T> {
  const hasBody = body !== undefined;
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method,
    headers: buildHeaders(hasBody),
    ...(hasBody ? { body: JSON.stringify(body) } : {})
  });
  if (response.status === 204) return {} as T;
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string" ? payload.error :
        typeof payload.details === "string" ? payload.details :
          `Request failed: ${response.status}`
    );
  }
  return payload as T;
}

export function ShareKbModal({ kbId, kbName, onClose }: Props): ReactElement {
  const [shares, setShares] = useState<KbShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUserId, setNewUserId] = useState("");
  const [sharing, setSharing] = useState(false);
  const [revoking, setRevoking] = useState<string>("");
  const [error, setError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  const loadShares = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiCall<{ shares: KbShare[] }>(`/rag/knowledge-bases/${kbId}/shares`, "GET");
      setShares(data.shares ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load shares");
    } finally {
      setLoading(false);
    }
  }, [kbId]);

  useEffect(() => {
    void loadShares();
  }, [loadShares]);

  async function handleShare(): Promise<void> {
    const username = newUserId.trim();
    if (!username) return;
    setSharing(true);
    setError("");
    setSuccessMsg("");
    try {
      const share = await apiCall<KbShare>(`/rag/knowledge-bases/${kbId}/shares`, "POST", {
        sharedWithUserId: username
      });
      setShares((prev) => [...prev, share]);
      setNewUserId("");
      setSuccessMsg(`Shared with "${username}" successfully.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to share");
    } finally {
      setSharing(false);
    }
  }

  async function handleRevoke(shareId: string, sharedWithId: string): Promise<void> {
    setRevoking(shareId);
    setError("");
    setSuccessMsg("");
    try {
      await apiCall(`/rag/knowledge-bases/${kbId}/shares/${shareId}`, "DELETE");
      setShares((prev) => prev.filter((s) => s.id !== shareId));
      setSuccessMsg(`Access revoked for "${sharedWithId}".`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke share");
    } finally {
      setRevoking("");
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Enter") void handleShare();
    if (e.key === "Escape") onClose();
  }

  /* ── styles (inline, light-theme) ─────────────────────────────────────── */
  const overlay: React.CSSProperties = {
    position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)",
    display: "flex", alignItems: "center", justifyContent: "center",
    zIndex: 1000, padding: "1rem"
  };
  const panel: React.CSSProperties = {
    background: "#ffffff", border: "1px solid #e2e8f0",
    borderRadius: "16px", padding: "2rem", width: "100%",
    maxWidth: "520px", maxHeight: "80vh", overflowY: "auto",
    boxShadow: "0 20px 60px rgba(15,23,42,0.18)", color: "#0f172a"
  };
  const hdr: React.CSSProperties = {
    display: "flex", justifyContent: "space-between",
    alignItems: "flex-start", marginBottom: "1.25rem"
  };
  const infoBox: React.CSSProperties = {
    background: "#eff6ff", border: "1px solid #bfdbfe",
    borderRadius: "8px", padding: "0.75rem 1rem",
    fontSize: "0.8125rem", marginBottom: "1.5rem",
    lineHeight: 1.55, color: "#1e40af"
  };
  const label: React.CSSProperties = {
    display: "block", fontWeight: 600,
    fontSize: "0.875rem", marginBottom: "0.5rem", color: "#334155"
  };
  const inputRow: React.CSSProperties = { display: "flex", gap: "0.5rem", marginBottom: "1.5rem" };
  const input: React.CSSProperties = {
    flex: 1, padding: "0.6rem 0.75rem", borderRadius: "6px",
    border: "1px solid #cbd5e1", background: "#f8fafc",
    color: "#0f172a", fontSize: "0.875rem"
  };
  const shareBtn: React.CSSProperties = {
    padding: "0.6rem 1.1rem", borderRadius: "6px",
    background: "#0f766e", border: "none", color: "#fff",
    fontWeight: 700, cursor: "pointer", fontSize: "0.875rem",
    opacity: !newUserId.trim() || sharing ? 0.6 : 1
  };
  const errBox: React.CSSProperties = {
    background: "#fef2f2", border: "1px solid #fecaca",
    borderRadius: "6px", padding: "0.6rem 0.75rem",
    marginBottom: "1rem", color: "#991b1b", fontSize: "0.875rem"
  };
  const okBox: React.CSSProperties = {
    background: "#f0fdf4", border: "1px solid #bbf7d0",
    borderRadius: "6px", padding: "0.6rem 0.75rem",
    marginBottom: "1rem", color: "#166534", fontSize: "0.875rem"
  };
  const sectionTitle: React.CSSProperties = {
    fontSize: "0.9375rem", fontWeight: 700,
    marginBottom: "0.75rem", color: "#1e293b"
  };
  const emptyBox: React.CSSProperties = {
    textAlign: "center", padding: "1.5rem",
    background: "#f8fafc", borderRadius: "8px",
    border: "1px dashed #cbd5e1", color: "#64748b",
    fontSize: "0.875rem"
  };
  const shareRow: React.CSSProperties = {
    display: "flex", alignItems: "center",
    justifyContent: "space-between", padding: "0.625rem 0.875rem",
    background: "#f8fafc", borderRadius: "8px",
    border: "1px solid #e2e8f0", marginBottom: "0.5rem"
  };
  const revokeBtn: React.CSSProperties = {
    background: "#fef2f2", border: "1px solid #fecaca",
    borderRadius: "5px", padding: "0.3rem 0.65rem",
    color: "#dc2626", cursor: "pointer", fontSize: "0.8125rem",
    fontWeight: 600, whiteSpace: "nowrap"
  };
  const closeBtn: React.CSSProperties = {
    background: "none", border: "none", cursor: "pointer",
    fontSize: "1.5rem", lineHeight: 1, color: "#94a3b8", padding: "0.25rem"
  };
  const footerBtn: React.CSSProperties = {
    padding: "0.55rem 1.25rem", borderRadius: "6px",
    background: "#f1f5f9", border: "1px solid #cbd5e1",
    color: "#334155", cursor: "pointer", fontSize: "0.875rem", fontWeight: 600
  };

  return (
    <div
      style={overlay}
      role="dialog"
      aria-modal="true"
      aria-label={`Share "${kbName}"`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={panel}>
        {/* Header */}
        <div style={hdr}>
          <div>
            <h2 style={{ margin: 0, fontSize: "1.2rem", color: "#0f172a" }}>🔗 Share Knowledge Base</h2>
            <p style={{ margin: "0.25rem 0 0", color: "#64748b", fontSize: "0.875rem" }}>
              <strong style={{ color: "#0f172a" }}>{kbName}</strong> — grant chat access to other users
            </p>
          </div>
          <button type="button" onClick={onClose} style={closeBtn} aria-label="Close">×</button>
        </div>

        {/* Info banner */}
        <div style={infoBox}>
          <strong>Chat access only</strong> — shared users can query this knowledge base but cannot
          edit, sync, or delete it. Each user has their own private conversation history.
        </div>

        {/* Add share input */}
        <label style={label}>Share with user (enter their username)</label>
        <div style={inputRow}>
          <input
            type="text"
            value={newUserId}
            onChange={(e) => setNewUserId(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="e.g. bali"
            disabled={sharing}
            autoFocus
            style={input}
          />
          <button
            type="button"
            onClick={() => void handleShare()}
            disabled={!newUserId.trim() || sharing}
            style={shareBtn}
          >
            {sharing ? "Sharing…" : "Share"}
          </button>
        </div>

        {/* Status messages */}
        {error ? <div style={errBox}>{error}</div> : null}
        {successMsg ? <div style={okBox}>{successMsg}</div> : null}

        {/* Current shares list */}
        <div>
          <p style={sectionTitle}>People with access</p>

          {loading ? (
            <p style={{ color: "#64748b", fontSize: "0.875rem" }}>Loading…</p>
          ) : shares.length === 0 ? (
            <div style={emptyBox}>Not shared with anyone yet. Add a username above.</div>
          ) : (
            <div>
              {shares.map((share) => (
                <div key={share.id} style={shareRow}>
                  <div>
                    <span style={{ fontWeight: 700, fontSize: "0.9rem", color: "#0f172a" }}>
                      {share.sharedWithId}
                    </span>
                    <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "0.1rem" }}>
                      Chat access · shared by {share.sharedById} · {new Date(share.createdAt).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handleRevoke(share.id, share.sharedWithId)}
                    disabled={revoking === share.id}
                    style={{ ...revokeBtn, opacity: revoking === share.id ? 0.6 : 1 }}
                  >
                    {revoking === share.id ? "Revoking…" : "Revoke"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ marginTop: "1.75rem", display: "flex", justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} style={footerBtn}>Close</button>
        </div>
      </div>
    </div>
  );
}
