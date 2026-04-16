"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactElement } from "react";
import { authHeaderFromStoredToken } from "./auth-client";
import { resolveApiBase } from "./api-base";

type RagDiscussionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  preview?: string;
};

type RagDiscussionMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

type RagDiscussionThread = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  messages: RagDiscussionMessage[];
};

type RagDiscussionSendMessageResponse = {
  thread: RagDiscussionSummary;
  userMessage: RagDiscussionMessage;
  assistantMessage: RagDiscussionMessage;
};

const SUGGESTED_QUESTIONS = [
  "How do we register a new user in the automation platform?",
  "Where can I view execution logs and troubleshoot failed jobs?",
  "What is the approval flow for operational changes?",
  "How do I recover an execution after a partial failure?"
];

function formatThreadTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function formatMessageTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
}

function buildRequestHeaders(hasBody: boolean): Record<string, string> {
  const authorization = authHeaderFromStoredToken();
  if (!authorization) {
    throw new Error("You are not signed in.");
  }
  return {
    authorization,
    ...(hasBody ? { "content-type": "application/json" } : {})
  };
}

async function fetchRag<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const response = await fetch(`${resolveApiBase()}${path}`, {
    ...init,
    headers: {
      ...buildRequestHeaders(hasBody),
      ...(init?.headers ?? {})
    }
  });

  const raw = await response.text();
  const payload = raw ? safeParseJson(raw) : undefined;
  if (!response.ok) {
    const details = readErrorField(payload, "details") ?? readErrorField(payload, "error") ?? `Request failed with status ${response.status}`;
    throw new Error(details);
  }
  return (payload ?? {}) as T;
}

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readErrorField(payload: unknown, key: "details" | "error"): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function upsertThreadSummary(
  existing: RagDiscussionSummary[],
  incoming: RagDiscussionSummary
): RagDiscussionSummary[] {
  const next = [incoming, ...existing.filter((thread) => thread.id !== incoming.id)];
  return next.sort((left, right) => new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime());
}

function threadFromSummary(summary: RagDiscussionSummary): RagDiscussionThread {
  return {
    ...summary,
    messages: []
  };
}

