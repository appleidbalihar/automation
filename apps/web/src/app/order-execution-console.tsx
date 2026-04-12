"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import { Panel, StatusBadge } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";

interface AuthIdentity {
  userId: string;
  roles: string[];
}

interface OrderCheckpoint {
  nodeOrder: number;
  stepIndex: number;
  createdAt: string;
}

interface OrderTransition {
  from: string;
  to: string;
  reason?: string | null;
  createdAt: string;
}

interface OrderStepExecution {
  nodeId: string;
  stepId: string;
  status: string;
  retryCount: number;
  durationMs: number;
  errorMessage?: string | null;
  startedAt: string;
}

interface OrderDetails {
  id: string;
  status: string;
  environmentId?: string | null;
  currentNodeOrder: number;
  currentStepIndex: number;
  lastError?: string | null;
  checkpoints: OrderCheckpoint[];
  transitions: OrderTransition[];
  stepExecutions: OrderStepExecution[];
  approvals?: Array<{
    decision: string;
    decidedBy: string;
    comment?: string | null;
    createdAt: string;
  }>;
  updatedAt: string;
}

interface OrderSummary {
  id: string;
  workflowVersionId: string;
  status: string;
  currentNodeOrder: number;
  currentStepIndex: number;
  failurePolicy: string;
  correlationId: string;
  lastError?: string | null;
  initiatedBy: string;
  createdAt: string;
  updatedAt: string;
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

const TOKEN_STORAGE_KEY = "ops_bearer_token";

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
  const authorization = authHeader();
  if (authorization) {
    headers.authorization = authorization;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

async function postNoBody(path: string): Promise<void> {
  const headers: Record<string, string> = {};
  const authorization = authHeader();
  if (authorization) {
    headers.authorization = authorization;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, { method: "POST", headers });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  const authorization = authHeader();
  if (authorization) {
    headers.authorization = authorization;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as T;
}

function formatTs(value?: string): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function hasRole(identity: AuthIdentity | null, required: string[]): boolean {
  const roles = identity?.roles ?? ["viewer"];
  return required.some((role) => roles.includes(role));
}

export function OrderExecutionConsole(props: { initialOrderId?: string }): ReactElement {
  const [identity, setIdentity] = useState<AuthIdentity | null>(null);
  const [orderIdInput, setOrderIdInput] = useState<string>("");
  const [selectedOrderId, setSelectedOrderId] = useState<string>("");
  const [recentOrders, setRecentOrders] = useState<OrderSummary[]>([]);
  const [approvalQueue, setApprovalQueue] = useState<OrderSummary[]>([]);
  const [order, setOrder] = useState<OrderDetails | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [approvalComment, setApprovalComment] = useState<string>("");
  const [refreshNonce, setRefreshNonce] = useState<number>(0);

  useEffect(() => {
    const initialOrderId = (props.initialOrderId ?? "").trim();
    if (!initialOrderId) return;
    setOrderIdInput(initialOrderId);
    setSelectedOrderId(initialOrderId);
    setStatus("Order loaded from URL.");
  }, [props.initialOrderId]);

  useEffect(() => {
    let mounted = true;
    fetchJson<AuthIdentity>("/auth/me")
      .then((ctx) => {
        if (!mounted) return;
        setIdentity(ctx);
      })
      .catch(() => {
        if (!mounted) return;
        setIdentity(null);
      });
    return () => {
      mounted = false;
    };
  }, [refreshNonce]);

  useEffect(() => {
    let mounted = true;
    async function loadOrderLists(): Promise<void> {
      const [recent, approvals] = await Promise.all([
        fetchJson<OrderSummary[]>("/orders?limit=30"),
        fetchJson<OrderSummary[]>("/orders/approvals?limit=30")
      ]);
      if (!mounted) return;
      setRecentOrders(recent);
      setApprovalQueue(approvals);
    }

    loadOrderLists().catch(() => undefined);
    const timer = window.setInterval(() => {
      loadOrderLists().catch(() => undefined);
    }, 8000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [refreshNonce]);

  useEffect(() => {
    let mounted = true;
    if (!selectedOrderId) {
      setOrder(null);
      setTimeline([]);
      return () => {
        mounted = false;
      };
    }

    async function loadOrderDetails(): Promise<void> {
      const [orderPayload, timelinePayload] = await Promise.all([
        fetchJson<OrderDetails>(`/orders/${selectedOrderId}`),
        fetchJson<TimelineResponse>(`/logs/timeline?orderId=${encodeURIComponent(selectedOrderId)}`)
      ]);
      if (!mounted) return;
      setOrder(orderPayload);
      setTimeline(timelinePayload.events);
    }

    loadOrderDetails()
      .then(() => {
        if (!mounted) return;
        setError("");
      })
      .catch((loadError) => {
        if (!mounted) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load order console data");
      });

    const timer = window.setInterval(() => {
      loadOrderDetails().catch(() => undefined);
    }, 6000);

    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [selectedOrderId, refreshNonce]);

  function trackOrder(): void {
    const id = orderIdInput.trim();
    if (!id) return;
    setSelectedOrderId(id);
    setStatus("Order selected in console.");
  }

  async function retrySelectedOrder(): Promise<void> {
    if (!selectedOrderId) return;
    setStatus("Submitting retry...");
    try {
      await postNoBody(`/orders/${selectedOrderId}/retry`);
      setStatus("Retry queued.");
      setRefreshNonce((value) => value + 1);
    } catch (retryError) {
      setStatus("");
      setError(retryError instanceof Error ? retryError.message : "Retry failed");
    }
  }

  async function rollbackSelectedOrder(): Promise<void> {
    if (!selectedOrderId) return;
    setStatus("Submitting rollback...");
    try {
      await postNoBody(`/orders/${selectedOrderId}/rollback`);
      setStatus("Rollback completed.");
      setRefreshNonce((value) => value + 1);
    } catch (rollbackError) {
      setStatus("");
      setError(rollbackError instanceof Error ? rollbackError.message : "Rollback failed");
    }
  }

  async function requestApprovalSelectedOrder(): Promise<void> {
    if (!selectedOrderId) return;
    setStatus("Requesting approval...");
    try {
      await postJson(`/orders/${selectedOrderId}/request-approval`, {
        requestedBy: identity?.userId ?? "unknown",
        comment: approvalComment || "Approval requested from console"
      });
      setStatus("Approval requested.");
      setRefreshNonce((value) => value + 1);
    } catch (requestError) {
      setStatus("");
      setError(requestError instanceof Error ? requestError.message : "Approval request failed");
    }
  }

  async function approveOrder(orderId: string): Promise<void> {
    setStatus("Submitting approval...");
    try {
      await postJson(`/orders/${orderId}/approve`, {
        decidedBy: identity?.userId ?? "unknown",
        comment: approvalComment || "Approved from console"
      });
      setStatus("Order approved.");
      setSelectedOrderId(orderId);
      setRefreshNonce((value) => value + 1);
    } catch (approveError) {
      setStatus("");
      setError(approveError instanceof Error ? approveError.message : "Approve failed");
    }
  }

  async function rejectOrder(orderId: string): Promise<void> {
    setStatus("Submitting rejection...");
    try {
      await postJson(`/orders/${orderId}/reject`, {
        decidedBy: identity?.userId ?? "unknown",
        comment: approvalComment || "Rejected from console"
      });
      setStatus("Order rejected.");
      setSelectedOrderId(orderId);
      setRefreshNonce((value) => value + 1);
    } catch (rejectError) {
      setStatus("");
      setError(rejectError instanceof Error ? rejectError.message : "Reject failed");
    }
  }

  const lastCheckpoint = order?.checkpoints?.[order.checkpoints.length - 1];
  const canRetryRollback = hasRole(identity, ["admin", "useradmin", "operator"]) && Boolean(selectedOrderId);
  const canRequestApproval = hasRole(identity, ["admin", "useradmin", "operator"]) && Boolean(selectedOrderId);
  const canDecideApproval = hasRole(identity, ["admin", "useradmin", "operator", "approver"]);

  return (
    <>
      <Panel title="Order Execution Console">
        <div className="builder-top-row">
          <label htmlFor="order-id-console">Order ID</label>
          <input
            id="order-id-console"
            value={orderIdInput}
            onChange={(event) => setOrderIdInput(event.target.value)}
            placeholder="Paste order id"
          />
          <button type="button" onClick={trackOrder}>
            Track Order
          </button>
        </div>

        <div className="ops-actions-grid">
          <button type="button" onClick={() => setRefreshNonce((value) => value + 1)}>
            Refresh
          </button>
          <button type="button" disabled={!canRequestApproval} onClick={() => requestApprovalSelectedOrder().catch(() => undefined)}>
            Request Approval
          </button>
          <button type="button" disabled={!canRetryRollback} onClick={() => retrySelectedOrder().catch(() => undefined)}>
            Retry Selected
          </button>
          <button type="button" disabled={!canRetryRollback} onClick={() => rollbackSelectedOrder().catch(() => undefined)}>
            Rollback Selected
          </button>
        </div>

        <div className="builder-top-row">
          <label htmlFor="approval-comment">Approval Comment</label>
          <input
            id="approval-comment"
            value={approvalComment}
            onChange={(event) => setApprovalComment(event.target.value)}
            placeholder="Reason for approval request/decision"
          />
          <span />
        </div>

        <p className="ops-status-line">Selected order: {selectedOrderId || "-"}</p>
        <p className="ops-status-line">Action status: {status || "-"}</p>
        {error ? <p className="ops-error">{error}</p> : null}

        {order ? (
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Environment</th>
                  <th>Current Node</th>
                  <th>Current Step</th>
                  <th>Last Checkpoint</th>
                  <th>Failure Cause</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <StatusBadge status={order.status} />
                  </td>
                  <td>{order.environmentId || "-"}</td>
                  <td>{order.currentNodeOrder}</td>
                  <td>{order.currentStepIndex}</td>
                  <td>
                    {lastCheckpoint ? `${lastCheckpoint.nodeOrder}/${lastCheckpoint.stepIndex} @ ${formatTs(lastCheckpoint.createdAt)}` : "-"}
                  </td>
                  <td>{order.lastError || "-"}</td>
                </tr>
              </tbody>
            </table>
          </div>
        ) : (
          <p className="ops-status-line">Load an order to view live execution details.</p>
        )}

        <div className="tracked-order-chips">
          {recentOrders.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSelectedOrderId(item.id)}
              className={item.id === selectedOrderId ? "chip-active" : ""}
            >
              {item.id.slice(0, 16)} {item.status}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="Approval Queue">
        <p className="ops-status-line">Pending approvals: {approvalQueue.length}</p>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Last Update</th>
                <th>Current Node/Step</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {approvalQueue.length === 0 ? (
                <tr>
                  <td colSpan={5}>No orders currently in `PENDING_APPROVAL`.</td>
                </tr>
              ) : (
                approvalQueue.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <button type="button" onClick={() => setSelectedOrderId(item.id)}>
                        {item.id}
                      </button>
                    </td>
                    <td>
                      <StatusBadge status={item.status} />
                    </td>
                    <td>{formatTs(item.updatedAt)}</td>
                    <td>
                      {item.currentNodeOrder}/{item.currentStepIndex}
                    </td>
                    <td>
                      <div className="approval-actions">
                        <button
                          type="button"
                          disabled={!canDecideApproval}
                          onClick={() => approveOrder(item.id).catch(() => undefined)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          disabled={!canDecideApproval}
                          onClick={() => rejectOrder(item.id).catch(() => undefined)}
                        >
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

      <Panel title="Order Historical Timeline">
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
                  <td colSpan={3}>No timeline events yet.</td>
                </tr>
              ) : (
                timeline.slice(-30).reverse().map((event, index) => (
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
