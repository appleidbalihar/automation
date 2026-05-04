"use client";

import Link from "next/link";
import type { KeyboardEvent, ReactElement, ReactNode } from "react";
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
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function buildRequestHeaders(hasBody: boolean): Record<string, string> {
  const authorization = authHeaderFromStoredToken();
  if (!authorization) throw new Error("You are not signed in.");
  return {
    authorization,
    ...(hasBody ? { "content-type": "application/json" } : {})
  };
}

async function fetchRag<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined;
  const response = await fetch(`${resolveApiBase()}${path}`, {
    ...init,
    headers: { ...buildRequestHeaders(hasBody), ...(init?.headers ?? {}) }
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
  try { return JSON.parse(raw); } catch { return raw; }
}

function readErrorField(payload: unknown, key: "details" | "error"): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : undefined;
}

function upsertThreadSummary(existing: RagDiscussionSummary[], incoming: RagDiscussionSummary): RagDiscussionSummary[] {
  const next = [incoming, ...existing.filter((t) => t.id !== incoming.id)];
  return next.sort((a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime());
}

function threadFromSummary(summary: RagDiscussionSummary): RagDiscussionThread {
  return { ...summary, messages: [] };
}

function latestSyncJob(kb: RagKnowledgeBase | null): RagKbSyncJob | null {
  if (!kb || kb.syncJobs.length === 0) return null;
  return kb.syncJobs[0] ?? null;
}

function syncStatusLabel(job: RagKbSyncJob | null): string {
  if (!job) return "never configured";
  switch (job.status) {
    case "running": return "running";
    case "pending": return job.errorMessage === "No n8n workflow configured for this knowledge base" ? "pending workflow assignment" : "pending";
    case "failed": return "failed";
    case "completed": return "completed";
    case "never_synced": return "never synced";
    default: return job.status;
  }
}

function isPrivileged(identity: Identity | null): boolean {
  if (!identity) return false;
  return identity.roles.includes("admin") || identity.roles.includes("useradmin");
}

function groupThreadsByTime(threads: RagDiscussionSummary[]): Array<{ label: string; items: RagDiscussionSummary[] }> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const dayMs = 86400000;

  const groups: Array<{ label: string; items: RagDiscussionSummary[] }> = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Previous 7 days", items: [] },
    { label: "Older", items: [] }
  ];

  for (const thread of threads) {
    const threadDay = new Date(thread.lastMessageAt);
    threadDay.setHours(0, 0, 0, 0);
    const diff = todayMs - threadDay.getTime();
    if (diff <= 0) groups[0].items.push(thread);
    else if (diff <= dayMs) groups[1].items.push(thread);
    else if (diff <= 7 * dayMs) groups[2].items.push(thread);
    else groups[3].items.push(thread);
  }

  return groups.filter((g) => g.items.length > 0);
}

