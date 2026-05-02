"use client";

import Link from "next/link";
import type { KeyboardEvent, ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { resolveApiBase } from "./api-base";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";

type RagDiscussionBackend = "dify";

type RagDiscussionSummary = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  expiresAt: string;
  preview?: string;
  knowledgeBaseId?: string;
  backend: RagDiscussionBackend;
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
  knowledgeBaseId?: string;
  backend: RagDiscussionBackend;
  messages: RagDiscussionMessage[];
};

type RagDiscussionSendMessageResponse = {
  thread: RagDiscussionSummary;
  userMessage: RagDiscussionMessage;
  assistantMessage: RagDiscussionMessage;
};

type RagKbSyncJob = {
  id: string;
  status: string;
  filesTotal: number | null;
  filesProcessed: number;
  chunksTotal: number | null;
  chunksProcessed: number;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt?: string;
};

type RagKnowledgeBaseConfig = {
  knowledgeBaseId: string;
  responseStyle: string | null;
  toneInstructions: string | null;
  restrictionRules: string | null;
};

type RagKnowledgeBase = {
  id: string;
  name: string;
  description: string | null;
  sourceType?: string;
  sourceUrl?: string;
  sourceBranch?: string | null;
  sourcePath?: string | null;
  syncSchedule?: string | null;
  difyAppUrl?: string;
  syncJobs: RagKbSyncJob[];
  config: RagKnowledgeBaseConfig | null;
  isDefault: boolean;
};

type RagSyncHistoryResponse = {
  knowledgeBaseId: string;
  jobs: RagKbSyncJob[];
};

type Identity = {
  userId: string;
  roles: string[];
};

