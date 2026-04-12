"use client";

import { useEffect, useState } from "react";
import type { ReactElement } from "react";
import Link from "next/link";
import { StatusBadge } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";

const TOKEN_STORAGE_KEY = "ops_bearer_token";

interface OrderSummary {
  id: string;
  status: string;
  currentNodeOrder: number;
  currentStepIndex: number;
  lastError?: string | null;
  updatedAt: string;
}

function authHeader(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  const token = raw.trim().replace(/^Bearer\s+/i, "");
  return token ? `Bearer ${token}` : undefined;
}

async function fetchOrders(path: string): Promise<OrderSummary[]> {
  const headers: Record<string, string> = {};
  const auth = authHeader();
  if (auth) {
    headers.authorization = auth;
  }
  const response = await fetch(`${resolveApiBase()}${path}`, { headers });
  if (!response.ok) {
    throw new Error(`Request failed for ${path}: ${response.status}`);
  }
  return (await response.json()) as OrderSummary[];
}

export function DashboardOverview(): ReactElement {
  const [orders, setOrders] = useState<OrderSummary[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<OrderSummary[]>([]);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    let active = true;
    const load = async (): Promise<void> => {
      try {
        const [orderData, approvalData] = await Promise.all([
          fetchOrders("/orders?limit=100"),
          fetchOrders("/orders/approvals?limit=100")
        ]);
        if (!active) return;
        setOrders(orderData);
        setPendingApprovals(approvalData);
        setError("");
      } catch (fetchError) {
        if (!active) return;
        setError(fetchError instanceof Error ? fetchError.message : "Failed to load dashboard data");
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const runningCount = orders.filter((order) => order.status === "RUNNING").length;
  const failedCount = orders.filter((order) => order.status === "FAILED").length;
  const latestCheckpointOrder = [...orders]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .find((order) => order.currentNodeOrder > 0 || order.currentStepIndex > 0);

  return (
    <>
      <div className="card-grid">
        <div className="card">
          <h4>Orders Running</h4>
          <p style={{ fontSize: 28, margin: "6px 0" }}>{runningCount}</p>
          <StatusBadge status="RUNNING" />
        </div>
        <div className="card">
          <h4>Pending Approvals</h4>
          <p style={{ fontSize: 28, margin: "6px 0" }}>{pendingApprovals.length}</p>
          <StatusBadge status={pendingApprovals.length > 0 ? "PENDING_APPROVAL" : "SUCCESS"} />
        </div>
        <div className="card">
          <h4>Failed Orders</h4>
          <p style={{ fontSize: 28, margin: "6px 0" }}>{failedCount}</p>
          <StatusBadge status={failedCount > 0 ? "FAILED" : "SUCCESS"} />
        </div>
      </div>

      <section className="card">
        <h4 style={{ marginTop: 0 }}>Latest Checkpoint</h4>
        {latestCheckpointOrder ? (
          <p style={{ marginBottom: 0 }}>
            {latestCheckpointOrder.id} (node={latestCheckpointOrder.currentNodeOrder}, step={latestCheckpointOrder.currentStepIndex})
          </p>
        ) : (
          <p style={{ marginBottom: 0 }}>No checkpoint data available yet.</p>
        )}
      </section>

      <section className="card">
        <h4 style={{ marginTop: 0 }}>Recent Orders</h4>
        <div className="ops-table-wrap">
          <table className="ops-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Status</th>
                <th>Node/Step</th>
                <th>Last Error</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {orders.length === 0 ? (
                <tr>
                  <td colSpan={5}>No orders found.</td>
                </tr>
              ) : (
                orders.slice(0, 20).map((order) => (
                  <tr key={order.id}>
                    <td>
                      <Link href={`/orders?orderId=${encodeURIComponent(order.id)}`}>{order.id}</Link>
                    </td>
                    <td>{order.status}</td>
                    <td>
                      {order.currentNodeOrder}/{order.currentStepIndex}
                    </td>
                    <td>{order.lastError ?? "-"}</td>
                    <td>{new Date(order.updatedAt).toLocaleString()}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {error ? <p className="ops-error">{error}</p> : null}
      </section>
    </>
  );
}
