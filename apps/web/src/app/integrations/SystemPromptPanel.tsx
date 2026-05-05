"use client";

/**
 * SystemPromptPanel — Per-knowledge-base system prompt configuration.
 *
 * Only shown to admin and useradmin roles.
 *
 * Layout:
 *   1. Platform Default Prompt (read-only, always applied, collapsible)
 *   2. KB-Specific Instructions (editable textarea)
 *      └── ✦ Generate button → AI rewrites rough input → suggestion box
 *          └── [Apply This Suggestion] [Regenerate]
 *   3. Response Style dropdown + Tone Instructions textarea
 *   4. Topic Restriction textarea
 *   5. [Save Config] button
 */

import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { requestJson } from "./api";

type KbConfig = {
  systemPromptBase?: string | null;
  responseStyle?: string | null;
  toneInstructions?: string | null;
  restrictionRules?: string | null;
};

type DefaultPromptResponse = {
  defaultPrompt: string;
  description: string;
};

type GeneratePromptResponse = {
  suggestion: string;
  kbId: string;
};

type Props = {
  kbId: string;
  /** Current KB config loaded from the knowledge base */
  initialConfig?: KbConfig | null;
  /** Called after successfully saving config */
  onSaved?: (updatedConfig: KbConfig) => void;
};

const RESPONSE_STYLE_OPTIONS = [
  { value: "", label: "— Default (no style override) —" },
  { value: "formal", label: "Formal — professional, precise language" },
  { value: "technical", label: "Technical — detailed, code-friendly" },
  { value: "casual", label: "Casual — conversational, easy to read" },
  { value: "bullet_points", label: "Bullet Points — structured lists" },
  { value: "concise", label: "Concise — brief answers only" }
];

