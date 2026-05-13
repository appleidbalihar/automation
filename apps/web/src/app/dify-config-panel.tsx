"use client";

import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { resolveApiBase } from "./api-base";
import { authHeaderFromStoredToken, fetchIdentity } from "./auth-client";

type DifyConfig = {
  llm: { model: string; baseUrl: string; apiKeySet: boolean };
  embedding: { model: string; baseUrl: string; apiKeySet: boolean; maxChunks: number };
  reranker: { provider: string; model: string; apiBase: string; apiKeySet: boolean; enabled: boolean };
  workflows: { github: string; gitlab: string; googledrive: string; web: string };
  console: { appUrl: string; email: string; passwordSet: boolean };
};

type SectionStatus = "idle" | "saving" | "saved" | "error";

function StatusBanner({ status, error }: { status: SectionStatus; error: string }): ReactElement | null {
  if (status === "saving") return <span className="stat-badge stat-badge-slow">Saving…</span>;
  if (status === "saved") return <span className="stat-badge stat-badge-ok">Saved and pushed to Dify</span>;
  if (status === "error") return <span className="stat-badge stat-badge-critical">{error || "Save failed"}</span>;
  return null;
}

/** Editable text/monospace field showing current value */
function Field({
  label,
  value,
  onChange,
  placeholder
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}): ReactElement {
  return (
    <div style={{ marginBottom: "12px" }}>
      <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: "4px", color: "#6b7280" }}>
        {label}
      </label>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? ""}
        style={{
          width: "100%",
          padding: "7px 10px",
          border: "1px solid #d1d5db",
          borderRadius: "6px",
          fontSize: "0.88rem",
          fontFamily: "monospace",
          background: "#fff",
          boxSizing: "border-box"
        }}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

/**
 * Secret field: shows a "Configured" badge when already set.
 * The input is always blank on load (blank = keep current).
 * Typing a new value replaces it on save.
 */
function SecretField({
  label,
  value,
  onChange,
  isConfigured,
  optional = false
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  isConfigured: boolean;
  optional?: boolean;
}): ReactElement {
  return (
    <div style={{ marginBottom: "12px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
        <label style={{ fontSize: "0.8rem", fontWeight: 600, color: "#6b7280" }}>
          {label}{optional ? " (optional)" : ""}
        </label>
        {isConfigured && (
          <span style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            padding: "1px 7px",
            borderRadius: "10px",
            background: "#d1fae5",
            color: "#065f46",
            letterSpacing: "0.02em"
          }}>
            Configured
          </span>
        )}
        {!isConfigured && (
          <span style={{
            fontSize: "0.72rem",
            fontWeight: 700,
            padding: "1px 7px",
            borderRadius: "10px",
            background: "#fee2e2",
            color: "#991b1b",
            letterSpacing: "0.02em"
          }}>
            Not set
          </span>
        )}
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={isConfigured ? "•••••••••••••••• (leave blank to keep current)" : "Enter key"}
        style={{
          width: "100%",
          padding: "7px 10px",
          border: `1px solid ${isConfigured && !value ? "#d1d5db" : value ? "#3b82f6" : "#fca5a5"}`,
          borderRadius: "6px",
          fontSize: "0.88rem",
          background: isConfigured && !value ? "#f9fafb" : "#fff",
          boxSizing: "border-box",
          color: "#111827"
        }}
        autoComplete="new-password"
      />
    </div>
  );
}

/** Read-only display row */
function ReadOnlyRow({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div style={{ display: "flex", alignItems: "center", padding: "8px 0", borderBottom: "1px solid #f3f4f6", gap: "12px" }}>
      <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#6b7280", minWidth: "140px", flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: "0.88rem", fontFamily: "monospace", color: "#374151" }}>{value || <em style={{ color: "#9ca3af" }}>not set</em>}</span>
    </div>
  );
}

