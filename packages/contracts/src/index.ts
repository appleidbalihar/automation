export type RagDiscussionMessageRole = "user" | "assistant";
export type RagDiscussionBackend = "dify" | "legacy-flowise";

export interface RagDiscussionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  preview?: string;
  knowledgeBaseId?: string;
  backend: RagDiscussionBackend;
}

export interface RagDiscussionMessage {
  id: string;
  threadId: string;
  role: RagDiscussionMessageRole;
  content: string;
  createdAt: string;
}

export interface RagDiscussionThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  knowledgeBaseId?: string;
  backend: RagDiscussionBackend;
  messages: RagDiscussionMessage[];
}

export interface RagDiscussionCreateRequest {
  knowledgeBaseId?: string;
}

export interface RagDiscussionSendMessageRequest {
  content: string;
}

export interface RagDiscussionSendMessageResponse {
  thread: RagDiscussionSummary;
  userMessage: RagDiscussionMessage;
  assistantMessage: RagDiscussionMessage;
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
