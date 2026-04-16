import type { RagDiscussionMessage, RagDiscussionMessageRole, RagDiscussionSummary, RagDiscussionThread } from "@platform/contracts";

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

export function extractFlowiseText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!payload || typeof payload !== "object") {
    throw new Error("FLOWISE_INVALID_RESPONSE");
  }

  const value = payload as Record<string, unknown>;
  if (typeof value.text === "string" && value.text.trim()) return value.text;
  if (value.json !== undefined) return JSON.stringify(value.json, null, 2);
  if (typeof value.output === "string" && value.output.trim()) return value.output;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  throw new Error("FLOWISE_EMPTY_RESPONSE");
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
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    expiresAt: thread.expiresAt.toISOString(),
    preview: previewFromMessage(latestMessageContent)
  };
}

export function mapRagDiscussionThread(thread: ThreadRecord, messages: MessageRecord[]): RagDiscussionThread {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt.toISOString(),
    updatedAt: thread.updatedAt.toISOString(),
    lastMessageAt: thread.lastMessageAt.toISOString(),
    expiresAt: thread.expiresAt.toISOString(),
    messages: messages.map(mapRagDiscussionMessage)
  };
}
