import { authHeaderFromStoredToken } from "../auth-client";
import { resolveApiBase } from "../api-base";
import type { PromptTemplate, TemplateCategory, TemplateFormState } from "./types";

async function requestJson<T>(path: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
  const authorization = authHeaderFromStoredToken();
  const response = await fetch(`${resolveApiBase()}${path}`, {
    method,
    headers: {
      ...(authorization ? { authorization } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string; details?: string };
  if (!response.ok) throw new Error(payload.details ?? payload.error ?? `Request failed ${response.status}`);
  return payload as T;
}

export async function listTemplates(): Promise<PromptTemplate[]> {
  return requestJson<PromptTemplate[]>("/rag/prompt-templates", "GET");
}

export async function getTemplate(id: string): Promise<PromptTemplate> {
  return requestJson<PromptTemplate>(`/rag/prompt-templates/${id}`, "GET");
}

export async function createTemplate(form: TemplateFormState): Promise<PromptTemplate> {
  return requestJson<PromptTemplate>("/rag/prompt-templates", "POST", form);
}

export async function updateTemplate(id: string, form: Partial<TemplateFormState>): Promise<PromptTemplate> {
  return requestJson<PromptTemplate>(`/rag/prompt-templates/${id}`, "PATCH", form);
}

export async function deleteTemplate(id: string): Promise<void> {
  await requestJson<unknown>(`/rag/prompt-templates/${id}`, "DELETE");
}

export async function duplicateTemplate(id: string): Promise<PromptTemplate> {
  return requestJson<PromptTemplate>(`/rag/prompt-templates/${id}/duplicate`, "POST");
}

export async function shareTemplate(id: string, scope: "all" | "specific", userIds?: string[]): Promise<void> {
  await requestJson<unknown>(`/rag/prompt-templates/${id}/share`, "POST", { scope, userIds });
}

export async function revokeShare(templateId: string, userId: string): Promise<void> {
  await requestJson<unknown>(`/rag/prompt-templates/${templateId}/share/${userId}`, "DELETE");
}

export async function generateTemplatePrompt(opts: {
  description?: string;
  category: TemplateCategory;
  templateName?: string;
}): Promise<{ suggestion: string; mode: string; category: string }> {
  return requestJson("/rag/prompt-templates/generate", "POST", opts);
}

export async function applyTemplateToKb(kbId: string, templateId: string): Promise<{ applied: boolean; templateId: string; templateName?: string; difyPromptUpdated: boolean }> {
  return requestJson(`/rag/knowledge-bases/${kbId}/apply-template`, "POST", { templateId });
}