function Section({
  title,
  children,
  status,
  error,
  onSave,
  readOnly = false
}: {
  title: string;
  children: ReactElement | ReactElement[];
  status?: SectionStatus;
  error?: string;
  onSave?: () => void;
  readOnly?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", marginBottom: "16px", overflow: "hidden" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "12px 16px",
          background: "#f9fafb",
          border: "none",
          borderBottom: open ? "1px solid #e5e7eb" : "none",
          cursor: "pointer",
          fontWeight: 600,
          fontSize: "0.9rem",
          textAlign: "left"
        }}
      >
        <span>{open ? "▼" : "▶"} {title}</span>
        {status != null && <StatusBanner status={status} error={error ?? ""} />}
        {readOnly && <span style={{ fontSize: "0.72rem", color: "#9ca3af", fontWeight: 400 }}>read-only</span>}
      </button>
      {open && (
        <div style={{ padding: "16px" }}>
          {children}
          {!readOnly && onSave != null && (
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "8px" }}>
              <button
                type="button"
                onClick={onSave}
                disabled={status === "saving"}
                style={{
                  padding: "7px 18px",
                  background: status === "saving" ? "#9ca3af" : "#3b82f6",
                  color: "#fff",
                  border: "none",
                  borderRadius: "6px",
                  fontWeight: 600,
                  fontSize: "0.85rem",
                  cursor: status === "saving" ? "not-allowed" : "pointer"
                }}
              >
                {status === "saving" ? "Saving…" : `Save ${title}`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DifyConfigPanel(): ReactElement {
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);

  // Editable form state — non-secret fields pre-filled from API
  const [llm, setLlm] = useState({ model: "", baseUrl: "", apiKey: "" });
  const [llmApiKeySet, setLlmApiKeySet] = useState(false);

  const [embedding, setEmbedding] = useState({ model: "", baseUrl: "", apiKey: "", maxChunks: 16 });
  const [embApiKeySet, setEmbApiKeySet] = useState(false);

  const [reranker, setReranker] = useState({ provider: "", model: "", apiBase: "", apiKey: "", enabled: true });
  const [rerankerApiKeySet, setRerankerApiKeySet] = useState(false);

  const [workflows, setWorkflows] = useState({ github: "", gitlab: "", googledrive: "", web: "" });

  const [console_, setConsole] = useState({ appUrl: "", email: "", password: "" });
  const [consolePasswordSet, setConsolePasswordSet] = useState(false);

  // Per-section save status
  const [llmStatus, setLlmStatus] = useState<SectionStatus>("idle");
  const [llmError, setLlmError] = useState("");
  const [embStatus, setEmbStatus] = useState<SectionStatus>("idle");
  const [embError, setEmbError] = useState("");
  const [rerankerStatus, setRerankerStatus] = useState<SectionStatus>("idle");
  const [rerankerError, setRerankerError] = useState("");
  const [consoleStatus, setConsoleStatus] = useState<SectionStatus>("idle");
  const [consoleError, setConsoleError] = useState("");

  async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
    const auth = authHeaderFromStoredToken();
    return fetch(`${resolveApiBase()}${path}`, {
      ...options,
      headers: {
        ...(options?.headers ?? {}),
        ...(auth ? { authorization: auth } : {}),
        "content-type": "application/json"
      }
    });
  }

  useEffect(() => {
    fetchIdentity()
      .then((id) => setIsAdmin(id.roles.includes("admin")))
      .catch(() => setIsAdmin(false));

    apiFetch("/admin/dify/config")
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as DifyConfig;

        // Non-secret fields: show actual value
        // Secret fields: blank input + track whether configured
        setLlm({ model: data.llm.model, baseUrl: data.llm.baseUrl, apiKey: "" });
        setLlmApiKeySet(data.llm.apiKeySet);

        setEmbedding({ model: data.embedding.model, baseUrl: data.embedding.baseUrl, apiKey: "", maxChunks: data.embedding.maxChunks });
        setEmbApiKeySet(data.embedding.apiKeySet);

        setReranker({
          provider: data.reranker.provider,
          model: data.reranker.model,
          apiBase: data.reranker.apiBase,
          apiKey: "",
          enabled: data.reranker.enabled
        });
        setRerankerApiKeySet(data.reranker.apiKeySet);

        setWorkflows(data.workflows);

        setConsole({ appUrl: data.console.appUrl, email: data.console.email, password: "" });
        setConsolePasswordSet(data.console.passwordSet);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function patchSection(
    section: string,
    payload: Record<string, unknown>,
    setStatus: (s: SectionStatus) => void,
    setError: (e: string) => void
  ): Promise<void> {
    setStatus("saving");
    setError("");
    try {
      const res = await apiFetch("/admin/dify/config", {
        method: "PATCH",
        body: JSON.stringify({ [section]: payload })
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 3000);
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  if (loading) {
    return (
      <div className="panel-page">
        <div className="panel-header"><h1>Dify Configuration</h1></div>
        <p style={{ padding: "24px", color: "#6b7280" }}>Loading…</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="panel-page">
        <div className="panel-header"><h1>Dify Configuration</h1></div>
        <p style={{ padding: "24px", color: "#ef4444" }}>Admin access required.</p>
      </div>
    );
  }

  return (
    <div className="panel-page">
      <div className="panel-header">
        <h1>Dify Configuration</h1>
        <p style={{ color: "#6b7280", fontSize: "0.88rem", marginTop: "4px" }}>
          Platform-wide Dify settings — changes apply immediately to Vault and are pushed to Dify.{" "}
          <span style={{ background: "#fee2e2", color: "#dc2626", padding: "2px 8px", borderRadius: "4px", fontSize: "0.8rem", fontWeight: 600 }}>
            Admin only
          </span>
        </p>
      </div>

      <div style={{ maxWidth: "680px", padding: "0 24px 40px" }}>

        {/* ── LLM Provider ── */}
        <Section
          title="LLM Provider"
          status={llmStatus}
          error={llmError}
          onSave={() => {
            const payload: Record<string, unknown> = {};
            if (llm.model) payload.model = llm.model;
            if (llm.baseUrl) payload.baseUrl = llm.baseUrl;
            if (llm.apiKey) payload.apiKey = llm.apiKey;
            void patchSection("llm", payload, setLlmStatus, setLlmError);
          }}
        >
          <Field
            label="Chat Model"
            value={llm.model}
            onChange={(v) => setLlm((p) => ({ ...p, model: v }))}
            placeholder="e.g. claude-sonnet-4-6"
          />
          <Field
            label="Base URL"
            value={llm.baseUrl}
            onChange={(v) => setLlm((p) => ({ ...p, baseUrl: v }))}
            placeholder="e.g. https://api.fuelix.ai"
          />
          <SecretField
            label="API Key"
            value={llm.apiKey}
            onChange={(v) => setLlm((p) => ({ ...p, apiKey: v }))}
            isConfigured={llmApiKeySet}
          />
        </Section>

        {/* ── Embedding Model ── */}
        <Section
          title="Embedding Model"
          status={embStatus}
          error={embError}
          onSave={() => {
            const payload: Record<string, unknown> = {};
            if (embedding.model) payload.model = embedding.model;
            if (embedding.baseUrl) payload.baseUrl = embedding.baseUrl;
            if (embedding.apiKey) payload.apiKey = embedding.apiKey;
            payload.maxChunks = embedding.maxChunks;
            void patchSection("embedding", payload, setEmbStatus, setEmbError);
          }}
        >
          <Field
            label="Embedding Model"
            value={embedding.model}
            onChange={(v) => setEmbedding((p) => ({ ...p, model: v }))}
            placeholder="e.g. text-embedding-ada-002"
          />
          <Field
            label="Base URL"
            value={embedding.baseUrl}
            onChange={(v) => setEmbedding((p) => ({ ...p, baseUrl: v }))}
            placeholder="e.g. https://api.fuelix.ai"
          />
          <SecretField
            label="API Key"
            value={embedding.apiKey}
            onChange={(v) => setEmbedding((p) => ({ ...p, apiKey: v }))}
            isConfigured={embApiKeySet}
          />
          <div style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontSize: "0.8rem", fontWeight: 600, marginBottom: "4px", color: "#6b7280" }}>
              Max Chunks per Embedding Call
            </label>
            <input
              type="number"
              min={1}
              max={32}
              value={embedding.maxChunks}
              onChange={(e) => setEmbedding((p) => ({ ...p, maxChunks: Number(e.target.value) }))}
              style={{
                width: "120px",
                padding: "7px 10px",
                border: "1px solid #d1d5db",
                borderRadius: "6px",
                fontSize: "0.88rem",
                fontFamily: "monospace",
                background: "#fff"
              }}
            />
            <p style={{ fontSize: "0.78rem", color: "#6b7280", marginTop: "4px" }}>
              Chunks batched per embedding API call (default 16, max 32). To apply a new value: save here, then set EMBEDDING_MAX_CHUNKS=&lt;value&gt; in .env and restart dify-worker.
            </p>
          </div>
          <p style={{ fontSize: "0.8rem", color: "#b45309", background: "#fef3c7", padding: "8px 12px", borderRadius: "6px", margin: "8px 0 0" }}>
            Changing the embedding model invalidates all existing vectors — re-index all knowledge bases after saving.
          </p>
        </Section>

        {/* ── Reranker ── */}
        <Section
          title="Reranker"
          status={rerankerStatus}
          error={rerankerError}
          onSave={() => {
            void patchSection(
              "reranker",
              {
                provider: reranker.provider,
                model: reranker.model,
                apiBase: reranker.apiBase,
                ...(reranker.apiKey ? { apiKey: reranker.apiKey } : {}),
                enabled: reranker.enabled
              },
              setRerankerStatus,
              setRerankerError
            );
          }}
        >
          <div style={{ marginBottom: "12px", display: "flex", alignItems: "center", gap: "16px" }}>
            <span style={{ fontSize: "0.8rem", fontWeight: 600, color: "#6b7280" }}>Enabled</span>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
              <input type="radio" name="reranker-enabled" checked={reranker.enabled} onChange={() => setReranker((p) => ({ ...p, enabled: true }))} />
              <span style={{ fontSize: "0.88rem" }}>Yes</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: "6px", cursor: "pointer" }}>
              <input type="radio" name="reranker-enabled" checked={!reranker.enabled} onChange={() => setReranker((p) => ({ ...p, enabled: false }))} />
              <span style={{ fontSize: "0.88rem" }}>No</span>
            </label>
          </div>
          <Field label="Provider" value={reranker.provider} onChange={(v) => setReranker((p) => ({ ...p, provider: v }))} placeholder="e.g. xinference" />
          <Field label="Model" value={reranker.model} onChange={(v) => setReranker((p) => ({ ...p, model: v }))} placeholder="e.g. BAAI/bge-reranker-v2-m3" />
          <Field label="API Base" value={reranker.apiBase} onChange={(v) => setReranker((p) => ({ ...p, apiBase: v }))} placeholder="e.g. http://xinference:9997" />
          <SecretField
            label="API Key"
            value={reranker.apiKey}
            onChange={(v) => setReranker((p) => ({ ...p, apiKey: v }))}
            isConfigured={rerankerApiKeySet}
            optional
          />
        </Section>

        {/* ── n8n Workflow IDs — read-only ── */}
        <Section title="n8n Workflow IDs" readOnly>
          <p style={{ fontSize: "0.8rem", color: "#6b7280", marginBottom: "12px" }}>
            Workflow IDs are set during platform setup and managed in code. Contact an operator to change them.
          </p>
          <ReadOnlyRow label="GitHub Sync" value={workflows.github} />
          <ReadOnlyRow label="GitLab Sync" value={workflows.gitlab} />
          <ReadOnlyRow label="Google Drive Sync" value={workflows.googledrive} />
          <ReadOnlyRow label="Web Sync" value={workflows.web} />
        </Section>

        {/* ── Dify Console ── */}
        <Section
          title="Dify Console"
          status={consoleStatus}
          error={consoleError}
          onSave={() => {
            const payload: Record<string, unknown> = {};
            if (console_.appUrl) payload.appUrl = console_.appUrl;
            if (console_.email) payload.email = console_.email;
            if (console_.password) payload.password = console_.password;
            void patchSection("console", payload, setConsoleStatus, setConsoleError);
          }}
        >
          <Field label="Dify App URL" value={console_.appUrl} onChange={(v) => setConsole((p) => ({ ...p, appUrl: v }))} placeholder="http://dify-api:5001" />
          <Field label="Console Email" value={console_.email} onChange={(v) => setConsole((p) => ({ ...p, email: v }))} placeholder="operations-ai@automation-platform.local" />
          <SecretField
            label="Console Password"
            value={console_.password}
            onChange={(v) => setConsole((p) => ({ ...p, password: v }))}
            isConfigured={consolePasswordSet}
          />
        </Section>

      </div>
    </div>
  );
}