export function OperationsAiChat(): ReactElement {
  const [threads, setThreads] = useState<RagDiscussionSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<RagDiscussionThread | null>(null);
  const [composer, setComposer] = useState<string>("");
  const [initializing, setInitializing] = useState<boolean>(true);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [sending, setSending] = useState<boolean>(false);
  const [sidebarError, setSidebarError] = useState<string>("");
  const [chatError, setChatError] = useState<string>("");
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  const activeSummary = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  );

  useEffect(() => {
    let active = true;

    async function loadInitialState(): Promise<void> {
      setInitializing(true);
      setSidebarError("");
      setChatError("");
      try {
        const summaries = await fetchRag<RagDiscussionSummary[]>("/rag/discussions");
        if (!active) return;
        setThreads(summaries);
        if (summaries.length === 0) {
          setActiveThreadId(null);
          setActiveThread(null);
          return;
        }
        const nextThread = await fetchRag<RagDiscussionThread>(`/rag/discussions/${summaries[0].id}`);
        if (!active) return;
        setActiveThreadId(nextThread.id);
        setActiveThread(nextThread);
      } catch (error) {
        if (!active) return;
        setSidebarError(error instanceof Error ? error.message : "Unable to load discussions.");
        setActiveThreadId(null);
        setActiveThread(null);
      } finally {
        if (active) {
          setInitializing(false);
        }
      }
    }

    void loadInitialState();

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [activeThread?.messages.length, sending]);

  async function loadThread(threadId: string): Promise<void> {
    if (!threadId || threadId === loadingThreadId) return;
    setLoadingThreadId(threadId);
    setChatError("");
    try {
      const thread = await fetchRag<RagDiscussionThread>(`/rag/discussions/${threadId}`);
      setActiveThreadId(thread.id);
      setActiveThread(thread);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Unable to load this discussion.");
    } finally {
      setLoadingThreadId(null);
    }
  }

  function startNewDiscussion(seed?: string): void {
    setActiveThreadId(null);
    setActiveThread(null);
    setChatError("");
    setComposer(seed ?? "");
  }

  async function handleDelete(threadId: string): Promise<void> {
    setDeletingThreadId(threadId);
    setSidebarError("");
    setChatError("");
    try {
      await fetchRag<{ deleted: boolean }>(`/rag/discussions/${threadId}`, { method: "DELETE" });
      setThreads((current) => current.filter((thread) => thread.id !== threadId));
      if (activeThreadId === threadId) {
        setActiveThreadId(null);
        setActiveThread(null);
        setComposer("");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete this discussion.";
      setSidebarError(message);
      if (activeThreadId === threadId) {
        setChatError(message);
      }
    } finally {
      setDeletingThreadId(null);
    }
  }

  async function handleSendMessage(seed?: string): Promise<void> {
    const content = String(seed ?? composer).trim();
    if (!content || sending) return;

    setSending(true);
    setChatError("");

    let threadId = activeThreadId;

    try {
      if (!threadId) {
        const created = await fetchRag<RagDiscussionSummary>("/rag/discussions", { method: "POST" });
        threadId = created.id;
        setThreads((current) => upsertThreadSummary(current, created));
        setActiveThreadId(created.id);
        setActiveThread(threadFromSummary(created));
      }

      const response = await fetchRag<RagDiscussionSendMessageResponse>(`/rag/discussions/${threadId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content })
      });

      setThreads((current) => upsertThreadSummary(current, response.thread));
      setActiveThread((current) => {
        const priorMessages = current && current.id === response.thread.id ? current.messages : [];
        return {
          ...response.thread,
          messages: [...priorMessages, response.userMessage, response.assistantMessage]
        };
      });
      setActiveThreadId(response.thread.id);
      setComposer("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Unable to send your question.");
    } finally {
      setSending(false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void handleSendMessage();
  }

  return (
    <section className="operations-ai-page">
      <header className="operations-ai-header">
        <div>
          <p className="operations-ai-eyebrow">Operations Copilot</p>
          <h1>Operations AI</h1>
          <p className="operations-ai-subtitle">
            Ask questions about platform operations, onboarding, approvals, logs, and recovery. Every response is routed through the
            existing Flowise operations RAG flow.
          </p>
        </div>
        <div className="operations-ai-header-note">
          <strong>7-day discussion retention</strong>
          <span>Conversation history stays tied to each thread so follow-up questions keep the same Flowise session context.</span>
        </div>
      </header>

      <div className="operations-ai-shell">
        <aside className="operations-ai-rail">
          <div className="operations-ai-rail-header">
            <div>
              <h2>Discussions</h2>
              <p>Recent operations questions for your account.</p>
            </div>
            <button type="button" className="operations-ai-primary-button" onClick={() => startNewDiscussion()} disabled={sending}>
              New discussion
            </button>
          </div>

          {sidebarError ? <div className="operations-ai-inline-error">{sidebarError}</div> : null}

          <div className="operations-ai-thread-list">
            {initializing ? (
              <div className="operations-ai-thread-empty">Loading your recent discussions...</div>
            ) : threads.length === 0 ? (
              <div className="operations-ai-thread-empty">
                No saved discussions yet. Start a new thread to talk with the operations knowledge base.
              </div>
            ) : (
              threads.map((thread) => {
                const isActive = thread.id === activeThreadId;
                const isBusy = deletingThreadId === thread.id || loadingThreadId === thread.id;
                return (
                  <article
                    key={thread.id}
                    className={`operations-ai-thread-card${isActive ? " operations-ai-thread-card-active" : ""}`}
                  >
                    <button
                      type="button"
                      className="operations-ai-thread-open"
                      onClick={() => void loadThread(thread.id)}
                      disabled={isBusy || sending}
                    >
                      <span className="operations-ai-thread-title">{thread.title}</span>
                      <span className="operations-ai-thread-preview">{thread.preview || "Awaiting your first question."}</span>
                      <span className="operations-ai-thread-meta">Updated {formatThreadTime(thread.lastMessageAt)}</span>
                    </button>
                    <button
                      type="button"
                      className="operations-ai-thread-delete"
                      aria-label={`Delete ${thread.title}`}
                      onClick={() => void handleDelete(thread.id)}
                      disabled={isBusy || sending}
                    >
                      {deletingThreadId === thread.id ? "..." : "Delete"}
                    </button>
                  </article>
                );
              })
            )}
          </div>
        </aside>

        <main className="operations-ai-main">
          <div className="operations-ai-transcript-frame">
            <div className="operations-ai-transcript-header">
              <div>
                <h2>{activeSummary?.title ?? "New discussion"}</h2>
                <p>
                  {activeSummary
                    ? `Last updated ${formatThreadTime(activeSummary.lastMessageAt)}`
                    : "Start a fresh conversation with the operations assistant."}
                </p>
              </div>
              {activeSummary ? (
                <div className="operations-ai-transcript-meta">
                  <span>Expires {formatThreadTime(activeSummary.expiresAt)}</span>
                </div>
              ) : null}
            </div>

            {chatError ? <div className="operations-ai-inline-error">{chatError}</div> : null}

            <div ref={transcriptRef} className="operations-ai-transcript">
              {activeThread && activeThread.messages.length > 0 ? (
                <div className="operations-ai-message-list">
                  {activeThread.messages.map((message) => (
                    <article
                      key={message.id}
                      className={`operations-ai-message operations-ai-message-${message.role}`}
                    >
                      <div className="operations-ai-message-meta">
                        <span className="operations-ai-message-role">{message.role === "assistant" ? "Operations AI" : "You"}</span>
                        <span>{formatMessageTime(message.createdAt)}</span>
                      </div>
                      <div className="operations-ai-message-bubble">
                        <p>{message.content}</p>
                      </div>
                    </article>
                  ))}

                  {sending ? (
                    <article className="operations-ai-message operations-ai-message-assistant">
                      <div className="operations-ai-message-meta">
                        <span className="operations-ai-message-role">Operations AI</span>
                        <span>Thinking</span>
                      </div>
                      <div className="operations-ai-message-bubble operations-ai-message-bubble-pending">
                        <p>Searching the operations knowledge base and preparing a response...</p>
                      </div>
                    </article>
                  ) : null}
                </div>
              ) : (
                <div className="operations-ai-empty-state">
                  <div className="operations-ai-empty-card">
                    <p className="operations-ai-empty-label">Operations knowledge assistant</p>
                    <h3>Ask operations questions in natural language</h3>
                    <p>
                      This page uses the existing Flowise RAG chatflow behind the platform backend, so users get a native experience
                      without exposing Flowise directly in the browser.
                    </p>
                  </div>
                  <div className="operations-ai-suggestions">
                    {SUGGESTED_QUESTIONS.map((question) => (
                      <button key={question} type="button" onClick={() => startNewDiscussion(question)} disabled={sending}>
                        {question}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="operations-ai-composer">
              <textarea
                value={composer}
                onChange={(event) => setComposer(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                placeholder="Ask about registration, logs, approvals, recovery steps, or any operations process..."
                disabled={initializing || sending}
                rows={4}
              />
              <div className="operations-ai-composer-footer">
                <span>Enter to send. Shift+Enter for a new line.</span>
                <button
                  type="button"
                  className="operations-ai-primary-button"
                  onClick={() => void handleSendMessage()}
                  disabled={initializing || sending || !composer.trim()}
                >
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        </main>
      </div>
    </section>
  );
}
