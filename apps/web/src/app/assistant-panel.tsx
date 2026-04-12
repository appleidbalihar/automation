"use client";

import { useState } from "react";
import type { ReactElement } from "react";
import { Panel } from "@platform/ui-kit";
import { resolveApiBase } from "./api-base";

const TOKEN_STORAGE_KEY = "ops_bearer_token";

interface ChatResponse {
  answer: string;
  refs?: string[];
}

function authHeader(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const raw = window.localStorage.getItem(TOKEN_STORAGE_KEY) ?? "";
  const token = raw.trim().replace(/^Bearer\s+/i, "");
  return token ? `Bearer ${token}` : undefined;
}

export function AssistantPanel(): ReactElement {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [status, setStatus] = useState("");

  async function ask(): Promise<void> {
    const prompt = query.trim();
    if (!prompt) return;
    setStatus("Querying assistant...");

    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const auth = authHeader();
      if (auth) {
        headers.authorization = auth;
      }
      const response = await fetch(`${resolveApiBase()}/chat/query`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: prompt, context: {} })
      });
      if (!response.ok) {
        throw new Error(`Request failed: ${response.status}`);
      }
      const payload = (await response.json()) as ChatResponse;
      setAnswer(payload.answer);
      setStatus("Completed");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Assistant query failed");
    }
  }

  return (
    <Panel title="Operational Assistant">
      <p>Ask operational questions about orders, workflow usage, and troubleshooting.</p>
      <div className="builder-top-row">
        <label htmlFor="assistant-query">Question</label>
        <input
          id="assistant-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Example: why is order X pending approval?"
        />
        <button type="button" onClick={() => void ask()}>
          Ask
        </button>
      </div>
      <p className="ops-status-line">Status: {status || "-"}</p>
      <section className="card">
        <h4 style={{ marginTop: 0 }}>Response</h4>
        <p style={{ marginBottom: 0 }}>{answer || "No response yet."}</p>
      </section>
    </Panel>
  );
}
