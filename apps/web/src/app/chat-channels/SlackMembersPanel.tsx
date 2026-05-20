"use client";

import { type ReactElement, useEffect, useState } from "react";
import { addDeploymentMember, fetchDeploymentMembers, fetchKnowledgeBases, removeDeploymentMember } from "./api";
import type { RagKnowledgeBaseOption, SlackDeployment, SlackUserKbMapping } from "./types";

interface Props {
  deployment: SlackDeployment;
  onClose: () => void;
}

export function SlackMembersPanel({ deployment, onClose }: Props): ReactElement {
  const [members, setMembers] = useState<SlackUserKbMapping[]>([]);
  const [kbs, setKbs] = useState<RagKnowledgeBaseOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [addSlackUserId, setAddSlackUserId] = useState("");
  const [addRapidragUserId, setAddRapidragUserId] = useState("");
  const [addKbIds, setAddKbIds] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    Promise.all([fetchDeploymentMembers(deployment.id), fetchKnowledgeBases()])
      .then(([m, k]) => { setMembers(m); setKbs(k); })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [deployment.id]);

  async function handleAdd(): Promise<void> {
    if (!addSlackUserId.trim()) { setError("Slack user ID is required."); return; }
    setAdding(true);
    setError(null);
    try {
      const member = await addDeploymentMember(deployment.id, {
        slackUserId: addSlackUserId.trim(),
        rapidragUserId: addRapidragUserId.trim() || undefined,
        rapidragUsername: addRapidragUserId.trim() || undefined,
        kbIds: addKbIds
      });
      setMembers((prev) => {
        const idx = prev.findIndex((m) => m.slackUserId === member.slackUserId);
        if (idx >= 0) { const next = [...prev]; next[idx] = member; return next; }
        return [...prev, member];
      });
      setAddSlackUserId("");
      setAddRapidragUserId("");
      setAddKbIds([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(slackUserId: string): Promise<void> {
    if (!window.confirm(`Remove Slack user ${slackUserId} from this deployment?`)) return;
    try {
      await removeDeploymentMember(deployment.id, slackUserId);
      setMembers((prev) => prev.filter((m) => m.slackUserId !== slackUserId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function kbName(id: string): string {
    return kbs.find((k) => k.id === id)?.name ?? id;
  }

  return (
    <div className="ops-modal-overlay" role="presentation" onClick={onClose}>
      <div className="ops-modal-panel" role="dialog" aria-modal="true" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="ops-modal-panel-header">
          <h2>{deployment.deploymentName} — Members</h2>
          <button type="button" className="ops-modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="ops-modal-form" style={{ gap: 16 }}>
          {error && <p className="tpl-error">{error}</p>}

          {loading ? (
            <p className="tpl-loading">Loading members…</p>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: "2px solid #e2e8f0", textAlign: "left" }}>
                  <th style={{ padding: "6px 10px" }}>RapidRAG user</th>
                  <th style={{ padding: "6px 10px" }}>Slack user ID</th>
                  <th style={{ padding: "6px 10px" }}>KBs</th>
                  <th style={{ padding: "6px 10px" }}>Status</th>
                  <th style={{ padding: "6px 10px" }}></th>
                </tr>
              </thead>
              <tbody>
                {members.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ padding: "16px 10px", color: "#94a3b8", textAlign: "center" }}>No members yet.</td>
                  </tr>
                )}
                {members.map((m) => {
                  const isSynthetic = m.slackUserId.startsWith("rapidrag:");
                  return (
                    <tr key={m.id} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "8px 10px" }}>{m.rapidragUsername ?? m.rapidragUserId ?? <span style={{ color: "#94a3b8" }}>—</span>}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "monospace", fontSize: 12 }}>
                        {isSynthetic ? <span style={{ color: "#94a3b8" }}>—</span> : m.slackUserId}
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        {m.kbIds.length === 0 ? <span style={{ color: "#94a3b8" }}>—</span> : m.kbIds.map((id) => (
                          <span key={id} className="tpl-badge tpl-badge-category" style={{ marginRight: 4 }}>{kbName(id)}</span>
                        ))}
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        {isSynthetic
                          ? <span className="tpl-badge" style={{ background: "#fef3c7", color: "#92400e", borderColor: "#fbbf24" }}>Not linked</span>
                          : <span className={`tpl-badge ${m.status === "connected" ? "tpl-badge-shared" : "tpl-badge-category"}`}>{m.status}</span>
                        }
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <button type="button" className="ops-btn ops-btn-sm ops-btn-ghost tpl-btn-danger" onClick={() => handleRemove(m.slackUserId).catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                          Remove
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <hr style={{ border: "none", borderTop: "1px solid #e2e8f0" }} />

          <h3 style={{ margin: 0, fontSize: 14 }}>Add member manually</h3>
          <div className="tpl-form-row" style={{ gap: 12, alignItems: "flex-end" }}>
            <div className="tpl-form-field tpl-form-field-grow">
              <label>Slack user ID</label>
              <input className="tpl-input" value={addSlackUserId} onChange={(e) => setAddSlackUserId(e.target.value)} placeholder="U01ABC123XY" />
            </div>
            <div className="tpl-form-field tpl-form-field-grow">
              <label>RapidRAG username (optional)</label>
              <input className="tpl-input" value={addRapidragUserId} onChange={(e) => setAddRapidragUserId(e.target.value)} placeholder="useradmin.john" />
            </div>
          </div>
          <div className="tpl-form-field">
            <label>Assign KBs</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {kbs.map((kb) => (
                <label key={kb.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={addKbIds.includes(kb.id)}
                    onChange={(e) => setAddKbIds((prev) => e.target.checked ? [...prev, kb.id] : prev.filter((id) => id !== kb.id))}
                  />
                  {kb.name}
                </label>
              ))}
            </div>
          </div>
          <div>
            <button type="button" className="ops-btn ops-btn-sm ops-btn-primary" onClick={() => handleAdd().catch((err) => setError(err instanceof Error ? err.message : String(err)))} disabled={adding}>
              {adding ? "Adding…" : "Add member"}
            </button>
          </div>
        </div>

        <div className="ops-modal-footer">
          <button type="button" className="ops-btn ops-btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
