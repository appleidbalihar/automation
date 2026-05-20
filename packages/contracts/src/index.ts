export type RagDiscussionMessageRole = "user" | "assistant";
export type RagDiscussionBackend = "dify";

export interface RagDiscussionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  preview?: string;
  knowledgeBaseId?: string;
  knowledgeBaseIds?: string[];
  backend: RagDiscussionBackend;
}

export interface RagDiscussionKbResult {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
  ownerUsername?: string;
  answer: string;
  error?: string;
}

export interface RagDiscussionMessage {
  id: string;
  threadId: string;
  role: RagDiscussionMessageRole;
  content: string;
  createdAt: string;
  kbResults?: RagDiscussionKbResult[];
}

export interface RagDiscussionThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  knowledgeBaseId?: string;
  knowledgeBaseIds?: string[];
  backend: RagDiscussionBackend;
  messages: RagDiscussionMessage[];
}

export interface RagDiscussionCreateRequest {
  knowledgeBaseId?: string;
  knowledgeBaseIds?: string[];
}

export interface RagDiscussionSendMessageRequest {
  content: string;
  knowledgeBaseId?: string;
  knowledgeBaseIds?: string[];
}

export interface RagDiscussionSendMessageResponse {
  thread: RagDiscussionSummary;
  userMessage: RagDiscussionMessage;
  assistantMessage: RagDiscussionMessage;
}

// ── Chat Channel (generic, all channel types) ───────────────────────────────
export type ChannelOrigin = "slack" | "telegram" | "google_chat" | "web";

export interface ChannelChatThreadSummary {
  id: string;
  origin: ChannelOrigin;
  externalThreadKey: string;
  externalUserId?: string;
  activeKbIds: string[];
  lastMessageAt: string;
  expiresAt?: string;
  messageCount?: number;
}

export interface ChannelChatHistoryResponse {
  threads: ChannelChatThreadSummary[];
  nextCursor?: string;
}

export interface ChannelChatMessageRecord {
  id: string;
  role: RagDiscussionMessageRole;
  content: string;
  kbResults?: RagDiscussionKbResult[];
  createdAt: string;
}

export type SlackDeploymentStatus = "pending" | "active" | "error" | "disabled";
export type SlackAccessMode = "channel" | "allowlist";
export type SlackInstallMode = "oauth" | "manual";
export type SlackShareScope = "private" | "all" | "specific";
export type SlackMemberStatus = "connected" | "pending" | "disconnected";

export interface SlackDeploymentKbSummary {
  knowledgeBaseId: string;
  knowledgeBaseName: string;
}

export interface SlackUserKbMapping {
  id: string;
  deploymentId: string;
  rapidragUserId?: string;
  rapidragUsername?: string;
  slackUserId: string;
  kbIds: string[];
  status: SlackMemberStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SlackDeployment {
  id: string;
  deploymentName: string;
  installMode: SlackInstallMode;
  slackWorkspaceId?: string;
  slackWorkspaceName?: string;
  slackBotUserId?: string;
  slackChannelId?: string;
  slackChannelName?: string;
  status: SlackDeploymentStatus;
  accessMode: SlackAccessMode;
  allowedSlackUserIds: string[];
  shareScope: SlackShareScope;
  sharedWithUserIds: string[];
  requireUserVerification: boolean;
  defaultKbIds: string[];
  kbMappings: SlackDeploymentKbSummary[];
  webhookUrl?: string;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackDeploymentActivateRequest {
  botToken?: string;
  signingSecret?: string;
  clientId?: string;
  clientSecret?: string;
  slackChannelId?: string;
  slackChannelName?: string;
  knowledgeBaseIds: string[];
  accessMode: SlackAccessMode;
  allowedSlackUserIds?: string[];
  shareScope?: SlackShareScope;
  sharedWithUserIds?: string[];
  requireUserVerification?: boolean;
  defaultKbIds?: string[];
}

export interface SlackOAuthConnectResponse {
  url: string;
}

export interface SlackTokenValidateResponse {
  workspaceId: string;
  workspaceName: string;
  botUserId: string;
}

export const PlatformEvents = {
  logsIngest: "logs.ingest",
  certExpiryWarning: "cert.expiry.warning",
  certExpiryCritical: "cert.expiry.critical",
  certReloadFailed: "cert.reload.failed",
  certRotationTriggered: "cert.rotation.triggered",
  certRotationCompleted: "cert.rotation.completed",
  certRotationFailed: "cert.rotation.failed",
  certWebhookDeliveryFailed: "cert.webhook.delivery.failed"
} as const;
