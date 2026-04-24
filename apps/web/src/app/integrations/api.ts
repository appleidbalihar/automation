import { authHeaderFromStoredToken } from "../auth-client";
import { resolveApiBase } from "../api-base";
import type { Integration, SyncJob } from "./types";

export async function requestJson<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const authorization = authHeaderFromStoredToken();
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
  if (!response.ok) {
    throw new Error(payload.details ?? payload.error ?? `Request failed ${response.status}`);
  }
  return payload as T;
}

export async function loadIntegrations(): Promise<Integration[]> {
  return requestJson<Integration[]>("/rag/integrations", "GET");
}

export type SyncStatusResponse = SyncJob | { status: "never_synced"; knowledgeBaseId: string };

export async function fetchSyncStatus(knowledgeBaseId: string): Promise<SyncStatusResponse> {
  return requestJson<SyncStatusResponse>(`/rag/knowledge-bases/${knowledgeBaseId}/sync-status`, "GET");
}

export async function fetchSyncHistory(knowledgeBaseId: string, limit = 50): Promise<{ jobs: SyncJob[] }> {
  return requestJson<{ jobs: SyncJob[] }>(`/rag/knowledge-bases/${knowledgeBaseId}/sync-history?limit=${limit}`, "GET");
}

export type SyncJobLogsResponse = {
  source: string;
  logs: unknown[];
};

export async function fetchSyncJobLogs(syncJobId: string, stepName?: string): Promise<SyncJobLogsResponse> {
  const params = new URLSearchParams({ syncJobId });
  if (stepName) params.set("stepName", stepName);
  return requestJson<SyncJobLogsResponse>(`/logs/sync-job?${params.toString()}`, "GET");
}

export function isActiveSyncStatus(status: string): boolean {
  const s = status.toLowerCase();
  return s === "running" || s === "pending";
}
