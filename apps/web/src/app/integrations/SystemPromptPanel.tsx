"use client";

import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { requestJson } from "./api";
import type { Integration, KbConfig } from "./types";
import type { PromptTemplate } from "../prompt-templates/types";
import { CATEGORY_ICONS } from "../prompt-templates/types";
import { applyTemplateToKb, listTemplates } from "../prompt-templates/api";

type ConfigSaveResponse = KbConfig & {
  difyPromptUpdated?: boolean;
  difyPromptError?: string;
};

type Props = {
  kbId: string;
  initialConfig?: KbConfig | null;
  templateId?: string | null;
  templateName?: string | null;
  onSaved?: (updatedConfig: KbConfig, template?: Pick<Integration, "templateId" | "templateName">) => void;
};

const RESPONSE_STYLE_OPTIONS = [
  { value: "", label: "— Default (no style override) —" },
  { value: "formal", label: "Formal — professional, precise language" },
  { value: "technical", label: "Technical — detailed, code-friendly" },
  { value: "casual", label: "Casual — conversational, easy to read" },
  { value: "bullet_points", label: "Bullet Points — structured lists" },
  { value: "concise", label: "Concise — brief answers only" }
];

function buildPromptPreview(config: {
  systemPromptBase: string;
  responseStyle: string;
  toneInstructions: string;
  restrictionRules: string;
}): string {
  const parts: string[] = [];
  if (config.systemPromptBase.trim()) parts.push(`## Knowledge Base Context\n${config.systemPromptBase.trim()}`);
  const styleLines: string[] = [];
  if (config.responseStyle.trim()) styleLines.push(`Respond in a ${config.responseStyle.trim()} style.`);
  if (config.toneInstructions.trim()) styleLines.push(config.toneInstructions.trim());
  if (config.restrictionRules.trim()) styleLines.push(`Topic restriction: ${config.restrictionRules.trim()}`);
  if (styleLines.length > 0) parts.push(`## Response Style\n${styleLines.join(" ")}`);
  return parts.join("\n\n").trim();
}

