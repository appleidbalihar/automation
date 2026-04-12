"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Panel, StatusBadge } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";

const TOKEN_STORAGE_KEY = "ops_bearer_token";

interface AuthIdentity {
  userId: string;
  roles: string[];
}

interface ApprovalOrder {
  id: string;
  status: string;
  currentNodeOrder: number;
  currentStepIndex: number;
  initiatedBy: string;
  updatedAt: string;
}

interface ApprovalDecision {
  id: string;
  decision: string;
  decidedBy: string;
  comment?: string | null;
  createdAt: string;
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

async function postJson(path: string, body: unknown): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = authHeader();
  if (auth) {
    headers.authorization = auth;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
}

function formatTs(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function canDecide(identity: AuthIdentity | null): boolean {
  const roles = identity?.roles ?? ["viewer"];
  return roles.includes("admin") || roles.includes("useradmin") || roles.includes("operator") || roles.includes("approver");
}

export function ApprovalsConsole(): ReactElement {
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [orders, setOrders] = useState<ApprovalOrder[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [decisions, setDecisions] = useState<ApprovalDecision[]>([]);
  const [comment, setComment] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  useEffect(() => {
    fetchJson<AuthIdentity>("/auth/me").then(setIdentity).catch(() => setIdentity(null));
  }, []);

  useEffect(() => {
    let active = true;
    const loadQueue = async (): Promise<void> => {
      try {
        const data = await fetchJson<ApprovalOrder[]>("/orders/approvals?limit=100");
        if (!active) return;
        setOrders(data);
        if (!selectedOrderId && data.length > 0) {
          setSelectedOrderId(data[0].id);
        }
        setError("");
      } catch (loadError) {
        if (!active) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load approval queue");
      }
    };

    void loadQueue();
    const timer = window.setInterval(() => void loadQueue(), 8000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [refreshNonce, selectedOrderId]);

  useEffect(() => {
    let active = true;
    if (!selectedOrderId) {
      setDecisions([]);
      return () => {
        active = false;
      };
    }
    fetchJson<ApprovalDecision[]>(`/orders/${selectedOrderId}/approvals`)
      .then((rows) => {
        if (!active) return;
        setDecisions(rows);
      })
      .catch(() => {
        if (!active) return;
        setDecisions([]);
      });
    return () => {
      active = false;
    };
  }, [selectedOrderId, refreshNonce]);

  async function decide(orderId: string, action: "approve" | "reject"): Promise<void> {
    setStatus(`Submitting ${action}...`);
    setError("");
    try {
      await postJson(`/orders/${orderId}/${action}`, {
        decidedBy: identity?.userId ?? "unknown",
        comment: comment || (action === "approve" ? "Approved from approvals page" : "Rejected from approvals page")
      });
      setStatus(`Order ${action}d.`);
      setRefreshNonce((value) => value + 1);
    } catch (decisionError) {
      setStatus("");
      setError(decisionError instanceof Error ? decisionError.message : `${action} failed`);
    }
  }

  return (
    <>
      <Panel title="Approval Queue">
        <p className="ops-status-line">Pending approvals: {orders.length}</p>
        <div className="builder-top-row">
          <label htmlFor="approval-page-comment">Decision Comment</label>
          <input
            id="approval-page-comment"
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            placeholder="Optional approval/rejection reason"
          />
          <button type="button" onClick={() => setRefreshNonce((value) => value + 1)}>
            Refresh
          </button>
        </div>
        <p className="ops-status-line">Status: {status || "-"}</p>
        {error ? <p className="ops-error">{error}</p> : null}

        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Current Node/Step</th>
                <th>Initiated By</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={6}>No pending approvals.</td>
                </tr>
              ) : (
                orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <button type="button" onClick={() => setSelectedOrderId(order.id)}>
                        {order.id}
                      </button>
                    </td>
                    <td>
                      <StatusBadge status={order.status} />
                    </td>
                    <td>
                      {order.currentNodeOrder}/{order.currentStepIndex}
                    </td>
                    <td>{order.initiatedBy}</td>
                    <td>{formatTs(order.updatedAt)}</td>
                    <td>
                      <div className="approval-actions">
                        <button type="button" disabled={!canDecide(identity)} onClick={() => void decide(order.id, "approve")}>
                          Approve
                        </button>
                        <button type="button" disabled={!canDecide(identity)} onClick={() => void decide(order.id, "reject")}>
                          Reject
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Approval History">
        <p className="ops-status-line">Selected order: {selectedOrderId || "-"}</p>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Decision</th>
                <th>Decided By</th>
                <th>Comment</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {decisions.length === 0 ? (
                <tr>
                  <td colSpan={4}>No approval decisions recorded.</td>
                </tr>
              ) : (
                decisions.map((decision) => (
                  <tr key={decision.id}>
                    <td>{decision.decision}</td>
                    <td>{decision.decidedBy}</td>
                    <td>{decision.comment || "-"}</td>
                    <td>{formatTs(decision.createdAt)}</td>
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
