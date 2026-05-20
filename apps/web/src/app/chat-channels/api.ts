import { authHeaderFromStoredToken } from "../auth-client";
import { resolveApiBase } from "../api-base";
import type {
  ChannelChatHistoryResponse,
  RagKnowledgeBaseOption,
  SlackDeployment,
  SlackDeploymentActivateRequest
} from "./types";
import type { SlackUserKbMapping } from "@platform/contracts";

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

export function createSlackDeployment(deploymentName: string, installMode: "oauth" | "manual" = "oauth", id?: string): Promise<SlackDeployment> {
  return requestJson<SlackDeployment>("/slack/deployments", "POST", { deploymentName, installMode, ...(id ? { id } : {}) });
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

export function fetchSharedSlackDeployments(): Promise<SlackDeployment[]> {
  return requestJson<SlackDeployment[]>("/slack/deployments/shared");
}

export function fetchMemberOfDeployments(): Promise<SlackDeployment[]> {
  return requestJson<SlackDeployment[]>("/slack/deployments/member-of");
}

export function fetchMyConnections(): Promise<Array<{ deploymentId: string; slackUserId: string; kbIds: string[]; status: string }>> {
  return requestJson("/slack/deployments/my-connections");
}

export function getSlackIdentityOAuthUrl(deploymentId: string, kbIds: string[]): Promise<{ oauthAvailable: boolean; url?: string }> {
  const params = new URLSearchParams({ kbIds: kbIds.join(",") });
  return requestJson(`/slack/deployments/${deploymentId}/members/self/oauth?${params}`);
}

export function getSlackInstallUrl(deploymentId: string): Promise<{ installAvailable: boolean; url?: string; botUserId?: string }> {
  return requestJson(`/slack/deployments/${deploymentId}/install-url`);
}

export function fetchDeploymentMembers(deploymentId: string): Promise<SlackUserKbMapping[]> {
  return requestJson<SlackUserKbMapping[]>(`/slack/deployments/${deploymentId}/members`);
}

export function addDeploymentMember(
  deploymentId: string,
  member: { slackUserId: string; rapidragUserId?: string; rapidragUsername?: string; kbIds?: string[] }
): Promise<SlackUserKbMapping> {
  return requestJson<SlackUserKbMapping>(`/slack/deployments/${deploymentId}/members`, "POST", member);
}

export function removeDeploymentMember(deploymentId: string, slackUserId: string): Promise<{ deleted: boolean }> {
  return requestJson(`/slack/deployments/${deploymentId}/members/${encodeURIComponent(slackUserId)}`, "DELETE");
}

export function selfRegisterSlackMember(
  deploymentId: string,
  body: { slackUserId: string; kbIds?: string[] }
): Promise<SlackUserKbMapping> {
  return requestJson<SlackUserKbMapping>(`/slack/deployments/${deploymentId}/members/self`, "POST", body);
}