export function SystemPromptPanel({ kbId, initialConfig, templateId: initialTemplateId, templateName: initialTemplateName, onSaved }: Props): ReactElement {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [currentTemplateId, setCurrentTemplateId] = useState(initialTemplateId ?? "");
  const [currentTemplateName, setCurrentTemplateName] = useState(initialTemplateName ?? "");
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyStatus, setApplyStatus] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [fineTuneOpen, setFineTuneOpen] = useState(false);
  const [systemPromptBase, setSystemPromptBase] = useState(initialConfig?.systemPromptBase ?? "");
  const [responseStyle, setResponseStyle] = useState(initialConfig?.responseStyle ?? "");
  const [toneInstructions, setToneInstructions] = useState(initialConfig?.toneInstructions ?? "");
  const [restrictionRules, setRestrictionRules] = useState(initialConfig?.restrictionRules ?? "");
  const [topK, setTopK] = useState<number>(initialConfig?.topK ?? 4);
  const [scoreThreshold, setScoreThreshold] = useState<number>(initialConfig?.scoreThreshold ?? 0.4);

  const [generating, setGenerating] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [lastSentPrompt, setLastSentPrompt] = useState<string | null>(null);

  const hasFineTuneText = systemPromptBase.trim().length > 0;
  const generateLabel = hasFineTuneText ? "✦ Improve" : "✦ Recommend Best Practice";

  useEffect(() => {
    setTemplatesLoading(true);
    listTemplates()
      .then(setTemplates)
      .catch(() => undefined)
      .finally(() => setTemplatesLoading(false));
  }, []);

  useEffect(() => {
    setSystemPromptBase(initialConfig?.systemPromptBase ?? "");
    setResponseStyle(initialConfig?.responseStyle ?? "");
    setToneInstructions(initialConfig?.toneInstructions ?? "");
    setRestrictionRules(initialConfig?.restrictionRules ?? "");
    setTopK(initialConfig?.topK ?? 4);
    setScoreThreshold(initialConfig?.scoreThreshold ?? 0.4);
  }, [initialConfig]);

  useEffect(() => {
    setCurrentTemplateId(initialTemplateId ?? "");
    setCurrentTemplateName(initialTemplateName ?? "");
    setSelectedTemplateId("");
    setLastSentPrompt(null);
  }, [kbId, initialTemplateId, initialTemplateName]);

  useEffect(() => {
    if (!currentTemplateId || currentTemplateName) return;
    const current = templates.find((t) => t.id === currentTemplateId);
    if (current) setCurrentTemplateName(current.name);
  }, [currentTemplateId, currentTemplateName, templates]);

  async function handleApplyTemplate(): Promise<void> {
    if (!selectedTemplateId) { setApplyError("Select a template first."); return; }
    setApplying(true);
    setApplyStatus(null);
    setApplyError(null);
    try {
      const res = await applyTemplateToKb(kbId, selectedTemplateId);
      const tpl = templates.find((t) => t.id === selectedTemplateId);
      setCurrentTemplateId(selectedTemplateId);
      setCurrentTemplateName(tpl?.name ?? selectedTemplateId);
      setApplyStatus(res.difyPromptUpdated ? "Template applied and sent to AI Agent." : "Template applied. AI Agent will receive it on next provision.");
      // Refresh fine-tune fields from template
      if (tpl) {
        setSystemPromptBase(tpl.systemPromptBase ?? "");
        setResponseStyle(tpl.responseStyle ?? "");
        setToneInstructions(tpl.toneInstructions ?? "");
        setRestrictionRules(tpl.restrictionRules ?? "");
        onSaved?.(
          { systemPromptBase: tpl.systemPromptBase ?? null, responseStyle: tpl.responseStyle ?? null, toneInstructions: tpl.toneInstructions ?? null, restrictionRules: tpl.restrictionRules ?? null },
          { templateId: tpl.id, templateName: tpl.name }
        );
      }
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : "Apply failed");
    } finally {
      setApplying(false);
    }
  }

  async function handleGenerate(): Promise<void> {
    const selectedTpl = templates.find((t) => t.id === selectedTemplateId);
    setGenerating(true);
    setSuggestion(null);
    setGenerateError(null);
    try {
      const result = await requestJson<{ suggestion: string }>("/rag/prompt-templates/generate", "POST", {
        description: systemPromptBase.trim() || undefined,
        category: selectedTpl?.category ?? "general",
        templateName: currentTemplateName !== "None" ? currentTemplateName : undefined
      });
      setSuggestion(result.suggestion);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveFineTune(): Promise<void> {
    setSaving(true);
    setSaveStatus(null);
    setSaveError(null);
    try {
      const patch: KbConfig = {
        systemPromptBase: systemPromptBase.trim() || null,
        responseStyle: responseStyle.trim() || null,
        toneInstructions: toneInstructions.trim() || null,
        restrictionRules: restrictionRules.trim() || null,
        topK,
        scoreThreshold
      };
      const updated = await requestJson<ConfigSaveResponse>(`/rag/knowledge-bases/${kbId}/config`, "PATCH", patch);
      onSaved?.({
        systemPromptBase: updated.systemPromptBase ?? null,
        responseStyle: updated.responseStyle ?? null,
        toneInstructions: updated.toneInstructions ?? null,
        restrictionRules: updated.restrictionRules ?? null,
        topK: updated.topK ?? null,
        scoreThreshold: updated.scoreThreshold ?? null
      });
      if (updated.difyPromptError) {
        setSaveStatus("Fine-tune saved. AI Agent update needs attention.");
        setSaveError(updated.difyPromptError);
      } else if (updated.difyPromptUpdated) {
        setSaveStatus("Fine-tune saved and sent to the AI Agent.");
        setLastSentPrompt(buildPromptPreview({ systemPromptBase, responseStyle, toneInstructions, restrictionRules }));
      } else {
        setSaveStatus("Fine-tune saved. AI Agent will receive it when provisioned.");
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const selectedTpl = templates.find((t) => t.id === selectedTemplateId);
  const selectedTemplatePreview = selectedTpl
    ? buildPromptPreview({
        systemPromptBase: selectedTpl.systemPromptBase ?? "",
        responseStyle: selectedTpl.responseStyle ?? "",
        toneInstructions: selectedTpl.toneInstructions ?? "",
        restrictionRules: selectedTpl.restrictionRules ?? ""
      })
    : "";
  const currentTplObj = templates.find((t) => t.id === currentTemplateId || t.name === currentTemplateName);
  const currentIcon = currentTplObj ? (CATEGORY_ICONS[currentTplObj.category] ?? "🤖") : "🤖";
  const currentTemplateDisplay = currentTemplateName || currentTplObj?.name || "Not assigned";

  return (
    <div className="ops-system-prompt-panel">
      <h3 className="ops-edit-section-title" style={{ marginBottom: 12 }}>
        🤖 AI Agent Template
      </h3>

      {/* ── Current Template ── */}
      <div className="tpl-current-section">
        <div className="tpl-current-row">
          <span className="tpl-current-label">Current Template</span>
          <span className="tpl-current-value">{currentIcon} {currentTemplateDisplay}</span>
        </div>

        <div className="tpl-change-row">
          <label className="tpl-selector-label">Change Template</label>
          {templatesLoading ? (
            <p className="tpl-loading" style={{ fontSize: "0.85rem" }}>Loading…</p>
          ) : (
            <div className="tpl-change-controls">
              <select
                className="tpl-select"
                value={selectedTemplateId}
                onChange={(e) => { setSelectedTemplateId(e.target.value); setApplyStatus(null); setApplyError(null); }}
              >
                <option value="">— Select template —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {CATEGORY_ICONS[t.category] ?? "🤖"} {t.name}{t.isBuiltIn ? " ★" : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="ops-btn ops-btn-primary ops-btn-sm"
                onClick={() => void handleApplyTemplate()}
                disabled={applying || !selectedTemplateId}
              >
                {applying ? "Applying…" : "Apply Template"}
              </button>
            </div>
          )}
          {applyStatus && <p className="ops-system-prompt-save-ok" style={{ marginTop: 6 }}>{applyStatus}</p>}
          {applyError && <p className="ops-system-prompt-save-error" style={{ marginTop: 6 }}>{applyError}</p>}
        </div>
      </div>

      {/* ── Fine-tune (collapsible) ── */}
      <button
        type="button"
        className="tpl-finetune-toggle"
        style={{ marginTop: 12 }}
        onClick={() => setFineTuneOpen((v) => !v)}
      >
        {fineTuneOpen ? "▾" : "▸"} Fine-tune (optional)
      </button>

      {fineTuneOpen && (
        <div className="tpl-finetune-panel">
          <p className="tpl-hint">Override or extend the template with KB-specific instructions. Appended on top of the template text.</p>

          <div className="tpl-form-field">
            <div className="tpl-form-label-row">
              <label>Additional Instructions</label>
              <button type="button" className="ops-btn ops-btn-sm ops-btn-ghost" onClick={() => void handleGenerate()} disabled={generating}>
                {generating ? "Generating…" : generateLabel}
              </button>
            </div>
            <textarea
              className="ops-system-prompt-textarea"
              value={systemPromptBase}
              onChange={(e) => setSystemPromptBase(e.target.value)}
              placeholder="Add KB-specific context on top of the selected template…"
              rows={5}
            />
          </div>

          {generateError && <p className="ops-system-prompt-error">{generateError}</p>}
          {suggestion && (
            <div className="ops-system-prompt-suggestion">
              <div className="ops-system-prompt-suggestion-header">
                <span className="ops-system-prompt-suggestion-label">✦ AI Suggestion</span>
                <div className="ops-system-prompt-suggestion-actions">
                  <button type="button" className="ops-btn ops-btn-primary ops-btn-sm" onClick={() => { setSystemPromptBase(suggestion); setSuggestion(null); }}>
                    Apply
                  </button>
                  <button type="button" className="ops-btn ops-btn-secondary ops-btn-sm" onClick={() => void handleGenerate()} disabled={generating}>
                    {generating ? "Regenerating…" : "Regenerate"}
                  </button>
                  <button type="button" className="ops-btn ops-btn-ghost ops-btn-sm" onClick={() => setSuggestion(null)}>Dismiss</button>
                </div>
              </div>
              <pre className="ops-system-prompt-suggestion-text">{suggestion}</pre>
            </div>
          )}

          <div className="ops-system-prompt-style-section" style={{ marginTop: 10 }}>
            <label className="ops-form-label">Response Style</label>
            <select className="ops-select" value={responseStyle} onChange={(e) => setResponseStyle(e.target.value)}>
              {RESPONSE_STYLE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
            </select>

            <label className="ops-form-label" style={{ marginTop: 10 }}>Tone Instructions <span className="ops-form-label-hint">(optional)</span></label>
            <input type="text" className="ops-input" value={toneInstructions} onChange={(e) => setToneInstructions(e.target.value)} placeholder="e.g. Always use bullet points." />

            <label className="ops-form-label" style={{ marginTop: 10 }}>Topic Restriction <span className="ops-form-label-hint">(optional)</span></label>
            <input type="text" className="ops-input" value={restrictionRules} onChange={(e) => setRestrictionRules(e.target.value)} placeholder="e.g. Answer only DevOps questions." />
          </div>

          <div className="ops-system-prompt-style-section" style={{ marginTop: 16 }}>
            <label className="ops-form-label" style={{ fontWeight: 600 }}>Retrieval Settings</label>
            <p className="tpl-hint" style={{ marginBottom: 8 }}>Controls how many document chunks are retrieved and how similar they must be to the question.</p>

            <label className="ops-form-label" style={{ marginTop: 8 }}>
              Chunks Retrieved (top_k) <span className="ops-form-label-hint">default: 4 — range 1–20</span>
            </label>
            <input
              type="number"
              className="ops-input"
              min={1}
              max={20}
              step={1}
              value={topK}
              onChange={(e) => setTopK(Math.min(20, Math.max(1, Number(e.target.value) || 4)))}
              style={{ width: 90 }}
            />

            <label className="ops-form-label" style={{ marginTop: 10 }}>
              Score Threshold <span className="ops-form-label-hint">default: 0.40 — range 0.10–0.90</span>
            </label>
            <input
              type="number"
              className="ops-input"
              min={0.1}
              max={0.9}
              step={0.05}
              value={scoreThreshold}
              onChange={(e) => setScoreThreshold(Math.min(0.9, Math.max(0.1, Number(e.target.value) || 0.4)))}
              style={{ width: 90 }}
            />
            <p className="tpl-hint" style={{ marginTop: 4 }}>Higher threshold = fewer but more precise results. Lower = more results but possibly less relevant.</p>
          </div>

          <div className="ops-system-prompt-save-row" style={{ marginTop: 12 }}>
            <button type="button" className="ops-btn ops-btn-primary" onClick={() => void handleSaveFineTune()} disabled={saving}>
              {saving ? "Saving…" : "Save Fine-tune"}
            </button>
            {saveStatus && <span className="ops-system-prompt-save-ok">{saveStatus}</span>}
            {saveError && <span className="ops-system-prompt-save-error">{saveError}</span>}
          </div>
        </div>
      )}

      {/* ── Prompt Preview ── */}
      {selectedTpl && (
        <div className="ops-system-prompt-preview" style={{ marginTop: 14 }}>
          <div className="ops-system-prompt-preview-header">
            <span className="ops-system-prompt-preview-label">📋 Preview: {selectedTpl.name}</span>
          </div>
          <pre className="ops-system-prompt-preview-text">{selectedTemplatePreview || "(This template has no prompt content.)"}</pre>
        </div>
      )}

      {lastSentPrompt && (
        <div className="ops-system-prompt-preview ops-system-prompt-last-sent">
          <div className="ops-system-prompt-preview-header">
            <span className="ops-system-prompt-preview-label">📤 Last sent to AI Agent</span>
          </div>
          <pre className="ops-system-prompt-preview-text">{lastSentPrompt}</pre>
        </div>
      )}
    </div>
  );
}
