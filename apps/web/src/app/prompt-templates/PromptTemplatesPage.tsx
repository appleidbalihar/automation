"use client";

import { type ReactElement, useCallback, useEffect, useState } from "react";
import { fetchIdentity } from "../auth-client";
import type { PromptTemplate } from "./types";
import { deleteTemplate, duplicateTemplate, listTemplates } from "./api";
import { TemplateCard } from "./TemplateCard";
import { TemplateEditorModal } from "./TemplateEditorModal";

type Tab = "all" | "builtin" | "mine" | "shared";

export function PromptTemplatesPage(): ReactElement {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("all");
  const [editorTarget, setEditorTarget] = useState<PromptTemplate | null | undefined>(undefined);
  const [currentUserId, setCurrentUserId] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    fetchIdentity()
      .then((id) => {
        setCurrentUserId(id.userId ?? "");
        setIsAdmin(id.roles?.includes("admin") ?? false);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await listTemplates());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = templates.filter((t) => {
    if (tab === "builtin") return t.isBuiltIn;
    if (tab === "mine") return t.ownerId === currentUserId && !t.isBuiltIn;
    if (tab === "shared") return t.shareScope !== "private" && t.ownerId !== currentUserId && !t.isBuiltIn;
    return true;
  });

  async function handleDuplicate(t: PromptTemplate): Promise<void> {
    try {
      const copy = await duplicateTemplate(t.id);
      setTemplates((prev) => [...prev, copy]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleDelete(t: PromptTemplate): Promise<void> {
    if (!window.confirm(`Delete template "${t.name}"?`)) return;
    try {
      await deleteTemplate(t.id);
      setTemplates((prev) => prev.filter((x) => x.id !== t.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleSaved(saved: PromptTemplate): void {
    setTemplates((prev) => {
      const idx = prev.findIndex((x) => x.id === saved.id);
      if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
      return [...prev, saved];
    });
    setEditorTarget(undefined);
  }

  return (
    <div className="tpl-page">
      <div className="tpl-page-header">
        <div>
          <h1 className="tpl-page-title">AI Agent Prompt Templates</h1>
          <p className="tpl-page-subtitle">Manage reusable system prompts for your Knowledge Base AI agents.</p>
        </div>
        <button type="button" className="ops-btn ops-btn-primary" onClick={() => setEditorTarget(null)}>
          + New Template
        </button>
      </div>

      <div className="tpl-tabs">
        {(["all", "builtin", "mine", "shared"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            className={`tpl-tab${tab === t ? " tpl-tab-active" : ""}`}
            onClick={() => setTab(t)}
          >
            {t === "all" ? "All" : t === "builtin" ? "Built-in" : t === "mine" ? "My Templates" : "Shared with Me"}
          </button>
        ))}
      </div>

      {error && <p className="tpl-error" style={{ marginBottom: 12 }}>{error}</p>}

      {loading ? (
        <p className="tpl-loading">Loading templates…</p>
      ) : filtered.length === 0 ? (
        <div className="tpl-empty">
          <p>No templates found.</p>
          <button type="button" className="ops-btn ops-btn-secondary" onClick={() => setEditorTarget(null)}>
            Create your first template
          </button>
        </div>
      ) : (
        <div className="tpl-grid">
          {filtered.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              currentUserId={currentUserId}
              isAdmin={isAdmin}
              onEdit={(tpl) => setEditorTarget(tpl)}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      {editorTarget !== undefined && (
        <TemplateEditorModal
          template={editorTarget}
          isAdmin={isAdmin}
          onClose={() => setEditorTarget(undefined)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