// ── Inline markdown → React nodes ────────────────────────────────────────────
function renderInline(text: string): ReactNode[] {
  // Handle **bold**, *italic*, and `code` inline
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*")) {
      return <em key={i}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={i} className="rag-md-code">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

function MarkdownMessage({ content }: { content: string }): ReactElement {
  const lines = content.split("\n");
  const nodes: ReactNode[] = [];
  let listItems: ReactNode[] = [];
  let listType: "ol" | "ul" | null = null;
  let listStart = 1;

  function flushList(): void {
    if (listItems.length === 0) return;
    if (listType === "ol") {
      nodes.push(<ol key={nodes.length} className="rag-md-ol" start={listStart}>{listItems}</ol>);
    } else {
      nodes.push(<ul key={nodes.length} className="rag-md-ul">{listItems}</ul>);
    }
    listItems = [];
    listType = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Numbered list: "1. text" or "10. text"
    const olMatch = /^(\d+)\.\s+(.*)$/.exec(line);
    if (olMatch) {
      if (listType !== "ol") {
        flushList();
        listType = "ol";
        listStart = Number(olMatch[1]);
      }
      listItems.push(<li key={i}>{renderInline(olMatch[2])}</li>);
      continue;
    }

    // Bullet list: "- text" or "* text"
    const ulMatch = /^[-*]\s+(.*)$/.exec(line);
    if (ulMatch) {
      if (listType !== "ul") { flushList(); listType = "ul"; }
      listItems.push(<li key={i}>{renderInline(ulMatch[1])}</li>);
      continue;
    }

    // Heading
    const h3Match = /^###\s+(.*)$/.exec(line);
    const h2Match = /^##\s+(.*)$/.exec(line);
    const h1Match = /^#\s+(.*)$/.exec(line);
    if (h3Match || h2Match || h1Match) {
      flushList();
      const match = (h3Match ?? h2Match ?? h1Match)!;
      const Tag = h3Match ? "h5" : h2Match ? "h4" : "h3";
      nodes.push(<Tag key={i} className="rag-md-heading">{renderInline(match[1])}</Tag>);
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      flushList();
      nodes.push(<hr key={i} className="rag-md-hr" />);
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === "") {
      flushList();
      if (nodes.length > 0) nodes.push(<div key={`gap-${i}`} className="rag-md-gap" />);
      continue;
    }

    // Regular paragraph line
    flushList();
    nodes.push(<p key={i} className="rag-md-p">{renderInline(line)}</p>);
  }

  flushList();
  return <div className="rag-md">{nodes}</div>;
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
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);

  const selectedKb = useMemo(() => kbs.find((kb) => kb.id === selectedKbId) ?? null, [kbs, selectedKbId]);
  const activeSyncJob = useMemo(() => latestSyncJob(selectedKb), [selectedKb]);
  const adminMode = isPrivileged(identity);
  const hasKnowledgeBases = kbs.length > 0;
  const threadGroups = useMemo(() => groupThreadsByTime(threads), [threads]);

  // Load dark mode preference
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("rag-chat:dark-mode");
    setDarkMode(stored !== "false");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("rag-chat:dark-mode", darkMode ? "true" : "false");
  }, [darkMode]);

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
        if (summaries.length === 0) { setActiveThreadId(null); setActiveThread(null); return; }
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
        if (active) setInitializing(false);
      }
    }
    void loadInitialState();
    return () => { active = false; };
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
    if (!selectedKbId) { setSyncHistory([]); return; }
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    async function refreshSyncState(): Promise<void> {
      try {
        const [job, history] = await Promise.all([
          fetchRag<RagKbSyncJob>(`/rag/knowledge-bases/${selectedKbId}/sync-status`),
          fetchRag<RagSyncHistoryResponse>(`/rag/knowledge-bases/${selectedKbId}/sync-history?limit=5`)
        ]);
        if (!active) return;
        setKbs((current) => current.map((kb) => (kb.id === selectedKbId ? { ...kb, syncJobs: job.id ? [job] : [] } : kb)));
        setSyncHistory(history.jobs);
        if (job.status === "running" || job.status === "pending") {
          timeoutId = setTimeout(() => { void refreshSyncState(); }, 3000);
        }
      } catch { if (!active) return; }
    }
    void refreshSyncState();
    return () => { active = false; if (timeoutId) clearTimeout(timeoutId); };
  }, [selectedKbId]);

  function syncKbSelection(kbId: string): void {
    setSelectedKbId(kbId);
    setShowConfig(false);
    const kb = kbs.find((c) => c.id === kbId) ?? null;
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
      if (thread.knowledgeBaseId) syncKbSelection(thread.knowledgeBaseId);
      setShowConfig(false);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "Unable to load this discussion.");
    } finally {
      setLoadingThreadId(null);
    }
  }

  async function createDiscussion(seed?: string): Promise<void> {
    if (!selectedKbId) { setChatError("OPERATIONS_AI_NOT_CONFIGURED"); return; }
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
      const remaining = threads.filter((t) => t.id !== threadId);
      setThreads(remaining);
      if (activeThreadId === threadId) { setActiveThreadId(null); setActiveThread(null); setComposer(""); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to delete this discussion.";
      setSidebarError(message);
      if (activeThreadId === threadId) setChatError(message);
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
        return { ...response.thread, messages: [...priorMessages, response.userMessage, response.assistantMessage] };
      });
      setActiveThreadId(response.thread.id);
      if (response.thread.knowledgeBaseId) syncKbSelection(response.thread.knowledgeBaseId);
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
      setKbs((current) => current.map((kb) => (kb.id === selectedKbId ? { ...kb, config: updated } : kb)));
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

  const syncDotClass =
    activeSyncJob?.status === "completed"
      ? "rag-chat-sync-dot-ok"
      : activeSyncJob?.status === "failed"
        ? "rag-chat-sync-dot-err"
        : activeSyncJob?.status === "running"
          ? "rag-chat-sync-dot-run"
          : "rag-chat-sync-dot-idle";

  return (
    <div className={`rag-chat ${darkMode ? "rag-chat-dark" : "rag-chat-light"}`}>

      {/* ── Left sidebar ─────────────────────────────────────────────── */}
      <aside className="rag-chat-sidebar">
        <div className="rag-chat-sidebar-head">
          <button
            type="button"
            className="rag-chat-new-btn"
            onClick={() => startNewDiscussion()}
            disabled={sending || !hasKnowledgeBases}
          >
            <span className="rag-chat-new-plus">+</span> New chat
          </button>
          <button
            type="button"
            className="rag-chat-sidebar-icon-btn"
            title="Toggle sidebar layout"
            aria-label="sidebar options"
          >
            ☰
          </button>
        </div>

        <div className="rag-chat-thread-groups">
          {initializing ? (
            <p className="rag-chat-muted rag-chat-thread-loading">Loading discussions…</p>
          ) : threadGroups.length === 0 ? (
            <p className="rag-chat-muted rag-chat-thread-loading">
              {hasKnowledgeBases ? "No discussions yet. Start a new chat." : "Connect a knowledge base to begin."}
            </p>
          ) : (
            threadGroups.map((group) => (
              <div key={group.label} className="rag-chat-thread-group">
                <p className="rag-chat-group-label">{group.label}</p>
                {group.items.map((thread) => {
                  const isActive = thread.id === activeThreadId && !showConfig;
                  const isBusy = deletingThreadId === thread.id || loadingThreadId === thread.id;
                  return (
                    <div key={thread.id} className={`rag-chat-thread-row${isActive ? " rag-chat-thread-row-active" : ""}`}>
                      <button
                        type="button"
                        className="rag-chat-thread-btn"
                        onClick={() => void loadThread(thread.id)}
                        disabled={isBusy || sending}
                      >
                        <span className="rag-chat-thread-icon" aria-hidden>☐</span>
                        <span className="rag-chat-thread-name">{thread.title}</span>
                      </button>
                      <button
                        type="button"
                        className="rag-chat-thread-del-btn"
                        aria-label={`Delete ${thread.title}`}
                        onClick={() => void handleDelete(thread.id)}
                        disabled={isBusy || sending}
                        title="Delete"
                      >
                        {deletingThreadId === thread.id ? "…" : "×"}
                      </button>
                    </div>
                  );
                })}
              </div>
            ))
          )}
          {sidebarError ? <p className="rag-chat-sidebar-error">{sidebarError}</p> : null}
        </div>

        {/* ── Sidebar footer ──────────────────────────────────────────── */}
        <div className="rag-chat-sidebar-footer">
          {hasKnowledgeBases ? (
            <>
              <p className="rag-chat-kb-section-label">KNOWLEDGE BASE</p>
              <div className="rag-chat-kb-selector-wrap">
                <select
                  value={selectedKbId}
                  onChange={(e) => syncKbSelection(e.target.value)}
                  className="rag-chat-kb-select"
                >
                  {kbs.map((kb) => (
                    <option key={kb.id} value={kb.id}>
                      {kb.name}{kb.isDefault ? " (Default)" : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div className="rag-chat-sync-row">
                <span className={`rag-chat-sync-dot ${syncDotClass}`} />
                <span className="rag-chat-sync-label">{syncStatusLabel(activeSyncJob)}</span>
              </div>
              {activeSyncJob?.completedAt ? (
                <p className="rag-chat-sync-time">Last synced · {formatThreadTime(activeSyncJob.completedAt)}</p>
              ) : null}

              {activeSyncJob?.filesTotal ? (
                <div className="rag-chat-progress-bar">
                  <div
                    className="rag-chat-progress-fill"
                    style={{ width: `${(activeSyncJob.filesProcessed / Math.max(activeSyncJob.filesTotal, 1)) * 100}%` }}
                  />
                </div>
              ) : null}

              <div className="rag-chat-sync-actions">
                {activeSyncJob?.status === "failed" ? (
                  <button
                    type="button"
                    className="rag-chat-sync-btn"
                    onClick={() => void handleRetryFailedIndexing()}
                    disabled={retryingIndexing}
                  >
                    {retryingIndexing ? "Retrying…" : "↻ Retry indexing"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rag-chat-sync-btn"
                  onClick={() => void handleManualSync()}
                  disabled={syncingKb || activeSyncJob?.status === "running"}
                >
                  ↻ {syncingKb || activeSyncJob?.status === "running" ? "Syncing…" : "Sync now"}
                </button>
              </div>

              {syncHistory.length > 0 ? (
                <div className="rag-chat-sync-history">
                  {syncHistory.slice(0, 3).map((job) => (
                    <span key={job.id} className="rag-chat-sync-history-item">
                      {syncStatusLabel(job)} · {formatThreadTime(job.createdAt ?? job.startedAt ?? job.completedAt ?? "")}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}

          <Link href="/knowledge-connector" className="rag-chat-kb-link">
            <span className="rag-chat-kb-link-icon">⊞</span> Knowledge connector
          </Link>

          {identity ? (
            <div className="rag-chat-user-row">
              <span className="rag-chat-user-avatar">{identity.userId.charAt(0).toUpperCase()}</span>
              <div className="rag-chat-user-info">
                <p className="rag-chat-user-name">{identity.userId}</p>
                <p className="rag-chat-user-role">{identity.roles.join(", ") || "viewer"}</p>
              </div>
            </div>
          ) : null}
        </div>
      </aside>

      {/* ── Main panel ───────────────────────────────────────────────── */}
      <main className="rag-chat-main">
        {/* Top bar */}
        <div className="rag-chat-topbar">
          <div className="rag-chat-topbar-title">
            <span className="rag-chat-topbar-sparkle" aria-hidden>✦</span>
            <span>RAG Assistant</span>
            {selectedKb ? (
              <>
                <span className="rag-chat-topbar-sep" aria-hidden>·</span>
                <span className="rag-chat-topbar-kb">{selectedKb.name}</span>
              </>
            ) : null}
          </div>
          <div className="rag-chat-topbar-actions">
            {adminMode && selectedKb ? (
              <button
                type="button"
                className="rag-chat-topbar-icon-btn"
                title="Configure knowledge base"
                onClick={() => setShowConfig((v) => !v)}
              >
                ⚙
              </button>
            ) : null}
            <button
              type="button"
              className="rag-chat-topbar-icon-btn"
              title={darkMode ? "Switch to light mode" : "Switch to dark mode"}
              onClick={() => setDarkMode((v) => !v)}
            >
              {darkMode ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Transcript / config / empty state */}
        {showConfig && adminMode ? (
          <div className="rag-chat-config-panel">
            <h2>Configure {selectedKb?.name ?? "Knowledge Base"}</h2>
            <p className="rag-chat-config-sub">Override Dify response defaults for this knowledge base.</p>
            <div className="rag-chat-config-form">
              <div className="rag-chat-config-field">
                <label>Response Style</label>
                <select
                  value={configForm.responseStyle}
                  onChange={(e) => setConfigForm((c) => ({ ...c, responseStyle: e.target.value }))}
                >
                  <option value="">Platform Default</option>
                  <option value="formal">Formal</option>
                  <option value="casual">Casual</option>
                  <option value="technical">Technical</option>
                  <option value="friendly">Friendly</option>
                </select>
              </div>
              <div className="rag-chat-config-field">
                <label>Tone Instructions</label>
                <textarea
                  value={configForm.toneInstructions}
                  onChange={(e) => setConfigForm((c) => ({ ...c, toneInstructions: e.target.value }))}
                  placeholder="Always be concise and include relevant services, pages, or endpoints."
                  rows={3}
                />
              </div>
              <div className="rag-chat-config-field">
                <label>Restriction Rules</label>
                <textarea
                  value={configForm.restrictionRules}
                  onChange={(e) => setConfigForm((c) => ({ ...c, restrictionRules: e.target.value }))}
                  placeholder="Only answer questions supported by platform operations documentation."
                  rows={3}
                />
              </div>
              <div className="rag-chat-config-actions">
                <button type="button" className="rag-chat-primary-btn" onClick={() => void handleSaveConfig()} disabled={savingConfig}>
                  {savingConfig ? "Saving…" : "Save Configuration"}
                </button>
                <button type="button" className="rag-chat-secondary-btn" onClick={() => setShowConfig(false)}>Cancel</button>
              </div>
              {chatError ? <p className="rag-chat-chat-error">{chatError}</p> : null}
            </div>
          </div>
        ) : (
          <div ref={transcriptRef} className="rag-chat-transcript">
            {activeThread && activeThread.messages.length > 0 ? (
              <div className="rag-chat-message-list">
                {activeThread.messages.map((msg) => (
                  <article key={msg.id} className={`rag-chat-msg rag-chat-msg-${msg.role}`}>
                    <p className="rag-chat-msg-label">
                      {msg.role === "assistant" ? "Operations AI" : "You"}
                      <span className="rag-chat-msg-time">{formatMessageTime(msg.createdAt)}</span>
                    </p>
                    <div className="rag-chat-msg-bubble">
                      {msg.role === "assistant"
                        ? <MarkdownMessage content={msg.content} />
                        : <p className="rag-md-p">{msg.content}</p>}
                    </div>
                  </article>
                ))}
                {sending ? (
                  <article className="rag-chat-msg rag-chat-msg-assistant">
                    <p className="rag-chat-msg-label">Operations AI <span className="rag-chat-msg-time">Thinking…</span></p>
                    <div className="rag-chat-msg-bubble rag-chat-msg-pending">
                      <p>Searching the knowledge base and preparing a response…</p>
                    </div>
                  </article>
                ) : null}
              </div>
            ) : (
              <div className="rag-chat-empty">
                <div className="rag-chat-empty-icon" aria-hidden>
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6L12 2z" />
                  </svg>
                </div>
                <h2 className="rag-chat-empty-title">
                  {hasKnowledgeBases ? "How can I help with operations today?" : "Operations AI setup required"}
                </h2>
                <p className="rag-chat-empty-sub">
                  {hasKnowledgeBases
                    ? "Ask grounded questions about your connected knowledge bases."
                    : adminMode
                      ? "Connect a source on the Knowledge Connector page to create your knowledge base."
                      : "Ask an administrator to configure a knowledge base, or connect one yourself."}
                </p>
                {hasKnowledgeBases ? (
                  <div className="rag-chat-empty-suggestions">
                    {SUGGESTED_QUESTIONS.map((q) => (
                      <button key={q} type="button" className="rag-chat-suggestion-btn" onClick={() => startNewDiscussion(q)} disabled={sending}>
                        {q}
                      </button>
                    ))}
                  </div>
                ) : (
                  <Link href="/knowledge-connector" className="rag-chat-setup-link">Open Knowledge Connector →</Link>
                )}
              </div>
            )}
          </div>
        )}

        {/* Composer */}
        <div className="rag-chat-composer-area">
          {chatError ? <p className="rag-chat-chat-error">{chatError}</p> : null}
          <div className="rag-chat-composer">
            <textarea
              ref={composerRef}
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                hasKnowledgeBases
                  ? "Ask about registration, logs, secrets, security health…"
                  : "Operations AI is waiting for a knowledge base."
              }
              disabled={initializing || sending || !hasKnowledgeBases || showConfig}
              rows={1}
              className="rag-chat-composer-input"
            />
            <button
              type="button"
              className="rag-chat-send-btn"
              onClick={() => void handleSendMessage()}
              disabled={initializing || sending || !composer.trim() || !hasKnowledgeBases || showConfig}
              aria-label="Send message"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          </div>
          <p className="rag-chat-composer-hint">
            Enter to send · Shift+Enter for newline
            {selectedKb ? <> · Grounded in <strong>{selectedKb.name}</strong></> : null}
          </p>
        </div>
      </main>
    </div>
  );
}
