import { authHeaderFromStoredToken } from "../auth-client";
import { resolveApiBase } from "../api-base";
import type {
  ChannelChatHistoryResponse,
  RagKnowledgeBaseOption,
  SlackDeployment,
  SlackDeploymentActivateRequest
} from "./types";

type Method = "GET" | "POST" | "PUT" | "DELETE";

async function requestJson<T>(path: string, method: Method = "GET", body?: unknown): Promise<T> {
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
  if (!response.ok) throw new Error(payload.details ?? payload.error ?? `Request failed ${response.status}`);
  return payload as T;
}

export function fetchSlackDeployments(): Promise<SlackDeployment[]> {
  return requestJson<SlackDeployment[]>("/slack/deployments");
}

export function createSlackDeployment(deploymentName: string, installMode: "oauth" | "manual" = "oauth"): Promise<SlackDeployment> {
  return requestJson<SlackDeployment>("/slack/deployments", "POST", { deploymentName, installMode });
}

export function startSlackOAuthConnect(deploymentId: string): Promise<{ url: string }> {
  return requestJson<{ url: string }>(`/slack/oauth/connect?deploymentId=${encodeURIComponent(deploymentId)}`);
}

export function activateSlackDeployment(id: string, body: SlackDeploymentActivateRequest): Promise<SlackDeployment> {
  return requestJson<SlackDeployment>(`/slack/deployments/${id}/activate`, "POST", body);
}

export function validateSlackToken(botToken: string): Promise<{ workspaceId: string; workspaceName: string; botUserId: string }> {
  return requestJson("/slack/validate-token", "POST", { botToken });
}

export function updateSlackDeployment(id: string, body: Partial<SlackDeploymentActivateRequest> & { deploymentName?: string }): Promise<SlackDeployment> {
  return requestJson<SlackDeployment>(`/slack/deployments/${id}`, "PUT", body);
}

export function deleteSlackDeployment(id: string): Promise<{ deleted: boolean }> {
  return requestJson(`/slack/deployments/${id}`, "DELETE");
}

export function deactivateSlackDeployment(id: string): Promise<{ deactivated: boolean }> {
  return requestJson(`/slack/deployments/${id}/deactivate`, "POST");
}

export function fetchChannelHistory(deploymentId: string, cursor?: string): Promise<ChannelChatHistoryResponse> {
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);
  return requestJson<ChannelChatHistoryResponse>(`/channels/history/${deploymentId}?${query.toString()}`);
}

export function clearChannelThread(deploymentId: string, threadId: string): Promise<{ deleted: boolean }> {
  return requestJson(`/channels/history/${deploymentId}/thread/${threadId}`, "DELETE");
}

export function clearAllChannelHistory(deploymentId: string): Promise<{ deleted: number }> {
  return requestJson(`/channels/history/${deploymentId}`, "DELETE");
}

export function fetchKnowledgeBases(): Promise<RagKnowledgeBaseOption[]> {
  return requestJson<RagKnowledgeBaseOption[]>("/rag/knowledge-bases");
}
