import type {
  RagDiscussionBackend,
  RagDiscussionMessage,
  RagDiscussionMessageRole,
  RagDiscussionSummary,
  RagDiscussionThread
} from "@platform/contracts";

const THREAD_TITLE_MAX_LENGTH = 72;
const THREAD_PREVIEW_MAX_LENGTH = 120;
export const RAG_DISCUSSION_RETENTION_DAYS = 7;

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function truncate(input: string, maxLength: number): string {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function deriveRagThreadTitle(input: string): string {
  const normalized = collapseWhitespace(input);
  if (!normalized) return "New discussion";
  return truncate(normalized, THREAD_TITLE_MAX_LENGTH);
}

export function buildRagThreadExpiry(now: Date): Date {
  return new Date(now.getTime() + RAG_DISCUSSION_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * Extracts the assistant answer from a Dify blocking chat-message response.
 * Dify returns: { answer: string, conversation_id: string, message_id: string, ... }
 */
export function extractDifyAnswer(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new Error("DIFY_INVALID_RESPONSE");
  }
  const value = payload as Record<string, unknown>;
  if (typeof value.answer === "string" && value.answer.trim()) return value.answer;
  // Fallback: some Dify versions use message field
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  throw new Error("DIFY_EMPTY_RESPONSE");
}

/**
 * Extracts Dify's conversation_id from a chat-message response.
 * This ID must be persisted in RagDiscussionThread.difyConversationId so that
 * follow-up messages continue the same Dify session.
 */
export function extractDifyConversationId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const value = payload as Record<string, unknown>;
  return typeof value.conversation_id === "string" ? value.conversation_id : "";
}

function previewFromMessage(content?: string): string | undefined {
  if (!content) return undefined;
  const normalized = collapseWhitespace(content);
  if (!normalized) return undefined;
  return truncate(normalized, THREAD_PREVIEW_MAX_LENGTH);
}

type ThreadRecord = {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  expiresAt: Date;
  knowledgeBaseId?: string | null;
};

type MessageRecord = {
  id: string;
  threadId: string;
  role: string;
  content: string;
  createdAt: Date;
};

export function mapRagDiscussionMessage(record: MessageRecord): RagDiscussionMessage {
  return {
    id: record.id,
    threadId: record.threadId,
    role: record.role as RagDiscussionMessageRole,
    content: record.content,
    createdAt: record.createdAt.toISOString()
  };
}

export function mapRagDiscussionSummary(
  thread: ThreadRecord,
  latestMessageContent?: string
): RagDiscussionSummary {
  const backend: RagDiscussionBackend = "dify";
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    expiresAt: thread.expiresAt.toISOString(),
    preview: previewFromMessage(latestMessageContent),
    knowledgeBaseId: thread.knowledgeBaseId ?? undefined,
    backend
  };
}

export function mapRagDiscussionThread(thread: ThreadRecord, messages: MessageRecord[]): RagDiscussionThread {
  const backend: RagDiscussionBackend = "dify";
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    expiresAt: thread.expiresAt.toISOString(),
    knowledgeBaseId: thread.knowledgeBaseId ?? undefined,
    backend,
    messages: messages.map(mapRagDiscussionMessage)
  };
}