const SUGGESTED_QUESTIONS = [
  "How do we register a new user in the automation platform?",
  "Where can I view platform logs and troubleshoot issues?",
  "How do platform admins manage secrets safely?",
  "Where can I check certificate and security health?"
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
    const details =
      readErrorField(payload, "details") ??
      readErrorField(payload, "error") ??
      `Request failed with status ${response.status}`;
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

function upsertThreadSummary(existing: RagDiscussionSummary[], incoming: RagDiscussionSummary): RagDiscussionSummary[] {
  const next = [incoming, ...existing.filter((thread) => thread.id !== incoming.id)];
  return next.sort((left, right) => new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime());
}

function threadFromSummary(summary: RagDiscussionSummary): RagDiscussionThread {
  return {
    ...summary,
    messages: []
  };
}

function latestSyncJob(kb: RagKnowledgeBase | null): RagKbSyncJob | null {
  if (!kb || kb.syncJobs.length === 0) return null;
  return kb.syncJobs[0] ?? null;
}

function syncStatusLabel(job: RagKbSyncJob | null): string {
  if (!job) return "never configured";
  switch (job.status) {
    case "running":
      return "running";
    case "pending":
      return job.errorMessage === "No n8n workflow configured for this knowledge base" ? "pending workflow assignment" : "pending";
    case "failed":
      return "failed";
    case "completed":
      return "completed";
    case "never_synced":
      return "never synced";
    default:
      return job.status;
  }
}

function isPrivileged(identity: Identity | null): boolean {
  if (!identity) return false;
  return identity.roles.includes("admin") || identity.roles.includes("useradmin");
}

export function OperationsAiDifyChat(): ReactElement {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [threads, setThreads] = useState<RagDiscussionSummary[]>([]);
  const [kbs, setKbs] = useState<RagKnowledgeBase[]>([]);
  const [syncHistory, setSyncHistory] = useState<RagKbSyncJob[]>([]);
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<RagDiscussionThread | null>(null);
  const [composer, setComposer] = useState<string>("");
  const [initializing, setInitializing] = useState<boolean>(true);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [sending, setSending] = useState<boolean>(false);
  const [sidebarError, setSidebarError] = useState<string>("");
  const [chatError, setChatError] = useState<string>("");
  const [showConfig, setShowConfig] = useState<boolean>(false);
  const [savingConfig, setSavingConfig] = useState<boolean>(false);
  const [syncingKb, setSyncingKb] = useState<boolean>(false);
  const [retryingIndexing, setRetryingIndexing] = useState<boolean>(false);
  const [configForm, setConfigForm] = useState({ responseStyle: "", toneInstructions: "", restrictionRules: "" });
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const activeSummary = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  );
  const selectedKb = useMemo(
    () => kbs.find((kb) => kb.id === selectedKbId) ?? null,
    [kbs, selectedKbId]
  );
  const activeSyncJob = useMemo(() => latestSyncJob(selectedKb), [selectedKb]);
  const adminMode = isPrivileged(identity);
  const hasKnowledgeBases = kbs.length > 0;

  useEffect(() => {
    let active = true;

    async function loadInitialState(): Promise<void> {
      setInitializing(true);
      setSidebarError("");
      setChatError("");
      try {
        const [currentIdentity, summaries, loadedKbs] = await Promise.all([
          fetchIdentity(),
          fetchRag<RagDiscussionSummary[]>("/rag/discussions"),
          fetchRag<RagKnowledgeBase[]>("/rag/knowledge-bases")
        ]);
        if (!active) return;

        setIdentity(currentIdentity);
        setThreads(summaries);
        setKbs(loadedKbs);

        const defaultKb = loadedKbs.find((kb) => kb.isDefault) ?? loadedKbs[0] ?? null;
        if (defaultKb) {
          setSelectedKbId(defaultKb.id);
          setConfigForm({
            responseStyle: defaultKb.config?.responseStyle ?? "",
            toneInstructions: defaultKb.config?.toneInstructions ?? "",
            restrictionRules: defaultKb.config?.restrictionRules ?? ""
          });
        }

        if (summaries.length === 0) {
          setActiveThreadId(null);
          setActiveThread(null);
          return;
        }

        const nextThread = await fetchRag<RagDiscussionThread>(`/rag/discussions/${summaries[0].id}`);
        if (!active) return;
        setActiveThreadId(nextThread.id);
        setActiveThread(nextThread);
        if (nextThread.knowledgeBaseId && loadedKbs.some((kb) => kb.id === nextThread.knowledgeBaseId)) {
          setSelectedKbId(nextThread.knowledgeBaseId);
        }
      } catch (error) {
        if (!active) return;
        setSidebarError(error instanceof Error ? error.message : "Unable to load Operations AI.");
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

  function focusComposer(): void {
    if (typeof window === "undefined") return;
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      const length = composerRef.current?.value.length ?? 0;
      composerRef.current?.setSelectionRange(length, length);
    });
  }

  useEffect(() => {
    if (!selectedKbId) {
      setSyncHistory([]);
      return;
    }
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    async function refreshSyncState(): Promise<void> {
      try {
        const [job, history] = await Promise.all([
          fetchRag<RagKbSyncJob>(`/rag/knowledge-bases/${selectedKbId}/sync-status`),
          fetchRag<RagSyncHistoryResponse>(`/rag/knowledge-bases/${selectedKbId}/sync-history?limit=5`)
        ]);
        if (!active) return;
        setKbs((current) =>
          current.map((kb) => (kb.id === selectedKbId ? { ...kb, syncJobs: job.id ? [job] : [] } : kb))
        );
        setSyncHistory(history.jobs);
        if (job.status === "running" || job.status === "pending") {
          timeoutId = setTimeout(() => {
            void refreshSyncState();
          }, 3000);
        }
      } catch {
        if (!active) return;
      }
    }

    void refreshSyncState();

    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [selectedKbId]);

  function syncKbSelection(kbId: string): void {
    setSelectedKbId(kbId);
    setShowConfig(false);
    const kb = kbs.find((candidate) => candidate.id === kbId) ?? null;
    setConfigForm({
      responseStyle: kb?.config?.responseStyle ?? "",
      toneInstructions: kb?.config?.toneInstructions ?? "",
      restrictionRules: kb?.config?.restrictionRules ?? ""
    });
  }

  async function loadThread(threadId: string): Promise<void> {
    if (!threadId || threadId === loadingThreadId) return;
    setLoadingThreadId(threadId);
    setChatError("");
    try {
      const thread = await fetchRag<RagDiscussionThread>(`/rag/discussions/${threadId}`);
      setActiveThreadId(thread.id);
      setActiveThread(thread);
      if (thread.knowledgeBaseId) {
        syncKbSelection(thread.knowledgeBaseId);
      }
      setShowConfig(false);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Unable to load this discussion.");
    } finally {
      setLoadingThreadId(null);
    }
  }

  async function createDiscussion(seed?: string): Promise<void> {
    if (!selectedKbId) {
      setChatError("OPERATIONS_AI_NOT_CONFIGURED");
      return;
    }
    setSidebarError("");
    setChatError("");
    try {
      const created = await fetchRag<RagDiscussionSummary>("/rag/discussions", {
        method: "POST",
        body: JSON.stringify({ knowledgeBaseId: selectedKbId })
      });
      setThreads((current) => upsertThreadSummary(current, created));
      setActiveThreadId(created.id);
      setActiveThread(threadFromSummary(created));
      setComposer(seed ?? "");
      setShowConfig(false);
      focusComposer();
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Unable to start a new discussion.");
    }
  }

  function startNewDiscussion(seed?: string): void {
    setComposer(seed ?? "");
    void createDiscussion(seed);
  }

  async function handleDelete(threadId: string): Promise<void> {
    setDeletingThreadId(threadId);
    setSidebarError("");
    setChatError("");
    try {
      await fetchRag<{ deleted: boolean }>(`/rag/discussions/${threadId}`, { method: "DELETE" });
      const remainingThreads = threads.filter((thread) => thread.id !== threadId);
      setThreads(remainingThreads);
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
        const created = await fetchRag<RagDiscussionSummary>("/rag/discussions", {
          method: "POST",
          body: JSON.stringify({ knowledgeBaseId: selectedKbId || undefined })
        });
        threadId = created.id;
        setThreads((current) => upsertThreadSummary(current, created));
        setActiveThreadId(created.id);
        setActiveThread(threadFromSummary(created));
        focusComposer();
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
      if (response.thread.knowledgeBaseId) {
        syncKbSelection(response.thread.knowledgeBaseId);
      }
      setComposer("");
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Unable to send your question.");
    } finally {
      setSending(false);
    }
  }

  async function handleManualSync(): Promise<void> {
    if (!selectedKbId) return;
    setSyncingKb(true);
    setSidebarError("");
    try {
      await fetchRag(`/rag/knowledge-bases/${selectedKbId}/sync`, { method: "POST" });
      const [job, history] = await Promise.all([
        fetchRag<RagKbSyncJob>(`/rag/knowledge-bases/${selectedKbId}/sync-status`),
        fetchRag<RagSyncHistoryResponse>(`/rag/knowledge-bases/${selectedKbId}/sync-history?limit=5`)
      ]);
      setKbs((current) => current.map((kb) => (kb.id === selectedKbId ? { ...kb, syncJobs: [job] } : kb)));
      setSyncHistory(history.jobs);
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : "Failed to trigger sync.");
    } finally {
      setSyncingKb(false);
    }
  }

  async function handleRetryFailedIndexing(): Promise<void> {
    if (!selectedKbId) return;
    setRetryingIndexing(true);
    setSidebarError("");
    try {
      await fetchRag(`/rag/knowledge-bases/${selectedKbId}/retry-failed-indexing`, { method: "POST" });
      const [job, history] = await Promise.all([
        fetchRag<RagKbSyncJob>(`/rag/knowledge-bases/${selectedKbId}/sync-status`),
        fetchRag<RagSyncHistoryResponse>(`/rag/knowledge-bases/${selectedKbId}/sync-history?limit=5`)
      ]);
      setKbs((current) => current.map((kb) => (kb.id === selectedKbId ? { ...kb, syncJobs: [job] } : kb)));
      setSyncHistory(history.jobs);
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : "Failed to retry indexing.");
    } finally {
      setRetryingIndexing(false);
    }
  }

  async function handleSaveConfig(): Promise<void> {
    if (!selectedKbId) return;
    setSavingConfig(true);
    setChatError("");
    try {
      const updated = await fetchRag<RagKnowledgeBaseConfig>(`/rag/knowledge-bases/${selectedKbId}/config`, {
        method: "PATCH",
        body: JSON.stringify(configForm)
      });
      setShowConfig(false);
      setKbs((current) =>
        current.map((kb) => (kb.id === selectedKbId ? { ...kb, config: updated } : kb))
      );
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Failed to save configuration.");
    } finally {
      setSavingConfig(false);
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
          <p className="operations-ai-eyebrow">RAG Assistant</p>
          <h1>RAG Assistant</h1>
          <p className="operations-ai-subtitle">
            Ask questions about your connected knowledge bases. New conversations are routed through
            the Dify RAG pipeline so answers are grounded in the documents you connected.
          </p>
        </div>
        <div className="operations-ai-header-note">
          <strong>7-day discussion retention</strong>
          <span>New discussions use Dify-backed context. Legacy Flowise threads stay accessible until they are retired later.</span>
        </div>
      </header>

      <div className="operations-ai-shell">
        <aside className="operations-ai-rail">
          <div className="operations-ai-rail-header" style={{ marginBottom: "1rem" }}>
            <div>
              <h2>Knowledge Bases</h2>
              <p>Dify-backed operations knowledge and sync status.</p>
            </div>
            <Link href="/knowledge-connector" className="operations-ai-secondary-button">
              Knowledge Connector
            </Link>
          </div>

          {hasKnowledgeBases ? (
            <div className="operations-ai-rail-kb-selector" style={{ marginBottom: "1.5rem" }}>
              <label htmlFor="kb-select" style={{ display: "block", fontSize: "0.875rem", fontWeight: 600, marginBottom: "0.5rem" }}>
                Active Knowledge Base
              </label>
              <select
                id="kb-select"
                value={selectedKbId}
                onChange={(event) => syncKbSelection(event.target.value)}
                style={{
                  width: "100%",
                  padding: "0.5rem",
                  borderRadius: "4px",
                  border: "1px solid #ccc",
                  background: "inherit",
                  color: "inherit"
                }}
              >
                {kbs.map((kb) => (
                  <option key={kb.id} value={kb.id}>
                    {kb.name}
                    {kb.isDefault ? " (Default)" : ""}
                  </option>
                ))}
              </select>

              <div style={{ marginTop: "0.75rem", fontSize: "0.75rem", padding: "0.75rem", background: "rgba(0,0,0,0.05)", borderRadius: "8px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", alignItems: "center", flexWrap: "wrap" }}>
                  <span>
                    Sync status: <strong>{syncStatusLabel(activeSyncJob)}</strong>
                  </span>
                  <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", justifyContent: "flex-end" }}>
                    {activeSyncJob?.status === "failed" ? (
                      <button
                        type="button"
                        onClick={() => void handleRetryFailedIndexing()}
                        disabled={retryingIndexing}
                        style={{
                          background: "none",
                          border: "1px solid currentColor",
                          borderRadius: "4px",
                          padding: "0.25rem 0.5rem",
                          fontSize: "0.75rem",
                          cursor: "pointer"
                        }}
                      >
                        {retryingIndexing ? "Retrying..." : "Retry Failed Indexing"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => void handleManualSync()}
                      disabled={syncingKb || activeSyncJob?.status === "running"}
                      style={{
                        background: "none",
                        border: "1px solid currentColor",
                        borderRadius: "4px",
                        padding: "0.25rem 0.5rem",
                        fontSize: "0.75rem",
                        cursor: "pointer"
                      }}
                    >
                      {syncingKb || activeSyncJob?.status === "running" ? "Syncing..." : "Sync Now"}
                    </button>
                  </div>
                </div>
                {activeSyncJob?.filesTotal ? (
                  <div style={{ marginTop: "0.5rem", width: "100%", height: "6px", background: "#ddd", borderRadius: "999px", overflow: "hidden" }}>
                    <div
                      style={{
                        height: "100%",
                        background: "#0ea5e9",
                        width: `${(activeSyncJob.filesProcessed / Math.max(activeSyncJob.filesTotal, 1)) * 100}%`,
                        transition: "width 0.3s"
                      }}
                    />
                  </div>
                ) : null}
                {activeSyncJob?.errorMessage ? (
                  <div style={{ color: "#ef4444", marginTop: "0.5rem" }}>{activeSyncJob.errorMessage}</div>
                ) : null}
                {syncHistory.length > 0 ? (
                  <div style={{ marginTop: "0.75rem" }}>
                    <strong>Recent syncs</strong>
                    <div style={{ marginTop: "0.35rem", display: "grid", gap: "0.25rem" }}>
                      {syncHistory.map((job) => (
                        <span key={job.id}>
                          {syncStatusLabel(job)} · {formatThreadTime(job.createdAt ?? job.startedAt ?? job.completedAt ?? "")}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              <div style={{ display: "flex", gap: "0.75rem", marginTop: "0.75rem" }}>
                <Link href="/knowledge-connector" className="operations-ai-secondary-button">
                  Knowledge Connector
                </Link>
              </div>
            </div>
          ) : adminMode ? (
            <div className="operations-ai-inline-error">
              No knowledge base is connected yet. Open the setup page to connect GitHub, GitLab, Google Drive, or web content for your user account.
            </div>
          ) : (
            <div className="operations-ai-inline-error">
              Operations AI is not configured yet for your account. Open Setup to connect a source, or ask an administrator if Dify provisioning is still pending.
            </div>
          )}

          <div className="operations-ai-rail-header" style={{ marginTop: "1rem" }}>
            <div>
              <h2>Discussions</h2>
              <p>Recent operations questions for your account.</p>
            </div>
            <button
              type="button"
              className="operations-ai-primary-button"
              onClick={() => startNewDiscussion()}
              disabled={sending || !hasKnowledgeBases}
            >
              New discussion
            </button>
          </div>

          {sidebarError ? <div className="operations-ai-inline-error">{sidebarError}</div> : null}

          <div className="operations-ai-thread-list">
            {initializing ? (
              <div className="operations-ai-thread-empty">Loading your recent discussions...</div>
            ) : threads.length === 0 ? (
              <div className="operations-ai-thread-empty">
                {hasKnowledgeBases
                  ? "No saved discussions yet. Start a new Dify-backed thread to talk with the operations knowledge base."
                  : "No saved discussions yet."}
              </div>
            ) : (
              threads.map((thread) => {
                const isActive = thread.id === activeThreadId && !showConfig;
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
                      <span className="operations-ai-thread-meta">
                        <span>{thread.backend === "dify" ? "Dify" : "Legacy Flowise"}</span>
                        {" · "}
                        <span>Updated {formatThreadTime(thread.lastMessageAt)}</span>
                      </span>
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
          {showConfig ? (
            <div className="operations-ai-config-panel" style={{ padding: "2rem", flex: 1, overflowY: "auto" }}>
              <h2>Configure {selectedKb?.name ?? "Knowledge Base"}</h2>
              <p style={{ opacity: 0.8, marginBottom: "2rem" }}>Override the shared Dify response defaults for this knowledge base.</p>

              <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", maxWidth: "640px" }}>
                <div>
                  <label style={{ display: "block", fontWeight: 600, marginBottom: "0.5rem" }}>Response Style</label>
                  <select
                    value={configForm.responseStyle}
                    onChange={(event) => setConfigForm((current) => ({ ...current, responseStyle: event.target.value }))}
                    style={{ width: "100%", padding: "0.65rem", borderRadius: "6px", border: "1px solid #ccc" }}
                  >
                    <option value="">Platform Default</option>
                    <option value="formal">Formal</option>
                    <option value="casual">Casual</option>
                    <option value="technical">Technical</option>
                    <option value="friendly">Friendly</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontWeight: 600, marginBottom: "0.5rem" }}>Tone Instructions</label>
                  <textarea
                    value={configForm.toneInstructions}
                    onChange={(event) => setConfigForm((current) => ({ ...current, toneInstructions: event.target.value }))}
                    placeholder="Always be concise and include relevant services, pages, or endpoints."
                    rows={3}
                    style={{ width: "100%", padding: "0.65rem", borderRadius: "6px", border: "1px solid #ccc" }}
                  />
                </div>

                <div>
                  <label style={{ display: "block", fontWeight: 600, marginBottom: "0.5rem" }}>Restriction Rules</label>
                  <textarea
                    value={configForm.restrictionRules}
                    onChange={(event) => setConfigForm((current) => ({ ...current, restrictionRules: event.target.value }))}
                    placeholder="Only answer questions supported by platform operations documentation."
                    rows={3}
                    style={{ width: "100%", padding: "0.65rem", borderRadius: "6px", border: "1px solid #ccc" }}
                  />
                </div>

                <div style={{ display: "flex", gap: "1rem", marginTop: "0.5rem" }}>
                  <button type="button" onClick={() => void handleSaveConfig()} className="operations-ai-primary-button" disabled={savingConfig}>
                    {savingConfig ? "Saving..." : "Save Configuration"}
                  </button>
                  <button type="button" onClick={() => setShowConfig(false)} className="operations-ai-secondary-button">
                    Cancel
                  </button>
                </div>

                {chatError ? <div className="operations-ai-inline-error">{chatError}</div> : null}
              </div>
            </div>
          ) : (
            <div className="operations-ai-transcript-frame">
              <div className="operations-ai-transcript-header">
                <div>
                  <h2>{activeSummary?.title ?? "New discussion"}</h2>
                  <p>
                    {activeSummary
                      ? `Last updated ${formatThreadTime(activeSummary.lastMessageAt)}`
                      : hasKnowledgeBases
                        ? "Start a fresh conversation with the Dify-backed operations assistant."
                        : "Operations AI needs a knowledge base before new discussions can start."}
                  </p>
                </div>
                {activeSummary ? (
                  <div className="operations-ai-transcript-meta">
                    <span>Dify</span>
                    <span>Expires {formatThreadTime(activeSummary.expiresAt)}</span>
                  </div>
                ) : null}
              </div>

              {chatError ? <div className="operations-ai-inline-error">{chatError}</div> : null}

              <div ref={transcriptRef} className="operations-ai-transcript">
                {activeThread && activeThread.messages.length > 0 ? (
                  <div className="operations-ai-message-list">
                    {activeThread.messages.map((message) => (
                      <article key={message.id} className={`operations-ai-message operations-ai-message-${message.role}`}>
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
                          <p>Searching the knowledge base and preparing a response...</p>
                        </div>
                      </article>
                    ) : null}
                  </div>
                ) : (
                  <div className="operations-ai-empty-state">
                    <div className="operations-ai-empty-card">
                      <p className="operations-ai-empty-label">Operations knowledge assistant</p>
                      <h3>{hasKnowledgeBases ? "Ask operations questions in natural language" : "Operations AI setup required"}</h3>
                      <p>
                        {hasKnowledgeBases
                          ? "This page uses the integrated Dify + n8n RAG pipeline so new discussions are grounded in the actively synced operations knowledge base."
                          : adminMode
                            ? "Connect a source on the setup page to create your private knowledge base. Dify and n8n provisioning are handled behind the scenes."
                            : "Connect a source on the setup page. If chat still is not ready afterward, an administrator may still need to complete Dify provisioning defaults."}
                      </p>
                      {!hasKnowledgeBases ? (
                        <p style={{ marginTop: "1rem" }}>
                          <Link href="/knowledge-connector" className="operations-ai-secondary-button">
                            Knowledge Connector
                          </Link>
                        </p>
                      ) : null}
                    </div>
                    {hasKnowledgeBases ? (
                      <div className="operations-ai-suggestions">
                        {SUGGESTED_QUESTIONS.map((question) => (
                          <button key={question} type="button" onClick={() => startNewDiscussion(question)} disabled={sending}>
                            {question}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>

              <div className="operations-ai-composer">
                <textarea
                  ref={composerRef}
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                  placeholder={
                    hasKnowledgeBases
                      ? "Ask about registration, logs, secrets, security health, or any operations process..."
                      : "Operations AI is waiting for a Dify knowledge base."
                  }
                  disabled={initializing || sending || !hasKnowledgeBases}
                  rows={4}
                />
                <div className="operations-ai-composer-footer">
                  <span>Enter to send. Shift+Enter for a new line.</span>
                  <button
                    type="button"
                    className="operations-ai-primary-button"
                    onClick={() => void handleSendMessage()}
                    disabled={initializing || sending || !composer.trim() || !hasKnowledgeBases}
                  >
                    {sending ? "Sending..." : "Send"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}