export function SystemPromptPanel({ kbId, initialConfig, onSaved }: Props): ReactElement {
  const [defaultPrompt, setDefaultPrompt] = useState<string>("");
  const [defaultPromptDesc, setDefaultPromptDesc] = useState<string>("");
  const [defaultPromptOpen, setDefaultPromptOpen] = useState(false);

  const [systemPromptBase, setSystemPromptBase] = useState(initialConfig?.systemPromptBase ?? "");
  const [responseStyle, setResponseStyle] = useState(initialConfig?.responseStyle ?? "");
  const [toneInstructions, setToneInstructions] = useState(initialConfig?.toneInstructions ?? "");
  const [restrictionRules, setRestrictionRules] = useState(initialConfig?.restrictionRules ?? "");

  const [generating, setGenerating] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Load platform default prompt on mount
  useEffect(() => {
    requestJson<DefaultPromptResponse>("/rag/knowledge-bases/default-prompt", "GET")
      .then((res) => {
        setDefaultPrompt(res.defaultPrompt);
        setDefaultPromptDesc(res.description);
      })
      .catch(() => {
        setDefaultPrompt("(Could not load platform default prompt)");
      });
  }, []);

  // Sync from parent if initialConfig changes (e.g. after KB reload)
  useEffect(() => {
    setSystemPromptBase(initialConfig?.systemPromptBase ?? "");
    setResponseStyle(initialConfig?.responseStyle ?? "");
    setToneInstructions(initialConfig?.toneInstructions ?? "");
    setRestrictionRules(initialConfig?.restrictionRules ?? "");
  }, [initialConfig]);

  async function handleGenerate(): Promise<void> {
    const description = systemPromptBase.trim();
    if (!description) {
      setGenerateError("Type a rough description first, then click Generate to improve it.");
      return;
    }
    setGenerating(true);
    setSuggestion(null);
    setGenerateError(null);
    try {
      const result = await requestJson<GeneratePromptResponse>(
        `/rag/knowledge-bases/${kbId}/generate-prompt`,
        "POST",
        { description }
      );
      setSuggestion(result.suggestion);
    } catch (err) {
      setGenerateError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  function handleApplySuggestion(): void {
    if (suggestion) {
      setSystemPromptBase(suggestion);
      setSuggestion(null);
    }
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setSaveStatus(null);
    setSaveError(null);
    try {
      const patch: KbConfig = {
        systemPromptBase: systemPromptBase.trim() || null,
        responseStyle: responseStyle.trim() || null,
        toneInstructions: toneInstructions.trim() || null,
        restrictionRules: restrictionRules.trim() || null
      };
      await requestJson(`/rag/knowledge-bases/${kbId}/config`, "PATCH", patch);
      setSaveStatus("System prompt configuration saved.");
      onSaved?.(patch);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="ops-system-prompt-panel">
      <h3 className="ops-edit-section-title" style={{ marginBottom: 12 }}>
        🤖 System Prompt Configuration
      </h3>

      {/* ── Platform Default (read-only, collapsible) ── */}
      <div className="ops-system-prompt-default">
        <button
          type="button"
          className="ops-system-prompt-default-toggle"
          onClick={() => setDefaultPromptOpen((o) => !o)}
          aria-expanded={defaultPromptOpen}
        >
          <span className="ops-system-prompt-default-label">
            {defaultPromptOpen ? "▼" : "▶"} Platform Default Prompt
          </span>
          <span className="ops-system-prompt-default-badge">Always Applied · Read-only</span>
        </button>

        {defaultPromptOpen && (
          <div className="ops-system-prompt-default-body">
            <p className="ops-system-prompt-default-desc">{defaultPromptDesc}</p>
            <pre className="ops-system-prompt-default-text">{defaultPrompt}</pre>
          </div>
        )}
      </div>

      {/* ── KB-Specific Instructions ── */}
      <div className="ops-system-prompt-kb-section">
        <label className="ops-form-label" htmlFor={`system-prompt-${kbId}`}>
          KB-Specific Instructions
          <span className="ops-form-label-hint"> (optional — appended after the platform default)</span>
        </label>

        <textarea
          id={`system-prompt-${kbId}`}
          className="ops-system-prompt-textarea"
          value={systemPromptBase}
          onChange={(e) => setSystemPromptBase(e.target.value)}
          placeholder="Describe what this knowledge base is about and how the assistant should answer questions for it.&#10;&#10;Example: This KB covers DevOps runbooks for the ACME platform. Prioritise step-by-step commands. Always mention which runbook the answer comes from."
          rows={5}
        />

        {/* ✦ Generate button row */}
        <div className="ops-system-prompt-generate-row">
          <button
            type="button"
            className="ops-btn ops-btn-secondary ops-system-prompt-generate-btn"
            onClick={() => void handleGenerate()}
            disabled={generating}
          >
            {generating ? "✦ Generating…" : "✦ Generate"}
          </button>
          <span className="ops-system-prompt-generate-hint">
            Type a rough description above, then click Generate to have AI improve it.
          </span>
        </div>

        {generateError && (
          <p className="ops-system-prompt-error">{generateError}</p>
        )}

        {/* AI suggestion box */}
        {suggestion && (
          <div className="ops-system-prompt-suggestion">
            <div className="ops-system-prompt-suggestion-header">
              <span className="ops-system-prompt-suggestion-label">✦ AI Suggestion</span>
              <div className="ops-system-prompt-suggestion-actions">
                <button
                  type="button"
                  className="ops-btn ops-btn-primary ops-btn-sm"
                  onClick={handleApplySuggestion}
                >
                  Apply This Suggestion
                </button>
                <button
                  type="button"
                  className="ops-btn ops-btn-secondary ops-btn-sm"
                  onClick={() => void handleGenerate()}
                  disabled={generating}
                >
                  {generating ? "Regenerating…" : "Regenerate"}
                </button>
                <button
                  type="button"
                  className="ops-btn ops-btn-ghost ops-btn-sm"
                  onClick={() => setSuggestion(null)}
                >
                  Dismiss
                </button>
              </div>
            </div>
            <pre className="ops-system-prompt-suggestion-text">{suggestion}</pre>
          </div>
        )}
      </div>

      {/* ── Response Style ── */}
      <div className="ops-system-prompt-style-section">
        <label className="ops-form-label" htmlFor={`response-style-${kbId}`}>
          Response Style
        </label>
        <select
          id={`response-style-${kbId}`}
          className="ops-select"
          value={responseStyle}
          onChange={(e) => setResponseStyle(e.target.value)}
        >
          {RESPONSE_STYLE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        <label className="ops-form-label" htmlFor={`tone-${kbId}`} style={{ marginTop: 12 }}>
          Additional Tone Instructions
          <span className="ops-form-label-hint"> (optional)</span>
        </label>
        <input
          id={`tone-${kbId}`}
          type="text"
          className="ops-input"
          value={toneInstructions}
          onChange={(e) => setToneInstructions(e.target.value)}
          placeholder="e.g. Always use bullet points. Keep answers under 5 sentences."
        />

        <label className="ops-form-label" htmlFor={`restriction-${kbId}`} style={{ marginTop: 12 }}>
          Topic Restriction
          <span className="ops-form-label-hint"> (optional)</span>
        </label>
        <input
          id={`restriction-${kbId}`}
          type="text"
          className="ops-input"
          value={restrictionRules}
          onChange={(e) => setRestrictionRules(e.target.value)}
          placeholder="e.g. Only answer questions related to DevOps and infrastructure. Decline off-topic questions."
        />
      </div>

      {/* ── Save row ── */}
      <div className="ops-system-prompt-save-row">
        <button
          type="button"
          className="ops-btn ops-btn-primary"
          onClick={() => void handleSave()}
          disabled={saving}
        >
          {saving ? "Saving…" : "Save Prompt Config"}
        </button>
        {saveStatus && <span className="ops-system-prompt-save-ok">{saveStatus}</span>}
        {saveError && <span className="ops-system-prompt-save-error">{saveError}</span>}
      </div>
    </div>
  );
}
