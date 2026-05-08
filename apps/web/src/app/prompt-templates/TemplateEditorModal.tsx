"use client";

import { type ReactElement, useState } from "react";
import type { PromptTemplate, TemplateCategory, TemplateFormState } from "./types";
import { CATEGORY_LABELS, EMPTY_TEMPLATE_FORM } from "./types";
import { createTemplate, generateTemplatePrompt, updateTemplate } from "./api";

type Props = {
  template: PromptTemplate | null;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (t: PromptTemplate) => void;
};

export function TemplateEditorModal({ template, isAdmin, onClose, onSaved }: Props): ReactElement {
  const isEdit = template !== null;
  const [form, setForm] = useState<TemplateFormState>(() =>
    isEdit
      ? {
          name: template.name,
          description: template.description ?? "",
          category: template.category,
          systemPromptBase: template.systemPromptBase ?? "",
          responseStyle: template.responseStyle ?? "",
          toneInstructions: template.toneInstructions ?? "",
          restrictionRules: template.restrictionRules ?? "",
          shareScope: template.shareScope,
          isBuiltIn: template.isBuiltIn
        }
      : { ...EMPTY_TEMPLATE_FORM }
  );
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showFineTune, setShowFineTune] = useState(false);

  const hasPromptText = form.systemPromptBase.trim().length > 0;
  const generateLabel = hasPromptText ? "✦ Improve" : "✦ Recommend Best Practice";

  async function handleGenerate(): Promise<void> {
    setGenerating(true);
    setError(null);
    try {
      const res = await generateTemplatePrompt({
        description: form.systemPromptBase.trim() || undefined,
        category: form.category,
        templateName: form.name.trim() || undefined
      });
      setForm((f) => ({ ...f, systemPromptBase: res.suggestion }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!form.name.trim()) { setError("Name is required"); return; }
    if (!form.systemPromptBase.trim()) { setError("System prompt content is required"); return; }
    setSaving(true);
    setError(null);
    try {
      const saved = isEdit
        ? await updateTemplate(template.id, form)
        : await createTemplate(form);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ops-modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ops-modal-panel" style={{ maxWidth: 700 }}>
        <div className="ops-modal-panel-header">
          <h2>{isEdit ? "Edit Template" : "New Prompt Template"}</h2>
          <button type="button" className="ops-modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="ops-modal-form" style={{ gap: 14 }}>
          <div className="tpl-form-row">
            <div className="tpl-form-field tpl-form-field-grow">
              <label>Name *</label>
              <input
                className="tpl-input"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. DevOps Engineer"
              />
            </div>
            <div className="tpl-form-field">
              <label>Category</label>
              <select
                className="tpl-select"
                value={form.category}
                onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as TemplateCategory }))}
              >
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="tpl-form-field">
            <label>Description</label>
            <input
              className="tpl-input"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Short description shown on the card"
            />
          </div>

          <div className="tpl-form-field">
            <div className="tpl-form-label-row">
              <label>System Prompt Content *</label>
              <button
                type="button"
                className="ops-btn ops-btn-sm ops-btn-ghost"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? "Generating…" : generateLabel}
              </button>
            </div>
            <textarea
              className="tpl-textarea"
              rows={12}
              value={form.systemPromptBase}
              onChange={(e) => setForm((f) => ({ ...f, systemPromptBase: e.target.value }))}
              placeholder="Describe this knowledge base and how the assistant should answer…"
            />
            <p className="tpl-hint">Platform grounding rules (faithfulness, credential security, confidence) are appended automatically.</p>
          </div>

          <button
            type="button"
            className="tpl-finetune-toggle"
            onClick={() => setShowFineTune((v) => !v)}
          >
            {showFineTune ? "▾" : "▸"} Fine-tune options (optional)
          </button>

          {showFineTune && (
            <div className="tpl-finetune-panel">
              <div className="tpl-form-field">
                <label>Response Style</label>
                <select
                  className="tpl-select"
                  value={form.responseStyle}
                  onChange={(e) => setForm((f) => ({ ...f, responseStyle: e.target.value }))}
                >
                  <option value="">Default</option>
                  <option value="formal">Formal</option>
                  <option value="technical">Technical</option>
                  <option value="casual">Casual</option>
                  <option value="concise">Concise</option>
                </select>
              </div>
              <div className="tpl-form-field">
                <label>Tone Instructions</label>
                <input
                  className="tpl-input"
                  value={form.toneInstructions}
                  onChange={(e) => setForm((f) => ({ ...f, toneInstructions: e.target.value }))}
                  placeholder="e.g. Use numbered steps. Include exact commands in code blocks."
                />
              </div>
              <div className="tpl-form-field">
                <label>Topic Restriction</label>
                <input
                  className="tpl-input"
                  value={form.restrictionRules}
                  onChange={(e) => setForm((f) => ({ ...f, restrictionRules: e.target.value }))}
                  placeholder="e.g. Answer only DevOps and infrastructure questions."
                />
              </div>
              {isAdmin && (
                <div className="tpl-form-row tpl-form-row-gap">
                  <div className="tpl-form-field">
                    <label>Visibility</label>
                    <select
                      className="tpl-select"
                      value={form.shareScope}
                      onChange={(e) => setForm((f) => ({ ...f, shareScope: e.target.value as TemplateFormState["shareScope"] }))}
                    >
                      <option value="private">Private</option>
                      <option value="all">Shared with everyone</option>
                      <option value="specific">Specific users</option>
                    </select>
                  </div>
                  <label className="tpl-checkbox-label">
                    <input
                      type="checkbox"
                      checked={form.isBuiltIn}
                      onChange={(e) => setForm((f) => ({ ...f, isBuiltIn: e.target.checked }))}
                    />
                    Mark as built-in
                  </label>
                </div>
              )}
            </div>
          )}

          {error && <p className="tpl-error">{error}</p>}
        </div>

        <div className="ops-modal-footer">
          <button type="button" className="ops-btn ops-btn-secondary" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="ops-btn ops-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Create Template"}
          </button>
        </div>
      </div>
    </div>
  );
}
