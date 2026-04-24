import { loadConfig } from "@platform/config";
import { logInfo } from "@platform/observability";
import type {
  RagDiscussionSendMessageResponse,
  RagDiscussionSummary,
  RagDiscussionThread
} from "@platform/contracts";
import { prisma } from "@platform/db";
import { createTlsRuntime, tlsFetch } from "@platform/tls-runtime";
import Fastify from "fastify";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  buildRagThreadExpiry,
  deriveRagThreadTitle,
  extractFlowiseText,
  mapRagDiscussionMessage,
  mapRagDiscussionSummary,
  mapRagDiscussionThread
} from "./rag-chat.js";

const config = loadConfig("workflow-service", 4001);
const tlsRuntime = createTlsRuntime({
  serviceName: config.serviceName,
  enabled: config.mtlsRequired,
  certPath: config.tlsCertPath,
  keyPath: config.tlsKeyPath,
  caPath: config.tlsCaPath,
  requestCert: true,
  rejectUnauthorized: true,
  verifyPeer: config.tlsVerifyPeer,
  serverName: config.tlsServerName,
  reloadDebounceMs: config.tlsReloadDebounceMs,
  diagnosticsToken: config.securityDiagnosticsToken
});
const app = Fastify({ logger: false, https: tlsRuntime.getServerOptions() } as any);

const VAULT_KV_MOUNT = String(process.env.VAULT_KV_MOUNT ?? "secret").trim() || "secret";
const DEFAULT_WORKFLOW_IDS: Record<string, string> = {
  github: "rag-sync-github",
  gitlab: "rag-sync-gitlab",
  googledrive: "rag-sync-gdrive",
  web: "rag-sync-web",
  upload: ""
};

function requesterUserId(headers: Record<string, unknown>): string {
  return String(headers["x-user-id"] ?? "").trim() || "unknown";
}

function requesterRoles(headers: Record<string, unknown>): string[] {
  return String(headers["x-user-roles"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAdmin(headers: Record<string, unknown>): boolean {
  return requesterRoles(headers).includes("admin");
}

function requireAdmin(headers: Record<string, unknown>): { allowed: boolean; error?: { error: string } } {
  if (!isAdmin(headers)) return { allowed: false, error: { error: "FORBIDDEN_ADMIN_ONLY" } };
  return { allowed: true };
}

function secretLogicalPath(input: { scope: string; username?: string; group?: string }): string {
  const group = String(input.group ?? "default").trim().replace(/[^a-zA-Z0-9/_-]/g, "_");
  if (input.scope === "global") return `platform/global/${group}`;
  const username = String(input.username ?? "").trim();
  if (!username) throw new Error("USERNAME_REQUIRED_FOR_USER_SCOPE");
  return `platform/users/${username}/${group}`;
}

function sanitizeLogicalPath(path: string): string {
  const normalized = String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized.startsWith("platform/")) throw new Error("SECRET_PATH_MUST_START_WITH_PLATFORM");
  return normalized;
}

function secretDataPath(logicalPath: string): string {
  return `${VAULT_KV_MOUNT}/data/${logicalPath}`;
}

function secretMetadataPath(logicalPath: string): string {
  return `${VAULT_KV_MOUNT}/metadata/${logicalPath}`;
}

function userSourceSecretPath(userId: string, kbId: string): string {
  return `platform/users/${userId}/sources/${kbId}`;
}

function userRagConfigPath(userId: string): string {
  return `platform/users/${userId}/rag/config`;
}

async function vaultCall(method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
  return fetch(new URL(`/v1/${path}`, process.env.VAULT_ADDR ?? "http://vault:8200"), {
    method,
    headers: {
      "content-type": "application/json",
      ...(process.env.VAULT_NAMESPACE ? { "X-Vault-Namespace": process.env.VAULT_NAMESPACE } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

async function readVaultKv(logicalPath: string): Promise<Record<string, unknown>> {
  const response = await vaultCall("GET", secretDataPath(logicalPath));
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`VAULT_SECRET_NOT_FOUND:${logicalPath}`);
  const payload = (await response.json()) as { data?: { data?: Record<string, unknown> } };
  return payload.data?.data ?? {};
}

async function writeVaultKv(logicalPath: string, data: Record<string, unknown>): Promise<void> {
  const response = await vaultCall("POST", secretDataPath(logicalPath), { data });
  if (!response.ok) throw new Error(`VAULT_WRITE_FAILED:${logicalPath}`);
}

async function readVaultKvMetadata(logicalPath: string): Promise<{ version: number; updatedAt: string | null }> {
  const response = await vaultCall("GET", secretMetadataPath(logicalPath));
  if (!response.ok) return { version: 0, updatedAt: null };
  const payload = (await response.json()) as { data?: { current_version?: number; updated_time?: string } };
  return {
    version: payload.data?.current_version ?? 0,
    updatedAt: payload.data?.updated_time ?? null
  };
}

async function listVaultChildren(prefix: string): Promise<string[]> {
  const response = await vaultCall("GET", `${VAULT_KV_MOUNT}/metadata/${prefix}?list=true`);
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`VAULT_LIST_FAILED:${prefix}`);
  const payload = (await response.json()) as { data?: { keys?: string[] } };
  return payload.data?.keys ?? [];
}

async function listVaultLeafPaths(prefix: string): Promise<string[]> {
  const children = await listVaultChildren(prefix);
  const leaves: string[] = [];
  for (const child of children) {
    const next = `${prefix}/${child}`.replace(/\/+/g, "/");
    if (child.endsWith("/")) {
      leaves.push(...(await listVaultLeafPaths(next.replace(/\/+$/, ""))));
    } else {
      leaves.push(next);
    }
  }
  return leaves;
}

function nonEmptyString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : undefined;
}

function normalizeAccessToken(value: unknown): string | undefined {
  let token = String(value ?? "").trim();
  token = token.replace(/^Bearer\s+/i, "");
  token = token.replace(/^PRIVATE-TOKEN\s*[:=]\s*/i, "");
  token = token.replace(/^token\s*[:=]\s*/i, "");
  token = token.replace(/^["']|["']$/g, "").trim();
  return token || undefined;
}

function buildSourceSecretPayload(
  sourceType: string,
  credentials: Record<string, unknown> | undefined
): Record<string, string> {
  const payload: Record<string, string> = {};
  if (!credentials) return payload;
  if (sourceType === "github") {
    const token = normalizeAccessToken(credentials.githubToken);
    if (token) payload.github_token = token;
  } else if (sourceType === "gitlab") {
    const token = normalizeAccessToken(credentials.gitlabToken);
    if (token) payload.gitlab_token = token;
  } else if (sourceType === "googledrive") {
    const token = normalizeAccessToken(credentials.googleDriveAccessToken);
    const refresh = normalizeAccessToken(credentials.googleDriveRefreshToken);
    if (token) payload.gdrive_token = token;
    if (refresh) payload.gdrive_refresh = refresh;
  }
  return payload;
}

function sourceCredentialConfigured(sourceType: string, secrets: Record<string, unknown>): boolean {
  // GitHub/GitLab tokens are optional because public repositories can sync
  // without user credentials. Private sources still pass tokens to n8n when set.
  if (sourceType === "github" || sourceType === "gitlab") return true;
  if (sourceType === "googledrive") {
    return Boolean(nonEmptyString(secrets.gdrive_token) || nonEmptyString(secrets.gdrive_refresh));
  }
  return true;
}

function normalizeSourceType(sourceType: string, sourceUrl?: string): string {
  const requested = sourceType === "gdrive" ? "googledrive" : sourceType;
  const url = String(sourceUrl ?? "").toLowerCase();
  if (url.includes("gitlab.")) return "gitlab";
  if (url.includes("github.")) return "github";
  if (url.includes("drive.google.") || url.includes("docs.google.")) return "googledrive";
  return requested;
}

function supportedDocumentPath(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase();
  return Boolean(ext && ["md", "txt", "rst", "mdx"].includes(ext));
}

function sourceAccessError(sourceType: string, status: number, details: string): string {
  const suffix = details ? ` Provider response: ${details.slice(0, 240)}` : "";
  if (status === 401 || status === 403 || status === 404) {
    return `${sourceType} source is not accessible from the sync worker. If this is a private repository, add a personal access token with read repository permission and sync again.${suffix}`;
  }
  return `${sourceType} source preflight failed with HTTP ${status}.${suffix}`;
}

async function preflightGitHubSource(input: {
  sourceUrl: string;
  sourceBranch: string;
  sourcePath: string;
  token?: string;
}): Promise<number> {
  const match = input.sourceUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!match) throw new Error("Invalid GitHub repository URL");
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, "");
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(input.sourceBranch)}?recursive=1`,
    {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "platform-rag-sync/1.0",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {})
      }
    }
  );
  if (!response.ok) {
    throw new Error(sourceAccessError("GitHub", response.status, await response.text().catch(() => "")));
  }
  const payload = (await response.json()) as { tree?: Array<{ path?: string; type?: string }> };
  const basePath = input.sourcePath.replace(/^\/+|\/+$/g, "");
  return (payload.tree ?? []).filter((item) => {
    const path = String(item.path ?? "");
    return item.type === "blob" && supportedDocumentPath(path) && (!basePath || path.startsWith(basePath));
  }).length;
}

async function preflightGitLabSource(input: {
  sourceUrl: string;
  sourceBranch: string;
  sourcePath: string;
  token?: string;
}): Promise<number> {
  const match = input.sourceUrl.match(/gitlab\.com\/([^?#]+?)(?:\/-\/.*)?$/i);
  if (!match) throw new Error("Invalid GitLab repository URL");
  const projectPath = match[1].replace(/\.git$/i, "").replace(/\/+$/g, "");
  const encodedProjectPath = encodeURIComponent(projectPath);
  const basePath = input.sourcePath.replace(/^\/+|\/+$/g, "");
  let page = 1;
  let total = 0;

  while (page <= 10) {
    const url = new URL(`https://gitlab.com/api/v4/projects/${encodedProjectPath}/repository/tree`);
    url.searchParams.set("ref", input.sourceBranch);
    url.searchParams.set("recursive", "true");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: {
        "user-agent": "platform-rag-sync/1.0",
        ...(input.token ? { "PRIVATE-TOKEN": input.token } : {})
      }
    });
    if (!response.ok) {
      throw new Error(sourceAccessError("GitLab", response.status, await response.text().catch(() => "")));
    }

    const files = (await response.json()) as Array<{ path?: string; type?: string }>;
    total += files.filter((item) => {
      const path = String(item.path ?? "");
      return item.type === "blob" && supportedDocumentPath(path) && (!basePath || path.startsWith(basePath));
    }).length;

    const nextPage = response.headers.get("x-next-page");
    if (!nextPage) break;
    page = Number(nextPage);
    if (!Number.isFinite(page) || page <= 0) break;
  }

  return total;
}

async function preflightSourceDocumentCount(
  kb: {
    sourceType: string | null;
    sourceUrl: string | null;
    sourceBranch: string | null;
    sourcePath: string | null;
  },
  sourceSecrets: Record<string, unknown>
): Promise<number | null> {
  const sourceType = normalizeSourceType(String(kb.sourceType ?? ""), String(kb.sourceUrl ?? ""));
  const sourceUrl = nonEmptyString(kb.sourceUrl);
  if (!sourceUrl) return null;
  const sourceBranch = nonEmptyString(kb.sourceBranch) ?? "main";
  const sourcePath = String(kb.sourcePath ?? "").trim();

  if (sourceType === "github") {
    return preflightGitHubSource({
      sourceUrl,
      sourceBranch,
      sourcePath,
      token: nonEmptyString(sourceSecrets.github_token)
    });
  }
  if (sourceType === "gitlab") {
    return preflightGitLabSource({
      sourceUrl,
      sourceBranch,
      sourcePath,
      token: nonEmptyString(sourceSecrets.gitlab_token)
    });
  }

  return null;
}

async function readUserRagConfig(userId: string): Promise<Record<string, unknown>> {
  return readVaultKv(userRagConfigPath(userId));
}

async function setUserDefaultKnowledgeBase(userId: string, knowledgeBaseId: string): Promise<void> {
  const existing = await readUserRagConfig(userId);
  await writeVaultKv(userRagConfigPath(userId), {
    ...existing,
    default_kb_id: knowledgeBaseId
  });
}

async function clearUserDefaultKnowledgeBaseIfMatches(userId: string, knowledgeBaseId: string): Promise<void> {
  const existing = await readUserRagConfig(userId);
  if (String(existing.default_kb_id ?? "").trim() !== knowledgeBaseId) return;
  const next = { ...existing };
  delete next.default_kb_id;
  await writeVaultKv(userRagConfigPath(userId), next);
}

async function deleteVaultSecret(logicalPath: string): Promise<void> {
  await vaultCall("DELETE", secretMetadataPath(logicalPath)).catch(() => undefined);
}

async function readGlobalDifyProvisioningDefaults(sourceType: string): Promise<{
  difyAppUrl: string;
  defaultApiKey?: string;
  workflowId: string;
}> {
  const configSecret = await readVaultKv("platform/global/dify/config");
  const normalizedType = sourceType === "gdrive" ? "googledrive" : sourceType;
  const workflowId =
    nonEmptyString(configSecret[`${normalizedType}_workflow_id`]) ??
    DEFAULT_WORKFLOW_IDS[normalizedType] ??
    "";
  return {
    difyAppUrl: nonEmptyString(configSecret.default_app_url) ?? config.difyApiBaseUrl,
    defaultApiKey: nonEmptyString(configSecret.default_api_key),
    workflowId
  };
}

type DifyProvisioningConfig = {
  difyAppUrl: string;
  consoleEmail: string;
  consoleName: string;
  consolePassword: string;
  initPassword?: string;
  modelProvider: string;
  modelApiKey?: string;
  modelApiBase?: string;
  chatModel: string;
  embeddingModel: string;
  workflowId: string;
};

type DifyConsoleSession = {
  baseUrl: string;
  token: string;
  config: DifyProvisioningConfig;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function ragSyncProgressCallbackBaseUrl(): string {
  const explicit = String(process.env.RAG_SYNC_PROGRESS_CALLBACK_BASE_URL ?? "").trim();
  if (explicit) return trimTrailingSlash(explicit);
  return "https://api-gateway:4000";
}

function truncateDifyName(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 40) return normalized;
  return normalized.slice(0, 37).trimEnd() + "...";
}

function buildDifyResourceName(name: string, kbId: string): string {
  const suffix = kbId.slice(-8);
  const base = name.trim() || "Operations AI KB";
  const maxBaseLength = Math.max(1, 40 - suffix.length - 3);
  return `${base.slice(0, maxBaseLength).trimEnd()} - ${suffix}`;
}

function generateDifyPassword(): string {
  return `Dify-${randomBytes(18).toString("base64url")}1a!`;
}

async function readDifyProvisioningConfig(sourceType: string): Promise<DifyProvisioningConfig> {
  const configSecret = await readVaultKv("platform/global/dify/config");
  const defaults = await readGlobalDifyProvisioningDefaults(sourceType);
  const difyAppUrl = nonEmptyString(configSecret.default_app_url) ?? defaults.difyAppUrl;
  const consoleEmail = nonEmptyString(configSecret.console_email) ?? "operations-ai@automation-platform.local";
  const consoleName = nonEmptyString(configSecret.console_name) ?? "Automation Platform";
  let consolePassword = nonEmptyString(configSecret.console_password);

  if (!consolePassword) {
    consolePassword = generateDifyPassword();
    await writeVaultKv("platform/global/dify/config", {
      ...configSecret,
      default_app_url: difyAppUrl,
      console_email: consoleEmail,
      console_name: consoleName,
      console_password: consolePassword,
      model_provider: nonEmptyString(configSecret.model_provider) ?? "openai",
      chat_model: nonEmptyString(configSecret.chat_model) ?? "gpt-4o-mini",
      embedding_model: nonEmptyString(configSecret.embedding_model) ?? "text-embedding-3-small"
    });
  }

  return {
    difyAppUrl,
    consoleEmail,
    consoleName,
    consolePassword,
    initPassword: nonEmptyString(configSecret.init_password),
    modelProvider: nonEmptyString(configSecret.model_provider) ?? "openai",
    modelApiKey: nonEmptyString(configSecret.model_api_key),
    modelApiBase: nonEmptyString(configSecret.model_api_base),
    chatModel: nonEmptyString(configSecret.chat_model) ?? "gpt-4o-mini",
    embeddingModel: nonEmptyString(configSecret.embedding_model) ?? "text-embedding-3-small",
    workflowId: defaults.workflowId
  };
}

async function difyConsoleFetch(
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
    cookie?: string;
    ok?: number[];
  } = {}
): Promise<{ response: Response; payload: Record<string, any>; cookie?: string }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.cookie ? { cookie: options.cookie } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, any> : {};
  const expected = options.ok ?? [200, 201];
  if (!expected.includes(response.status)) {
    const message = typeof payload.message === "string" ? payload.message : text;
    throw new Error(`DIFY_CONSOLE_REQUEST_FAILED:${path}:${response.status}:${message}`);
  }
  return {
    response,
    payload,
    cookie: response.headers.get("set-cookie")?.split(";")[0]
  };
}

async function ensureDifyConsoleSession(sourceType: string): Promise<DifyConsoleSession> {
  const provisioningConfig = await readDifyProvisioningConfig(sourceType);
  if (!provisioningConfig.modelApiKey) {
    throw new Error("DIFY_MODEL_PROVIDER_KEY_NOT_CONFIGURED");
  }

  const baseUrl = `${trimTrailingSlash(provisioningConfig.difyAppUrl)}/console/api`;
  const setupStatus = await difyConsoleFetch(baseUrl, "/setup");

  if (setupStatus.payload.step !== "finished") {
    let setupCookie = "";
    if (provisioningConfig.initPassword) {
      const init = await difyConsoleFetch(baseUrl, "/init", {
        method: "POST",
        body: { password: provisioningConfig.initPassword }
      });
      setupCookie = init.cookie ?? "";
    }

    await difyConsoleFetch(baseUrl, "/setup", {
      method: "POST",
      cookie: setupCookie || undefined,
      body: {
        email: provisioningConfig.consoleEmail,
        name: provisioningConfig.consoleName,
        password: provisioningConfig.consolePassword
      },
      ok: [201]
    });
  }

  const login = await difyConsoleFetch(baseUrl, "/login", {
    method: "POST",
    body: {
      email: provisioningConfig.consoleEmail,
      password: provisioningConfig.consolePassword,
      remember_me: false
    }
  });
  const token = nonEmptyString(login.payload.data);
  if (!token) throw new Error("DIFY_CONSOLE_LOGIN_TOKEN_MISSING");

  const modelCredentials = {
    openai_api_key: provisioningConfig.modelApiKey,
    ...(provisioningConfig.modelApiBase ? { openai_api_base: provisioningConfig.modelApiBase } : {})
  };

  try {
    await difyConsoleFetch(baseUrl, `/workspaces/current/model-providers/${provisioningConfig.modelProvider}`, {
      method: "POST",
      token,
      body: { credentials: modelCredentials },
      ok: [201]
    });
  } catch (error) {
    // Some OpenAI-compatible gateways authorize only selected models. Dify's
    // provider-level validation probes a default model, so fall back to explicit
    // per-model credentials for the chat and embedding models we actually use.
    await difyConsoleFetch(baseUrl, `/workspaces/current/model-providers/${provisioningConfig.modelProvider}/models`, {
      method: "POST",
      token,
      body: {
        model: provisioningConfig.chatModel,
        model_type: "llm",
        credentials: modelCredentials
      }
    });
    await difyConsoleFetch(baseUrl, `/workspaces/current/model-providers/${provisioningConfig.modelProvider}/models`, {
      method: "POST",
      token,
      body: {
        model: provisioningConfig.embeddingModel,
        model_type: "text-embedding",
        credentials: modelCredentials
      }
    });
  }

  await difyConsoleFetch(
    baseUrl,
    `/workspaces/current/model-providers/${provisioningConfig.modelProvider}/preferred-provider-type`,
    {
      method: "POST",
      token,
      body: { preferred_provider_type: "custom" }
    }
  );

  await difyConsoleFetch(baseUrl, "/workspaces/current/default-model", {
    method: "POST",
    token,
    body: {
      model_settings: [
        {
          model_type: "llm",
          provider: provisioningConfig.modelProvider,
          model: provisioningConfig.chatModel
        },
        {
          model_type: "text-embedding",
          provider: provisioningConfig.modelProvider,
          model: provisioningConfig.embeddingModel
        }
      ]
    }
  });

  return { baseUrl, token, config: provisioningConfig };
}

async function createDifyDataset(session: DifyConsoleSession, name: string): Promise<string> {
  const created = await difyConsoleFetch(session.baseUrl, "/datasets", {
    method: "POST",
    token: session.token,
    body: {
      name: truncateDifyName(name),
      indexing_technique: "high_quality"
    },
    ok: [201]
  });
  const datasetId = nonEmptyString(created.payload.id);
  if (!datasetId) throw new Error("DIFY_DATASET_ID_MISSING");
  return datasetId;
}

async function createDifyApp(session: DifyConsoleSession, name: string, description?: string | null): Promise<string> {
  const created = await difyConsoleFetch(session.baseUrl, "/apps", {
    method: "POST",
    token: session.token,
    body: {
      name: truncateDifyName(name),
      description: description ?? "",
      mode: "chat",
      icon: "🤖",
      icon_background: "#D1E9FF"
    },
    ok: [201]
  });
  const appId = nonEmptyString(created.payload.id);
  if (!appId) throw new Error("DIFY_APP_ID_MISSING");
  return appId;
}

async function configureDifyApp(session: DifyConsoleSession, appId: string, datasetId: string): Promise<void> {
  await difyConsoleFetch(session.baseUrl, `/apps/${appId}/model-config`, {
    method: "POST",
    token: session.token,
    body: {
      model: {
        provider: session.config.modelProvider,
        name: session.config.chatModel,
        mode: "chat",
        completion_params: {
          temperature: 0.2,
          top_p: 1,
          presence_penalty: 0,
          frequency_penalty: 0,
          max_tokens: 2048,
          stop: []
        }
      },
      prompt_type: "simple",
      pre_prompt:
        "You are Operations AI. Answer using the connected knowledge source when it is relevant. " +
        "If the answer is not present in the user's configured documents, say what is missing and suggest the next operational step.",
      dataset_configs: {
        retrieval_model: "single",
        datasets: {
          strategy: "router",
          datasets: [
            {
              dataset: {
                enabled: true,
                id: datasetId
              }
            }
          ]
        }
      },
      retriever_resource: { enabled: true },
      suggested_questions: [],
      suggested_questions_after_answer: { enabled: false },
      speech_to_text: { enabled: false },
      text_to_speech: { enabled: false, language: "", voice: "" },
      user_input_form: [],
      opening_statement: "",
      more_like_this: { enabled: false },
      sensitive_word_avoidance: { enabled: false, type: "", configs: [] }
    }
  });
}

async function createDifyAppApiKey(session: DifyConsoleSession, appId: string): Promise<string> {
  const created = await difyConsoleFetch(session.baseUrl, `/apps/${appId}/api-keys`, {
    method: "POST",
    token: session.token,
    ok: [201]
  });
  const apiKey = nonEmptyString(created.payload.token);
  if (!apiKey) throw new Error("DIFY_APP_API_KEY_MISSING");
  return apiKey;
}

async function createDifyDatasetApiKey(session: DifyConsoleSession): Promise<string> {
  // Dify 0.6.x validates dataset service API keys by tenant/type, not by
  // dataset_id. Its per-dataset console route exists but raises a 500 because
  // ApiToken has no dataset_id column in this version.
  const created = await difyConsoleFetch(session.baseUrl, "/datasets/api-keys", {
    method: "POST",
    token: session.token,
    ok: [200, 201]
  });
  const apiKey = nonEmptyString(created.payload.token);
  if (!apiKey) throw new Error("DIFY_DATASET_API_KEY_MISSING");
  return apiKey;
}

async function deleteDifyResourceIfPresent(
  session: DifyConsoleSession,
  path: string,
  expectedStatuses: number[] = [204]
): Promise<void> {
  try {
    await difyConsoleFetch(session.baseUrl, path, {
      method: "DELETE",
      token: session.token,
      ok: [...expectedStatuses, 404]
    });
  } catch (error) {
    throw new Error(`DIFY_DELETE_FAILED:${path}:${error instanceof Error ? error.message : String(error)}`);
  }
}

async function deleteDifyKnowledgeBaseResources(kb: {
  id: string;
  sourceType?: string | null;
  difyDatasetId?: string | null;
}): Promise<void> {
  const existingSecrets = await readVaultKv(`platform/global/dify/${kb.id}`);
  const sourceType = String(kb.sourceType ?? "github");
  const session = await ensureDifyConsoleSession(sourceType);
  const appId = nonEmptyString(existingSecrets.app_id);
  const datasetId = nonEmptyString(kb.difyDatasetId) ?? nonEmptyString(existingSecrets.dataset_id);
  if (appId) {
    await deleteDifyResourceIfPresent(session, `/apps/${appId}`);
  }
  if (datasetId) {
    await deleteDifyResourceIfPresent(session, `/datasets/${datasetId}`);
  }
}

async function ensureDifyKnowledgeBaseProvisioned(kbId: string): Promise<void> {
  const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");

  const sourceType = String(kb.sourceType ?? "github");
  const existingSecrets = await readVaultKv(`platform/global/dify/${kbId}`);
  const defaults = await readGlobalDifyProvisioningDefaults(sourceType);
  const session = await ensureDifyConsoleSession(sourceType);

  let datasetId = nonEmptyString(kb.difyDatasetId) ?? nonEmptyString(existingSecrets.dataset_id);
  if (!datasetId) {
    datasetId = await createDifyDataset(session, buildDifyResourceName(kb.name, kbId));
    await (prisma as any).ragKnowledgeBase.update({
      where: { id: kbId },
      data: { difyDatasetId: datasetId, difyAppUrl: session.config.difyAppUrl }
    });
  }

  let appId = nonEmptyString(existingSecrets.app_id);
  if (!appId) {
    appId = await createDifyApp(session, buildDifyResourceName(kb.name, kbId), kb.description);
  }

  await configureDifyApp(session, appId, datasetId);

  const legacyApiKey = nonEmptyString(existingSecrets.api_key);
  const appApiKey =
    nonEmptyString(existingSecrets.app_api_key) ??
    (legacyApiKey?.startsWith("app-") ? legacyApiKey : undefined) ??
    await createDifyAppApiKey(session, appId);
  const datasetApiKey =
    nonEmptyString(existingSecrets.dataset_api_key) ??
    (legacyApiKey?.startsWith("ds-") || legacyApiKey?.startsWith("dataset-") ? legacyApiKey : undefined) ??
    await createDifyDatasetApiKey(session);
  await writeVaultKv(`platform/global/dify/${kbId}`, {
    ...existingSecrets,
    api_key: appApiKey,
    app_api_key: appApiKey,
    dataset_api_key: datasetApiKey,
    app_id: appId,
    dataset_id: datasetId,
    n8n_workflow_id: nonEmptyString(existingSecrets.n8n_workflow_id) ?? defaults.workflowId
  });
}

async function pruneExpiredRagDiscussions(): Promise<void> {
  await prisma.ragDiscussionThread.deleteMany({
    where: {
      expiresAt: {
        lt: new Date()
      }
    }
  });
}

async function getOwnedRagDiscussion(threadId: string, ownerId: string) {
  return prisma.ragDiscussionThread.findFirst({
    where: {
      id: threadId,
      ownerId
    }
  });
}

async function listRagDiscussionSummaries(ownerId: string): Promise<RagDiscussionSummary[]> {
  await pruneExpiredRagDiscussions();
  const threads = await prisma.ragDiscussionThread.findMany({
    where: { ownerId },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1
      }
    },
    orderBy: { lastMessageAt: "desc" }
  });
  return threads.map((thread) => mapRagDiscussionSummary(thread, thread.messages[0]?.content));
}

async function resolveVisibleKnowledgeBaseForDiscussion(
  ownerId: string,
  headers: Record<string, unknown>,
  requestedKnowledgeBaseId?: string
): Promise<{ id: string } | null> {
  const privileged = isAdminOrUserAdmin(headers);
  const where = requestedKnowledgeBaseId
    ? privileged
      ? { id: requestedKnowledgeBaseId }
      : {
          id: requestedKnowledgeBaseId,
          OR: [{ scope: "global" }, { ownerId }]
        }
    : privileged
      ? {}
      : {
          OR: [{ scope: "global" }, { ownerId }]
        };

  if (requestedKnowledgeBaseId) {
    return prisma.ragKnowledgeBase.findFirst({
      where,
      select: { id: true }
    });
  }

  const userConfig = await readUserRagConfig(ownerId);
  const userDefaultId = nonEmptyString(userConfig.default_kb_id);
  if (userDefaultId) {
    const preferred = await prisma.ragKnowledgeBase.findFirst({
      where: privileged
        ? { id: userDefaultId }
        : {
            id: userDefaultId,
            OR: [{ scope: "global" }, { ownerId }]
          },
      select: { id: true }
    });
    if (preferred) return preferred;
  }

  const visible = await prisma.ragKnowledgeBase.findMany({
    where,
    select: { id: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
    take: 1
  });
  return visible[0] ?? null;
}

async function getRagDiscussionThread(threadId: string, ownerId: string): Promise<RagDiscussionThread | null> {
  await pruneExpiredRagDiscussions();
  const thread = await prisma.ragDiscussionThread.findFirst({
    where: { id: threadId, ownerId },
    include: {
      messages: {
        orderBy: { createdAt: "asc" }
      }
    }
  });
  if (!thread) return null;
  return mapRagDiscussionThread(thread, thread.messages);
}

async function createRagDiscussion(
  ownerId: string,
  headers: Record<string, unknown>,
  knowledgeBaseId?: string
): Promise<RagDiscussionSummary> {
  await pruneExpiredRagDiscussions();
  const resolvedKnowledgeBase = await resolveVisibleKnowledgeBaseForDiscussion(ownerId, headers, knowledgeBaseId);
  if (!resolvedKnowledgeBase) {
    if (knowledgeBaseId) {
      throw new Error("KNOWLEDGE_BASE_NOT_VISIBLE");
    }
    throw new Error("OPERATIONS_AI_NOT_CONFIGURED");
  }
  const now = new Date();
  const thread = await prisma.ragDiscussionThread.create({
    data: {
      ownerId,
      title: "New discussion",
      flowiseSessionId: `rag-${randomUUID()}`,
      knowledgeBaseId: resolvedKnowledgeBase.id,
      lastMessageAt: now,
      expiresAt: buildRagThreadExpiry(now)
    }
  });
  return mapRagDiscussionSummary(thread);
}

async function sendToFlowise(content: string, sessionId: string): Promise<string> {
  const response = await fetch(config.flowiseOperationsChatUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.flowiseApiKey ? { authorization: `Bearer ${config.flowiseApiKey}` } : {})
    },
    body: JSON.stringify({ question: content, overrideConfig: { sessionId } })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FLOWISE_REQUEST_FAILED:${response.status}:${text}`);
  }
  return extractFlowiseText(await response.json());
}

/**
 * Calls Dify chat-messages API for a given knowledge base.
 * The API key is fetched from Vault at runtime — it is never stored in env vars.
 * Vault path: platform/global/dify/{kbId} → app_api_key
 * Returns the answer text and Dify's conversation_id for session continuity.
 */
async function sendToDify(
  content: string,
  difyConversationId: string | null,
  kbId: string,
  difyAppUrl: string,
  userId: string
): Promise<{ answer: string; conversationId: string }> {
  // Fetch the Dify API key from Vault — never from env vars
  const secrets = await readVaultKv(`platform/global/dify/${kbId}`);
  const apiKey = String(secrets.app_api_key ?? secrets.api_key ?? "").trim();
  if (!apiKey) throw new Error(`DIFY_API_KEY_NOT_CONFIGURED:${kbId}`);

  const response = await fetch(`${difyAppUrl}/v1/chat-messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      inputs: {},
      query: content,
      response_mode: "blocking",
      // Pass empty string for first message; Dify creates a new conversation
      conversation_id: difyConversationId ?? "",
      user: userId
    })
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DIFY_REQUEST_FAILED:${response.status}:${text}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const answer = typeof payload.answer === "string" && payload.answer.trim()
    ? payload.answer
    : (() => { throw new Error("DIFY_EMPTY_RESPONSE"); })();
  const conversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : "";
  return { answer, conversationId };
}

/**
 * Sends a message to the appropriate RAG backend based on whether the thread
 * has a knowledge base (Dify) or is a legacy Flowise thread.
 * This dual-routing ensures backward compatibility with existing threads.
 */
async function appendRagDiscussionMessage(threadId: string, ownerId: string, content: string): Promise<RagDiscussionSendMessageResponse | null> {
  await pruneExpiredRagDiscussions();

  // Fetch thread with its optional knowledge base relation
  const thread = await prisma.ragDiscussionThread.findFirst({
    where: { id: threadId, ownerId },
    include: { knowledgeBase: true }
  });
  if (!thread) return null;

  const trimmed = content.trim();
  if (!trimmed) throw new Error("MESSAGE_CONTENT_REQUIRED");

  const now = new Date();
  const existingMessageCount = await prisma.ragDiscussionMessage.count({ where: { threadId } });

  let assistantReply: string;
  let newDifyConversationId: string | null = thread.difyConversationId ?? null;

  if (thread.knowledgeBaseId && thread.knowledgeBase) {
    // ── Dify path: thread is linked to a knowledge base ──
    const result = await sendToDify(
      trimmed,
      thread.difyConversationId ?? null,
      thread.knowledgeBaseId,
      thread.knowledgeBase.difyAppUrl,
      ownerId
    );
    assistantReply = result.answer;
    newDifyConversationId = result.conversationId || newDifyConversationId;
  } else {
    // ── Flowise path: legacy thread with no knowledge base ──
    assistantReply = await sendToFlowise(trimmed, thread.flowiseSessionId);
  }

  const persisted = await prisma.$transaction(async (tx) => {
    const userMessage = await tx.ragDiscussionMessage.create({
      data: { threadId, role: "user", content: trimmed }
    });
    const assistantMessage = await tx.ragDiscussionMessage.create({
      data: { threadId, role: "assistant", content: assistantReply }
    });
    const updatedThread = await tx.ragDiscussionThread.update({
      where: { id: threadId },
      data: {
        title: existingMessageCount === 0 ? deriveRagThreadTitle(trimmed) : thread.title,
        lastMessageAt: now,
        expiresAt: buildRagThreadExpiry(now),
        // Persist updated Dify conversation_id for session continuity
        ...(newDifyConversationId !== thread.difyConversationId
          ? { difyConversationId: newDifyConversationId }
          : {})
      }
    });
    return { userMessage, assistantMessage, updatedThread };
  });

  return {
    thread: mapRagDiscussionSummary(persisted.updatedThread, persisted.assistantMessage.content),
    userMessage: mapRagDiscussionMessage(persisted.userMessage),
    assistantMessage: mapRagDiscussionMessage(persisted.assistantMessage)
  };
}

// ─── Knowledge Base helpers ───────────────────────────────────────────────────

function isAdminOrUserAdmin(headers: Record<string, unknown>): boolean {
  const roles = requesterRoles(headers);
  return roles.includes("admin") || roles.includes("useradmin");
}

async function buildIntegrationResponse(
  kb: Record<string, any>,
  viewerUserId: string
): Promise<Record<string, unknown>> {
  const ownerId = String(kb.ownerId ?? viewerUserId).trim() || viewerUserId;
  const [sourceSecrets, difySecrets, userConfig] = await Promise.all([
    readVaultKv(userSourceSecretPath(ownerId, kb.id)),
    readVaultKv(`platform/global/dify/${kb.id}`),
    readUserRagConfig(ownerId)
  ]);
  const workflowId =
    nonEmptyString(difySecrets.n8n_workflow_id) ??
    (await readGlobalDifyProvisioningDefaults(String(kb.sourceType ?? "github"))).workflowId;
  const credentialConfigured = sourceCredentialConfigured(String(kb.sourceType ?? "github"), sourceSecrets);
  const chatReady = Boolean(nonEmptyString(difySecrets.app_api_key) ?? nonEmptyString(difySecrets.api_key));
  const syncProvisioned = chatReady && Boolean(nonEmptyString(difySecrets.dataset_api_key)) && Boolean(nonEmptyString(kb.difyDatasetId));
  const syncReady =
    credentialConfigured &&
    syncProvisioned &&
    Boolean(workflowId || String(kb.sourceType ?? "") === "web" || String(kb.sourceType ?? "") === "upload");

  const authMethod = nonEmptyString(sourceSecrets.auth_method) ?? (
    // Infer from existing token fields for KBs created before this feature
    nonEmptyString(sourceSecrets.github_token) || nonEmptyString(sourceSecrets.gitlab_token) ||
    nonEmptyString(sourceSecrets.gdrive_token) ? "pat" : null
  );

  const oauthAppConfigured = !!nonEmptyString(sourceSecrets.oauth_client_id);

  return {
    id: kb.id,
    name: kb.name,
    description: kb.description ?? null,
    sourceType: kb.sourceType,
    sourceUrl: kb.sourceUrl,
    sourceBranch: kb.sourceBranch ?? null,
    sourcePath: kb.sourcePath ?? null,
    syncSchedule: kb.syncSchedule ?? null,
    ownerId: kb.ownerId ?? null,
    createdAt: kb.createdAt instanceof Date ? kb.createdAt.toISOString() : kb.createdAt,
    updatedAt: kb.updatedAt instanceof Date ? kb.updatedAt.toISOString() : kb.updatedAt,
    credentialConfigured,
    chatReady,
    syncReady,
    workflowAssigned: Boolean(workflowId),
    isDefault: String(userConfig.default_kb_id ?? "").trim() === kb.id,
    latestSyncJob: Array.isArray(kb.syncJobs) ? kb.syncJobs[0] ?? null : null,
    config: kb.config ?? null,
    authMethod,
    oauthAppConfigured
  };
}

async function getVisibleKnowledgeBases(userId: string, isPrivileged: boolean) {
  // Users see platform-wide KBs + their own KBs
  // Admins/useradmins see all KBs
  if (isPrivileged) {
    return prisma.ragKnowledgeBase.findMany({
      include: { config: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { createdAt: "desc" }
    });
  }
  return prisma.ragKnowledgeBase.findMany({
    where: {
      OR: [
        { scope: "global" },
        { ownerId: userId }
      ]
    },
    include: { config: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 1 } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
  });
}

/**
 * Triggers a document sync for a knowledge base via n8n webhook.
 * The n8n workflow ID is stored in Vault at platform/global/dify/{kbId} → n8n_workflow_id.
 * Progress is tracked in RagKbSyncJob and updated by n8n webhook callbacks.
 */
async function triggerKbSync(kbId: string, triggeredById: string, trigger: string): Promise<string> {
  let kb = await prisma.ragKnowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");

  try {
    await ensureDifyKnowledgeBaseProvisioned(kbId);
    kb = await prisma.ragKnowledgeBase.findUnique({ where: { id: kbId } });
    if (!kb) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");
  } catch (error) {
    const syncJob = await prisma.ragKbSyncJob.create({
      data: {
        knowledgeBaseId: kbId,
        trigger,
        triggeredById,
        status: "failed",
        startedAt: new Date(),
        completedAt: new Date(),
        errorMessage: `Dify provisioning failed: ${error instanceof Error ? error.message : String(error)}`
      }
    });
    return syncJob.id;
  }

  // Read n8n workflow ID from Vault
  const [difySecrets, sourceSecrets] = await Promise.all([
    readVaultKv(`platform/global/dify/${kbId}`),
    readVaultKv(userSourceSecretPath(String(kb.ownerId ?? triggeredById).trim() || triggeredById, kbId))
  ]);
  const n8nWorkflowId = String(difySecrets.n8n_workflow_id ?? "").trim();
  const difyApiKey = String(difySecrets.dataset_api_key ?? "").trim();
  const difyDatasetId = String(kb.difyDatasetId ?? "").trim();
  const sourceType = String(kb.sourceType ?? "").trim();
  const workflowOptional = sourceType === "web" || sourceType === "upload";

  // Prevent near-simultaneous duplicate syncs for the same knowledge base.
  // Older stale jobs are ignored so a previously wedged run does not block a new sync forever.
  const duplicateWindowStart = new Date(Date.now() - 10 * 60 * 1000);
  const existingActiveJob = await prisma.ragKbSyncJob.findFirst({
    where: {
      knowledgeBaseId: kbId,
      status: { in: ["pending", "running"] },
      createdAt: { gte: duplicateWindowStart }
    },
    orderBy: { createdAt: "desc" }
  });
  if (existingActiveJob) {
    return existingActiveJob.id;
  }

  const missingRequirements: string[] = [];
  if (!workflowOptional && !n8nWorkflowId) missingRequirements.push("n8n workflow");
  if (!workflowOptional && !config.n8nWebhookToken) missingRequirements.push("n8n callback token");
  if (!difyApiKey) missingRequirements.push("Dify dataset API key");
  if (!difyDatasetId) missingRequirements.push("Dify dataset");

  if (missingRequirements.length > 0) {
    const syncJob = await prisma.ragKbSyncJob.create({
      data: {
        knowledgeBaseId: kbId,
        trigger,
        triggeredById,
        status: "failed",
        startedAt: new Date(),
        completedAt: new Date(),
        n8nWebhookUrl: n8nWorkflowId ? `${config.n8nApiBaseUrl}/webhook/${n8nWorkflowId}` : null,
        errorMessage: `Sync prerequisites missing: ${missingRequirements.join(", ")}`
      }
    });
    return syncJob.id;
  }

  let filesTotal: number | null = null;
  try {
    filesTotal = await preflightSourceDocumentCount(
      {
        sourceType: kb.sourceType,
        sourceUrl: kb.sourceUrl,
        sourceBranch: kb.sourceBranch,
        sourcePath: kb.sourcePath
      },
      sourceSecrets
    );
  } catch (error) {
    const syncJob = await prisma.ragKbSyncJob.create({
      data: {
        knowledgeBaseId: kbId,
        trigger,
        triggeredById,
        status: "failed",
        startedAt: new Date(),
        completedAt: new Date(),
        n8nWebhookUrl: n8nWorkflowId ? `${config.n8nApiBaseUrl}/webhook/${n8nWorkflowId}` : null,
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    });
    return syncJob.id;
  }

  if (filesTotal === 0) {
    const syncJob = await prisma.ragKbSyncJob.create({
      data: {
        knowledgeBaseId: kbId,
        trigger,
        triggeredById,
        status: "completed",
        startedAt: new Date(),
        completedAt: new Date(),
        filesTotal: 0,
        filesProcessed: 0,
        n8nWebhookUrl: n8nWorkflowId ? `${config.n8nApiBaseUrl}/webhook/${n8nWorkflowId}` : null,
        errorMessage: "No supported documents found in the configured source path"
      }
    });
    return syncJob.id;
  }

  // Create a sync job record for progress tracking
  const syncJob = await prisma.ragKbSyncJob.create({
    data: {
      knowledgeBaseId: kbId,
      trigger,
      triggeredById,
      status: "running",
      startedAt: new Date(),
      filesTotal,
      n8nWebhookUrl: n8nWorkflowId
        ? `${config.n8nApiBaseUrl}/webhook/${n8nWorkflowId}`
        : null
    }
  });

  // Refresh OAuth token if it is close to expiry (within 5 minutes)
  const effectiveSourceSecrets = { ...sourceSecrets };
  if (String(sourceSecrets.auth_method ?? "") === "oauth") {
    const expiry = nonEmptyString(sourceSecrets.token_expiry);
    if (expiry) {
      const expiresAt = new Date(expiry).getTime();
      const nowPlusFive = Date.now() + 5 * 60 * 1000;
      if (expiresAt < nowPlusFive) {
        const refreshToken = nonEmptyString(sourceSecrets.gitlab_refresh) ?? nonEmptyString(sourceSecrets.gdrive_refresh);
        const sourceTypeStr = String(kb.sourceType ?? "");
        const refreshUrl = sourceTypeStr === "gitlab" ? "https://gitlab.com/oauth/token" : "https://oauth2.googleapis.com/token";
        const clientIdKey = sourceTypeStr === "gitlab" ? "GITLAB_CLIENT_ID" : "GOOGLE_CLIENT_ID";
        const clientSecretKey = sourceTypeStr === "gitlab" ? "GITLAB_CLIENT_SECRET" : "GOOGLE_CLIENT_SECRET";
        const clientId = String(process.env[clientIdKey] ?? "").trim();
        const clientSecret = String(process.env[clientSecretKey] ?? "").trim();
        if (refreshToken && clientId && clientSecret) {
          try {
            const refreshRes = await fetch(refreshUrl, {
              method: "POST",
              headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
              body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }).toString()
            });
            const refreshPayload = (await refreshRes.json()) as Record<string, unknown>;
            const newToken = String(refreshPayload.access_token ?? "").trim();
            const newExpiry = Number(refreshPayload.expires_in ?? 0);
            if (newToken) {
              const newTokenExpiry = newExpiry > 0 ? new Date(Date.now() + newExpiry * 1000).toISOString() : undefined;
              const ownerId = String(kb.ownerId ?? triggeredById).trim() || triggeredById;
              const updatedSecrets: Record<string, string> = {
                ...Object.fromEntries(Object.entries(sourceSecrets).map(([k, v]) => [k, String(v)])),
                ...(sourceTypeStr === "gitlab" ? { gitlab_token: newToken } : { gdrive_token: newToken }),
                ...(newTokenExpiry ? { token_expiry: newTokenExpiry } : {})
              };
              await writeVaultKv(userSourceSecretPath(ownerId, kbId), updatedSecrets).catch((e) =>
                logInfo("OAuth token refresh Vault write failed", { service: "workflow-service", kbId, error: e instanceof Error ? e.message : String(e) })
              );
              if (sourceTypeStr === "gitlab") effectiveSourceSecrets.gitlab_token = newToken;
              else effectiveSourceSecrets.gdrive_token = newToken;
            }
          } catch (err) {
            logInfo("OAuth token refresh failed — using existing token", { service: "workflow-service", kbId, error: err instanceof Error ? err.message : String(err) });
          }
        } else if (!refreshToken) {
          // No refresh token and token is expired — fail the sync with a clear message
          await prisma.ragKbSyncJob.update({
            where: { id: syncJob.id },
            data: { status: "failed", completedAt: new Date(), errorMessage: "OAuth access token expired. Please reconnect the integration." }
          });
          return syncJob.id;
        }
      }
    }
  }

  // If n8n workflow is configured, trigger it via webhook and capture execution ID
  if (n8nWorkflowId) {
    const progressCallbackUrl = `${ragSyncProgressCallbackBaseUrl()}/rag/knowledge-bases/${kbId}/sync-progress`;
    const webhookUrl = `${config.n8nApiBaseUrl}/webhook/${n8nWorkflowId}`;
    void fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kbId,
        syncJobId: syncJob.id,
        sourceUrl: kb.sourceUrl,
        sourceBranch: kb.sourceBranch,
        sourcePath: kb.sourcePath,
        sourceType: kb.sourceType,
        difyDatasetId,
        difyApiUrl: kb.difyAppUrl,
        difyApiKey,
        sourceToken:
          String(effectiveSourceSecrets.github_token ?? effectiveSourceSecrets.gitlab_token ?? effectiveSourceSecrets.gdrive_token ?? "").trim() || undefined,
        sourceRefreshToken: String(effectiveSourceSecrets.gdrive_refresh ?? "").trim() || undefined,
        progressCallbackToken: config.n8nWebhookToken || undefined,
        progressCallbackUrl
      })
    })
      .then(async (response) => {
        if (!response.ok) {
          const details = (await response.text().catch(() => "")).trim();
          await (prisma as any).ragKbSyncJob.update({
            where: { id: syncJob.id },
            data: {
              status: "failed",
              errorMessage: details ? `n8n webhook returned ${response.status}: ${details}` : `n8n webhook returned ${response.status}`,
              completedAt: new Date()
            }
          }).catch(() => undefined);
          return;
        }
        // Capture n8n execution ID from webhook response (n8n returns executionId in body)
        try {
          const responseBody = await response.json() as Record<string, unknown>;
          const executionId = String(responseBody.executionId ?? responseBody.id ?? "").trim();
          if (executionId) {
            await (prisma as any).ragKbSyncJob.update({
              where: { id: syncJob.id },
              data: { n8nExecutionId: executionId }
            }).catch(() => undefined);
          }
        } catch {
          // Response body may not have executionId — not critical
        }
      })
      .catch(() => {
        (prisma as any).ragKbSyncJob.update({
          where: { id: syncJob.id },
          data: { status: "failed", errorMessage: "n8n webhook unreachable", completedAt: new Date() }
        }).catch(() => undefined);
      });
  } else {
    // No n8n workflow configured — mark as pending for manual processing
    await (prisma as any).ragKbSyncJob.update({
      where: { id: syncJob.id },
      data: { status: "pending", errorMessage: "No n8n workflow configured for this knowledge base" }
    });
  }

  return syncJob.id;
}

app.get("/health", async () => ({ ok: true, service: config.serviceName }));

app.get("/security/tls", async (request, reply) => {
  const token = String(request.headers["x-security-token"] ?? "");
  if (tlsRuntime.diagnosticsToken && token !== tlsRuntime.diagnosticsToken) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
  return tlsRuntime.getStatus();
});

// ─── Knowledge Base API Routes ────────────────────────────────────────────────

app.get("/rag/integrations", async (request) => {
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const ownedKbs = await prisma.ragKnowledgeBase.findMany({
    where: { ownerId: userId },
    include: {
      config: true,
      syncJobs: {
        orderBy: { createdAt: "desc" },
        take: 1
      }
    },
    orderBy: { createdAt: "desc" }
  });
  return Promise.all(ownedKbs.map((kb) => buildIntegrationResponse(kb, userId)));
});

app.post("/rag/integrations", async (request, reply) => {
  const headers = request.headers as Record<string, unknown>;
  const userId = requesterUserId(headers);
  const body = (request.body ?? {}) as {
    name?: string;
    description?: string;
    sourceType?: string;
    sourceUrl?: string;
    sourceBranch?: string;
    sourcePath?: string;
    syncSchedule?: string;
    setDefault?: boolean;
    credentials?: Record<string, unknown>;
    responseStyle?: string;
    toneInstructions?: string;
    restrictionRules?: string;
  };

  const name = nonEmptyString(body.name);
  const sourceUrl = nonEmptyString(body.sourceUrl);
  const sourceType = normalizeSourceType(nonEmptyString(body.sourceType) ?? "github", sourceUrl);
  if (!name) return reply.code(400).send({ error: "INTEGRATION_NAME_REQUIRED" });
  if (!sourceUrl) return reply.code(400).send({ error: "INTEGRATION_SOURCE_URL_REQUIRED" });

  const sourceSecrets = buildSourceSecretPayload(sourceType, body.credentials);
  const defaults = await readGlobalDifyProvisioningDefaults(sourceType);

  try {
    const kb = await (prisma as any).ragKnowledgeBase.create({
      data: {
        name,
        description: body.description ?? null,
        sourceType,
        sourceUrl,
        sourceBranch: body.sourceBranch ?? null,
        sourcePath: body.sourcePath ?? null,
        syncSchedule: body.syncSchedule ?? null,
        difyAppUrl: defaults.difyAppUrl,
        scope: "user",
        ownerId: userId,
        isDefault: false,
        createdById: userId
      },
      include: {
        config: true,
        syncJobs: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });

    if (Object.keys(sourceSecrets).length > 0) {
      await writeVaultKv(userSourceSecretPath(userId, kb.id), sourceSecrets);
    }

    await writeVaultKv(`platform/global/dify/${kb.id}`, {
      ...(defaults.defaultApiKey ? { api_key: defaults.defaultApiKey } : {}),
      n8n_workflow_id: defaults.workflowId
    });

    if (body.responseStyle || body.toneInstructions || body.restrictionRules) {
      await (prisma as any).ragKnowledgeBaseConfig.create({
        data: {
          knowledgeBaseId: kb.id,
          responseStyle: body.responseStyle ?? null,
          toneInstructions: body.toneInstructions ?? null,
          restrictionRules: body.restrictionRules ?? null
        }
      });
    }

    const existingDefault = await readUserRagConfig(userId);
    if (body.setDefault || !nonEmptyString(existingDefault.default_kb_id)) {
      await setUserDefaultKnowledgeBase(userId, kb.id);
    }

    try {
      await ensureDifyKnowledgeBaseProvisioned(kb.id);
    } catch (error) {
      await (prisma as any).ragKbSyncJob.create({
        data: {
          knowledgeBaseId: kb.id,
          trigger: "provision",
          triggeredById: userId,
          status: "failed",
          startedAt: new Date(),
          completedAt: new Date(),
          errorMessage: `Dify provisioning failed: ${error instanceof Error ? error.message : String(error)}`
        }
      });
    }

    const reloaded = await (prisma as any).ragKnowledgeBase.findUnique({
      where: { id: kb.id },
      include: {
        config: true,
        syncJobs: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });
    return reply.code(201).send(await buildIntegrationResponse(reloaded, userId));
  } catch (error) {
    return reply.code(500).send({
      error: "INTEGRATION_CREATE_FAILED",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.patch("/rag/integrations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const body = (request.body ?? {}) as {
    name?: string;
    description?: string;
    sourceUrl?: string;
    sourceBranch?: string;
    sourcePath?: string;
    syncSchedule?: string;
    setDefault?: boolean;
    credentials?: Record<string, unknown>;
    responseStyle?: string;
    toneInstructions?: string;
    restrictionRules?: string;
  };

  const existingKb = await (prisma as any).ragKnowledgeBase.findFirst({
    where: { id, ownerId: userId },
    include: {
      config: true,
      syncJobs: { orderBy: { createdAt: "desc" }, take: 1 }
    }
  });
  if (!existingKb) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });

  try {
    const updatedKb = await (prisma as any).ragKnowledgeBase.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description || null } : {}),
        ...(body.sourceUrl !== undefined ? { sourceUrl: body.sourceUrl } : {}),
        ...(body.sourceBranch !== undefined ? { sourceBranch: body.sourceBranch || null } : {}),
        ...(body.sourcePath !== undefined ? { sourcePath: body.sourcePath || null } : {}),
        ...(body.syncSchedule !== undefined ? { syncSchedule: body.syncSchedule || null } : {})
      },
      include: {
        config: true,
        syncJobs: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });

    if (body.credentials) {
      const mergedSecrets = {
        ...(await readVaultKv(userSourceSecretPath(userId, id)))
      } as Record<string, unknown>;
      const allowedMappings: Array<[string, string]> = [
        ["githubToken", "github_token"],
        ["gitlabToken", "gitlab_token"],
        ["googleDriveAccessToken", "gdrive_token"],
        ["googleDriveRefreshToken", "gdrive_refresh"]
      ];
      for (const [bodyKey, vaultKey] of allowedMappings) {
        if (!(bodyKey in body.credentials)) continue;
        const nextValue = normalizeAccessToken(body.credentials[bodyKey]);
        if (nextValue) {
          mergedSecrets[vaultKey] = nextValue;
        } else {
          delete mergedSecrets[vaultKey];
        }
      }
      const normalizedType = normalizeSourceType(String(updatedKb.sourceType ?? ""), String(updatedKb.sourceUrl ?? ""));
      const hasSourceTokenUpdate =
        ("githubToken" in body.credentials && normalizedType === "github") ||
        ("gitlabToken" in body.credentials && normalizedType === "gitlab");
      if (hasSourceTokenUpdate) {
        try {
          await preflightSourceDocumentCount(
            {
              sourceType: String(updatedKb.sourceType ?? ""),
              sourceUrl: String(updatedKb.sourceUrl ?? ""),
              sourceBranch: String(updatedKb.sourceBranch ?? ""),
              sourcePath: String(updatedKb.sourcePath ?? "")
            },
            mergedSecrets
          );
        } catch (error) {
          return reply.code(400).send({
            error: "SOURCE_TOKEN_VALIDATION_FAILED",
            details: error instanceof Error ? error.message : String(error)
          });
        }
      }
      if (Object.keys(mergedSecrets).length > 0) {
        await writeVaultKv(userSourceSecretPath(userId, id), mergedSecrets);
      } else {
        await deleteVaultSecret(userSourceSecretPath(userId, id));
      }
    }

    if (body.responseStyle !== undefined || body.toneInstructions !== undefined || body.restrictionRules !== undefined) {
      await (prisma as any).ragKnowledgeBaseConfig.upsert({
        where: { knowledgeBaseId: id },
        create: {
          knowledgeBaseId: id,
          responseStyle: body.responseStyle ?? null,
          toneInstructions: body.toneInstructions ?? null,
          restrictionRules: body.restrictionRules ?? null
        },
        update: {
          ...(body.responseStyle !== undefined ? { responseStyle: body.responseStyle || null } : {}),
          ...(body.toneInstructions !== undefined ? { toneInstructions: body.toneInstructions || null } : {}),
          ...(body.restrictionRules !== undefined ? { restrictionRules: body.restrictionRules || null } : {})
        }
      });
    }

    if (body.setDefault) {
      await setUserDefaultKnowledgeBase(userId, id);
    }

    const reloaded = await (prisma as any).ragKnowledgeBase.findUnique({
      where: { id },
      include: {
        config: true,
        syncJobs: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });
    return await buildIntegrationResponse(reloaded, userId);
  } catch (error) {
    return reply.code(500).send({
      error: "INTEGRATION_UPDATE_FAILED",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

app.post("/rag/integrations/:id/set-default", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const kb = await (prisma as any).ragKnowledgeBase.findFirst({
    where: { id, ownerId: userId }
  });
  if (!kb) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  await setUserDefaultKnowledgeBase(userId, id);
  return { defaultKnowledgeBaseId: id };
});

app.delete("/rag/integrations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const kb = await (prisma as any).ragKnowledgeBase.findFirst({
    where: { id, ownerId: userId }
  });
  if (!kb) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });

  try {
    await deleteDifyKnowledgeBaseResources(kb);
    await (prisma as any).ragKnowledgeBase.delete({ where: { id } });
    await deleteVaultSecret(userSourceSecretPath(userId, id));
    await deleteVaultSecret(`platform/global/dify/${id}`);
    await clearUserDefaultKnowledgeBaseIfMatches(userId, id);

    const nextKb = await (prisma as any).ragKnowledgeBase.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: "desc" }
    });
    if (nextKb) {
      const config = await readUserRagConfig(userId);
      if (!nonEmptyString(config.default_kb_id)) {
        await setUserDefaultKnowledgeBase(userId, nextKb.id);
      }
    }

    return { deleted: true, id, difyCleanup: true };
  } catch (error) {
    return reply.code(500).send({
      error: "INTEGRATION_DELETE_FAILED",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// List knowledge bases visible to the requesting user
app.get("/rag/knowledge-bases", async (request) => {
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const privileged = isAdminOrUserAdmin(request.headers as Record<string, unknown>);
  return getVisibleKnowledgeBases(userId, privileged);
});

// Create a new knowledge base (admin/useradmin only). Dify app/dataset/API-key
// provisioning is automatic and secrets are stored in Vault, never in the DB.
app.post("/rag/knowledge-bases", async (request, reply) => {
  const headers = request.headers as Record<string, unknown>;
  if (!isAdminOrUserAdmin(headers)) return reply.code(403).send({ error: "FORBIDDEN" });
  const userId = requesterUserId(headers);
  const body = (request.body ?? {}) as {
    name?: string;
    description?: string;
    sourceType?: string;
    sourceUrl?: string;
    sourceBranch?: string;
    sourcePath?: string;
    syncSchedule?: string;
    difyAppUrl?: string;
    difyApiKey?: string;
    n8nWorkflowId?: string;
    isDefault?: boolean;
    scope?: string;
    responseStyle?: string;
    toneInstructions?: string;
    restrictionRules?: string;
    systemPromptBase?: string;
    llmModel?: string;
    temperature?: number;
    topK?: number;
  };
  const name = String(body.name ?? "").trim();
  const sourceUrl = String(body.sourceUrl ?? "").trim();
  const sourceType = normalizeSourceType(String(body.sourceType ?? "github").trim(), sourceUrl);
  const difyApiKey = String(body.difyApiKey ?? "").trim();
  if (!name) return reply.code(400).send({ error: "KB_NAME_REQUIRED" });
  if (!sourceUrl) return reply.code(400).send({ error: "KB_SOURCE_URL_REQUIRED" });

  try {
    const defaults = await readGlobalDifyProvisioningDefaults(sourceType);
    // 1. Create the DB record (no API key stored here)
    const kb = await (prisma as any).$transaction(async (tx: typeof prisma) => {
      if (body.isDefault) {
        await (tx as any).ragKnowledgeBase.updateMany({
          where: { isDefault: true },
          data: { isDefault: false }
        });
      }

      return (tx as any).ragKnowledgeBase.create({
        data: {
          name,
          description: body.description ?? null,
          sourceType,
          sourceUrl,
          sourceBranch: body.sourceBranch ?? null,
          sourcePath: body.sourcePath ?? null,
          syncSchedule: body.syncSchedule ?? null,
          difyAppUrl: body.difyAppUrl ?? defaults.difyAppUrl,
          scope: body.scope ?? "global",
          ownerId: body.scope === "user" ? userId : null,
          isDefault: body.isDefault ?? false,
          createdById: userId
        }
      });
    });

    // 2. Store workflow metadata and optional legacy Dify key in Vault.
    await writeVaultKv(`platform/global/dify/${kb.id}`, {
      ...(difyApiKey ? { api_key: difyApiKey } : {}),
      n8n_workflow_id: String(body.n8nWorkflowId ?? defaults.workflowId).trim()
    });

    // 3. Create default config if any config fields provided
    if (body.systemPromptBase || body.llmModel || body.responseStyle || body.toneInstructions) {
      await (prisma as any).ragKnowledgeBaseConfig.create({
        data: {
          knowledgeBaseId: kb.id,
          systemPromptBase: body.systemPromptBase ?? null,
          llmModel: body.llmModel ?? null,
          temperature: body.temperature ?? null,
          topK: body.topK ?? null,
          responseStyle: body.responseStyle ?? null,
          toneInstructions: body.toneInstructions ?? null,
          restrictionRules: body.restrictionRules ?? null
        }
      });
    }

    try {
      await ensureDifyKnowledgeBaseProvisioned(kb.id);
    } catch (error) {
      await (prisma as any).ragKbSyncJob.create({
        data: {
          knowledgeBaseId: kb.id,
          trigger: "provision",
          triggeredById: userId,
          status: "failed",
          startedAt: new Date(),
          completedAt: new Date(),
          errorMessage: `Dify provisioning failed: ${error instanceof Error ? error.message : String(error)}`
        }
      });
    }

    const reloaded = await (prisma as any).ragKnowledgeBase.findUnique({
      where: { id: kb.id },
      include: { config: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 1 } }
    });
    return reply.code(201).send(await buildIntegrationResponse(reloaded, userId));
  } catch (error) {
    return reply.code(500).send({ error: "KB_CREATE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

// Get a single knowledge base
app.get("/rag/knowledge-bases/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const privileged = isAdminOrUserAdmin(request.headers as Record<string, unknown>);
  const kb = await (prisma as any).ragKnowledgeBase.findFirst({
    where: privileged ? { id } : { id, OR: [{ scope: "global" }, { ownerId: userId }] },
    include: { config: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 5 } }
  });
  if (!kb) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });
  return kb;
});

// Update KB config (tone, style, restrictions) — available to all users for their own KB
app.patch("/rag/knowledge-bases/:id/config", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const body = (request.body ?? {}) as Record<string, unknown>;
  try {
    const updated = await (prisma as any).ragKnowledgeBaseConfig.upsert({
      where: { knowledgeBaseId: id },
      create: { knowledgeBaseId: id, ...body },
      update: body
    });
    return updated;
  } catch (error) {
    return reply.code(400).send({ error: "KB_CONFIG_UPDATE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

// Delete a knowledge base (admin/useradmin only) — also removes Vault secrets
app.delete("/rag/knowledge-bases/:id", async (request, reply) => {
  const headers = request.headers as Record<string, unknown>;
  if (!isAdminOrUserAdmin(headers)) return reply.code(403).send({ error: "FORBIDDEN" });
  const id = (request.params as { id: string }).id;
  try {
    const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id } });
    if (!kb) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });
    await deleteDifyKnowledgeBaseResources(kb);
    await (prisma as any).ragKnowledgeBase.delete({ where: { id } });
    // Remove Vault secret for this KB
    await vaultCall("DELETE", `${VAULT_KV_MOUNT}/metadata/platform/global/dify/${id}`).catch(() => undefined);
    return { deleted: true, id, difyCleanup: true };
  } catch (error) {
    return reply.code(500).send({
      error: "KNOWLEDGE_BASE_DELETE_FAILED",
      details: error instanceof Error ? error.message : String(error)
    });
  }
});

// Set a KB as the platform default (admin only)
app.post("/rag/knowledge-bases/:id/set-default", async (request, reply) => {
  const headers = request.headers as Record<string, unknown>;
  if (!isAdmin(headers)) return reply.code(403).send({ error: "FORBIDDEN_ADMIN_ONLY" });
  const id = (request.params as { id: string }).id;
  await (prisma as any).$transaction([
    (prisma as any).ragKnowledgeBase.updateMany({ where: { isDefault: true }, data: { isDefault: false } }),
    (prisma as any).ragKnowledgeBase.update({ where: { id }, data: { isDefault: true } })
  ]);
  return { defaultKnowledgeBaseId: id };
});

// Trigger a manual sync for a knowledge base
app.post("/rag/knowledge-bases/:id/sync", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  try {
    const syncJobId = await triggerKbSync(id, userId, "manual");
    return reply.code(202).send({ accepted: true, syncJobId, knowledgeBaseId: id });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "KNOWLEDGE_BASE_NOT_FOUND") return reply.code(404).send({ error: msg });
    return reply.code(500).send({ error: "SYNC_TRIGGER_FAILED", details: msg });
  }
});

// Get latest sync status for a knowledge base (polled by UI for progress bar)
app.get("/rag/knowledge-bases/:id/sync-status", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const latestJob = await (prisma as any).ragKbSyncJob.findFirst({
    where: { knowledgeBaseId: id },
    orderBy: { createdAt: "desc" }
  });
  if (!latestJob) return { status: "never_synced", knowledgeBaseId: id };
  return latestJob;
});

// Get sync history for a knowledge base
app.get("/rag/knowledge-bases/:id/sync-history", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const query = request.query as { limit?: string };
  const limit = Math.min(Number(query.limit ?? "20"), 100);
  const jobs = await (prisma as any).ragKbSyncJob.findMany({
    where: { knowledgeBaseId: id },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  return { knowledgeBaseId: id, jobs };
});

app.post("/rag/knowledge-bases/:id/sync-cancel", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const latestJob = await (prisma as any).ragKbSyncJob.findFirst({
    where: {
      knowledgeBaseId: id,
      status: { in: ["pending", "running"] }
    },
    orderBy: { createdAt: "desc" }
  });
  if (!latestJob) return reply.code(404).send({ error: "SYNC_JOB_NOT_FOUND" });

  // Mark job as cancelled in DB first — n8n progress callbacks will see this and stop
  await (prisma as any).ragKbSyncJob.update({
    where: { id: latestJob.id },
    data: {
      status: "cancelled",
      errorMessage: "Sync cancelled by user",
      completedAt: new Date()
    }
  });

  // Stop the running n8n execution via n8n REST API if we have the execution ID and API key
  const n8nExecutionId = String(latestJob.n8nExecutionId ?? "").trim();
  const n8nApiKey = config.n8nApiKey;
  if (n8nExecutionId && n8nApiKey) {
    // n8n REST API: DELETE /api/v1/executions/{id} stops/deletes a running execution
    void fetch(`${config.n8nApiBaseUrl}/api/v1/executions/${n8nExecutionId}`, {
      method: "DELETE",
      headers: {
        "X-N8N-API-KEY": n8nApiKey
      }
    }).catch((error) => {
      console.warn(`[workflow-service] n8n execution stop failed for ${n8nExecutionId}:`, error instanceof Error ? error.message : String(error));
    });
  }

  return { cancelled: true, syncJobId: latestJob.id, knowledgeBaseId: id };
});

// n8n progress callback — called by n8n sync workflows to report progress
// This is an internal endpoint; n8n calls it during sync execution
app.post("/rag/knowledge-bases/:id/sync-progress", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  void id;
  const body = (request.body ?? {}) as {
    syncJobId?: string;
    status?: string;
    filesProcessed?: number;
    filesTotal?: number;
    chunksProcessed?: number;
    errorMessage?: string;
    step?: {
      task: string;
      stepName: string;
      status: string;
      startedAt?: string;
      completedAt?: string;
      message?: string;
      errorMessage?: string;
    };
    logMessage?: string;
    logSeverity?: string;
  };
  if (!body.syncJobId) return reply.code(400).send({ error: "SYNC_JOB_ID_REQUIRED" });
  try {
    const existingJob = await (prisma as any).ragKbSyncJob.findUnique({
      where: { id: body.syncJobId }
    });
    if (!existingJob) return reply.code(404).send({ error: "SYNC_JOB_NOT_FOUND" });
    if (String(existingJob.status ?? "") === "cancelled") {
      return { updated: false, ignored: "SYNC_CANCELLED" };
    }
    if (String(existingJob.status ?? "") === "completed" && body.status !== "completed") {
      return { updated: false, ignored: "SYNC_ALREADY_COMPLETED" };
    }
    const isCompleted = body.status === "completed" || body.status === "failed";
    await (prisma as any).ragKbSyncJob.update({
      where: { id: body.syncJobId },
      data: {
        status: body.status ?? "running",
        filesProcessed: body.filesProcessed ?? undefined,
        filesTotal: body.filesTotal ?? undefined,
        chunksProcessed: body.chunksProcessed ?? undefined,
        errorMessage: body.errorMessage ?? null,
        ...(isCompleted ? { completedAt: new Date() } : {})
      }
    });

    // Upsert step into stepsJson
    if (body.step) {
      const existing = Array.isArray(existingJob.stepsJson)
        ? (existingJob.stepsJson as Record<string, unknown>[])
        : [];
      const idx = existing.findIndex((s) => s["stepName"] === body.step!.stepName);
      if (idx >= 0) existing[idx] = { ...existing[idx], ...body.step };
      else existing.push({ ...body.step });
      await (prisma as any).ragKbSyncJob.update({
        where: { id: body.syncJobId },
        data: { stepsJson: existing }
      });
    }

    // Forward log to logging-service (fire-and-forget)
    if (body.logMessage) {
      tlsFetch(tlsRuntime, new URL("/logs/ingest", config.loggingServiceUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          severity: body.logSeverity ?? "INFO",
          source: "n8n-rag-sync",
          message: body.logMessage,
          syncJobId: body.syncJobId,
          stepName: body.step?.stepName ?? null,
          payload: { filesProcessed: body.filesProcessed, filesTotal: body.filesTotal }
        })
      }).catch(() => {});
    }

    return { updated: true };
  } catch (error) {
    return reply.code(404).send({ error: "SYNC_JOB_NOT_FOUND" });
  }
});

// Channel deployments (Phase 2 stubs — ready for n8n channel integration)
app.get("/rag/channels", async (request) => {
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  return (prisma as any).ragChannelDeployment.findMany({
    where: { ownerId: userId },
    orderBy: { createdAt: "desc" }
  });
});

app.post("/rag/channels", async (request, reply) => {
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const body = (request.body ?? {}) as {
    knowledgeBaseId?: string;
    channelType?: string;
    channelName?: string;
  };
  if (!body.knowledgeBaseId || !body.channelType || !body.channelName) {
    return reply.code(400).send({ error: "CHANNEL_FIELDS_REQUIRED" });
  }
  const deployment = await (prisma as any).ragChannelDeployment.create({
    data: {
      knowledgeBaseId: body.knowledgeBaseId,
      channelType: body.channelType,
      channelName: body.channelName,
      ownerId: userId,
      status: "pending"
    }
  });
  return reply.code(201).send(deployment);
});

app.delete("/rag/channels/:id", async (request, reply) => {
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const id = (request.params as { id: string }).id;
  const deleted = await (prisma as any).ragChannelDeployment.deleteMany({
    where: { id, ownerId: userId }
  });
  if (deleted.count === 0) return reply.code(404).send({ error: "CHANNEL_NOT_FOUND" });
  return { deleted: true };
});

// ─── RAG Discussion Routes ─────────────────────────────────────────────────────

app.get("/rag/discussions", async (request) => {
  return listRagDiscussionSummaries(requesterUserId(request.headers as Record<string, unknown>));
});

app.post("/rag/discussions", async (request, reply) => {
  const { knowledgeBaseId } = (request.body ?? {}) as { knowledgeBaseId?: string };
  try {
    const headers = request.headers as Record<string, unknown>;
    const thread = await createRagDiscussion(
      requesterUserId(headers),
      headers,
      knowledgeBaseId
    );
    return reply.code(201).send(thread);
  } catch (error) {
    const message = error instanceof Error ? error.message : "RAG_DISCUSSION_CREATE_FAILED";
    return reply.code(400).send({ error: message });
  }
});

app.get("/rag/discussions/:id", async (request, reply) => {
  const thread = await getRagDiscussionThread(
    (request.params as { id: string }).id,
    requesterUserId(request.headers as Record<string, unknown>)
  );
  if (!thread) return reply.code(404).send({ error: "RAG_DISCUSSION_NOT_FOUND" });
  return thread;
});

app.post("/rag/discussions/:id/messages", async (request, reply) => {
  const threadId = (request.params as { id: string }).id;
  const { content } = (request.body ?? {}) as { content?: string };
  try {
    const response = await appendRagDiscussionMessage(
      threadId,
      requesterUserId(request.headers as Record<string, unknown>),
      String(content ?? "")
    );
    if (!response) return reply.code(404).send({ error: "RAG_DISCUSSION_NOT_FOUND" });
    return response;
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "RAG_DISCUSSION_SEND_FAILED"
    });
  }
});

app.delete("/rag/discussions/:id", async (request, reply) => {
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const id = (request.params as { id: string }).id;
  const deleted = await prisma.ragDiscussionThread.deleteMany({
    where: {
      id,
      ownerId: requester
    }
  });
  if (deleted.count === 0) return reply.code(404).send({ error: "RAG_DISCUSSION_NOT_FOUND" });
  return { deleted: true };
});

app.get("/admin/secrets", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const query = request.query as { scope?: string; username?: string; group?: string };
  try {
    const logicalPath = secretLogicalPath({
      scope: String(query.scope ?? "global").trim().toLowerCase(),
      username: query.username,
      group: query.group
    });
    const [dataResponse, metadataResponse] = await Promise.all([
      vaultCall("GET", secretDataPath(logicalPath)),
      vaultCall("GET", secretMetadataPath(logicalPath))
    ]);
    const dataPayload = dataResponse.ok ? (((await dataResponse.json()) as { data?: { data?: Record<string, unknown> } }).data?.data ?? {}) : {};
    const metadataPayload = metadataResponse.ok
      ? ((await metadataResponse.json()) as { data?: { current_version?: number; updated_time?: string } })
      : {};
    return {
      scope: String(query.scope ?? "global").trim().toLowerCase(),
      username: query.username ?? null,
      group: query.group ?? "default",
      path: logicalPath,
      secrets: Object.keys(dataPayload).map((key) => ({
        key,
        value: "***",
        version: metadataPayload.data?.current_version ?? 0,
        updatedAt: metadataPayload.data?.updated_time ?? null
      }))
    };
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_SECRET_NOT_FOUND", details: error instanceof Error ? error.message : String(error) });
  }
});

app.get("/admin/secrets/catalog", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const query = request.query as { limit?: string };
  const limit = Math.min(Math.max(Number(query.limit ?? "1000") || 1000, 1), 5000);
  try {
    const [globalPaths, userPaths] = await Promise.all([listVaultLeafPaths("platform/global"), listVaultLeafPaths("platform/users")]);
    const paths = [...new Set([...globalPaths, ...userPaths])].sort().slice(0, limit);
    const items: Array<{
      path: string;
      key: string;
      value: string;
      version: number;
      updatedAt: string | null;
      purpose: string;
      ownerId: string | null;
      resourceType: string;
      resourceId: string | null;
      resourceName: string | null;
    }> = [];

    for (const path of paths) {
      const [data, metadata] = await Promise.all([readVaultKv(path), readVaultKvMetadata(path)]);
      const userMatch = path.match(/^platform\/users\/([^/]+)\//);
      const isGlobal = path.startsWith("platform/global/");
      for (const key of Object.keys(data).sort()) {
        items.push({
          path,
          key,
          value: "***",
          version: metadata.version,
          updatedAt: metadata.updatedAt,
          purpose: isGlobal ? "Global platform secret" : "User platform secret",
          ownerId: userMatch?.[1] ?? null,
          resourceType: isGlobal ? "global" : "user",
          resourceId: null,
          resourceName: null
        });
      }
    }
    return {
      totalPaths: paths.length,
      totalSecrets: items.length,
      items
    };
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_LIST_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/admin/secrets/by-path", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const body = (request.body ?? {}) as { path?: string; key?: string; value?: unknown };
  const path = sanitizeLogicalPath(String(body.path ?? ""));
  const key = String(body.key ?? "").trim();
  if (!key) return reply.code(400).send({ error: "SECRET_KEY_REQUIRED" });
  try {
    const data = await readVaultKv(path);
    data[key] = String(body.value ?? "");
    await writeVaultKv(path, data);
    return reply.code(201).send({ path, key, value: "***", updatedAt: new Date().toISOString() });
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/admin/secrets/by-path", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const body = (request.body ?? {}) as { path?: string; key?: string; value?: unknown };
  const path = sanitizeLogicalPath(String(body.path ?? ""));
  const key = String(body.key ?? "").trim();
  if (!key) return reply.code(400).send({ error: "SECRET_KEY_REQUIRED" });
  try {
    const data = await readVaultKv(path);
    if (!(key in data)) return reply.code(404).send({ error: "VAULT_SECRET_NOT_FOUND", details: key });
    data[key] = String(body.value ?? "");
    await writeVaultKv(path, data);
    return { path, key, value: "***", updatedAt: new Date().toISOString() };
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/admin/secrets/by-path", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const body = (request.body ?? {}) as { path?: string; key?: string };
  const path = sanitizeLogicalPath(String(body.path ?? ""));
  const key = String(body.key ?? "").trim();
  try {
    if (!key) {
      const response = await vaultCall("DELETE", secretMetadataPath(path));
      if (!response.ok && response.status !== 404) return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: path });
      return { deleted: true, path };
    }
    const data = await readVaultKv(path);
    if (!(key in data)) return reply.code(404).send({ error: "VAULT_SECRET_NOT_FOUND", details: key });
    delete data[key];
    await writeVaultKv(path, data);
    return { deleted: true, path, key };
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/admin/secrets", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const body = (request.body ?? {}) as { scope?: string; username?: string; group?: string; key?: string; value?: unknown };
  const key = String(body.key ?? "").trim();
  if (!key) return reply.code(400).send({ error: "SECRET_KEY_REQUIRED" });
  try {
    const logicalPath = secretLogicalPath({
      scope: String(body.scope ?? "global").trim().toLowerCase(),
      username: body.username,
      group: body.group
    });
    const existing = await readVaultKv(logicalPath);
    existing[key] = String(body.value ?? "");
    await writeVaultKv(logicalPath, existing);
    return reply.code(201).send({ path: logicalPath, key, value: "***", updatedAt: new Date().toISOString() });
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

app.patch("/admin/secrets", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const body = (request.body ?? {}) as { scope?: string; username?: string; group?: string; key?: string; value?: unknown };
  const key = String(body.key ?? "").trim();
  if (!key) return reply.code(400).send({ error: "SECRET_KEY_REQUIRED" });
  try {
    const logicalPath = secretLogicalPath({
      scope: String(body.scope ?? "global").trim().toLowerCase(),
      username: body.username,
      group: body.group
    });
    const existing = await readVaultKv(logicalPath);
    if (!(key in existing)) return reply.code(404).send({ error: "VAULT_SECRET_NOT_FOUND", details: key });
    existing[key] = String(body.value ?? "");
    await writeVaultKv(logicalPath, existing);
    return { path: logicalPath, key, value: "***", updatedAt: new Date().toISOString() };
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

app.delete("/admin/secrets", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const body = (request.body ?? {}) as { scope?: string; username?: string; group?: string; key?: string };
  try {
    const logicalPath = secretLogicalPath({
      scope: String(body.scope ?? "global").trim().toLowerCase(),
      username: body.username,
      group: body.group
    });
    const key = String(body.key ?? "").trim();
    if (!key) {
      const response = await vaultCall("DELETE", secretMetadataPath(logicalPath));
      if (!response.ok && response.status !== 404) return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: logicalPath });
      return { deleted: true, path: logicalPath };
    }
    const existing = await readVaultKv(logicalPath);
    if (!(key in existing)) return reply.code(404).send({ error: "VAULT_SECRET_NOT_FOUND", details: key });
    delete existing[key];
    await writeVaultKv(logicalPath, existing);
    return { deleted: true, path: logicalPath, key };
  } catch (error) {
    return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/admin/secrets/migrate", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  return reply.code(202).send({
    migrationId: `noop_${Date.now()}`,
    converted: 0,
    skipped: 0,
    failed: 0,
    rollbackMap: [],
    errors: [],
    message: "No migration targets remain after workflow/execution feature removal."
  });
});

// ─── Internal OAuth token endpoints (called by api-gateway only) ─────────────

const INTERNAL_OAUTH_SECRET = String(process.env.PLATFORM_OAUTH_SECRET ?? "").trim();

function verifyInternalSecret(request: any): boolean {
  if (!INTERNAL_OAUTH_SECRET) return false;
  const provided = String(request.headers["x-internal-secret"] ?? "").trim();
  if (!provided || provided.length !== INTERNAL_OAUTH_SECRET.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_OAUTH_SECRET));
  } catch {
    return false;
  }
}

// POST /internal/oauth-token/:kbId — store OAuth tokens in Vault
app.post("/internal/oauth-token/:kbId", async (request, reply) => {
  if (!verifyInternalSecret(request)) return reply.code(401).send({ error: "UNAUTHORIZED" });
  const { kbId } = request.params as { kbId: string };
  const { userId, provider, accessToken, refreshToken, tokenExpiry } = request.body as {
    userId: string;
    provider: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: string;
  };
  if (!userId || !provider || !accessToken) return reply.code(400).send({ error: "MISSING_FIELDS" });

  const kb = await prisma.ragKnowledgeBase.findUnique({ where: { id: kbId } }).catch(() => null);
  if (!kb) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });

  const ownerId = String(kb.ownerId ?? userId).trim() || userId;
  const vaultPath = userSourceSecretPath(ownerId, kbId);
  const existing = await readVaultKv(vaultPath);

  const updated: Record<string, string> = {
    ...Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, String(v)])),
    auth_method: "oauth"
  };

  if (provider === "github") {
    updated.github_token = accessToken;
  } else if (provider === "gitlab") {
    updated.gitlab_token = accessToken;
    if (refreshToken) updated.gitlab_refresh = refreshToken;
    if (tokenExpiry) updated.token_expiry = tokenExpiry;
  } else if (provider === "google") {
    updated.gdrive_token = accessToken;
    if (refreshToken) updated.gdrive_refresh = refreshToken;
    if (tokenExpiry) updated.token_expiry = tokenExpiry;
  } else {
    return reply.code(400).send({ error: "UNKNOWN_PROVIDER" });
  }

  await writeVaultKv(vaultPath, updated);
  logInfo("OAuth token stored", { service: "workflow-service", kbId, provider, userId: ownerId });
  return reply.code(200).send({ ok: true });
});

// DELETE /internal/oauth-token/:kbId — disconnect OAuth, revert auth_method to "pat"
app.delete("/internal/oauth-token/:kbId", async (request, reply) => {
  if (!verifyInternalSecret(request)) return reply.code(401).send({ error: "UNAUTHORIZED" });
  const { kbId } = request.params as { kbId: string };
  const { userId, provider } = request.body as { userId: string; provider: string };
  if (!userId || !provider) return reply.code(400).send({ error: "MISSING_FIELDS" });

  const kb = await prisma.ragKnowledgeBase.findUnique({ where: { id: kbId } }).catch(() => null);
  if (!kb) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });

  const ownerId = String(kb.ownerId ?? userId).trim() || userId;
  const vaultPath = userSourceSecretPath(ownerId, kbId);
  const existing = await readVaultKv(vaultPath);

  const updated: Record<string, string> = {
    ...Object.fromEntries(Object.entries(existing).map(([k, v]) => [k, String(v)])),
    auth_method: "pat"
  };

  // Remove OAuth-specific token fields for this provider
  if (provider === "github") {
    delete updated.github_token;
  } else if (provider === "gitlab") {
    delete updated.gitlab_token;
    delete updated.gitlab_refresh;
    delete updated.token_expiry;
  } else if (provider === "google") {
    delete updated.gdrive_token;
    delete updated.gdrive_refresh;
    delete updated.token_expiry;
  }

  await writeVaultKv(vaultPath, updated);
  logInfo("OAuth token disconnected", { service: "workflow-service", kbId, provider, userId: ownerId });
  return reply.code(200).send({ ok: true });
});

// GET /internal/oauth-credentials/:provider — returns client_id + client_secret from Vault
// GET /internal/oauth-credentials/:provider?kbId=xxx&userId=yyy
// Reads per-integration Vault path. Falls back to env vars if not set.
app.get("/internal/oauth-credentials/:provider", async (request, reply) => {
  if (!verifyInternalSecret(request)) return reply.code(401).send({ error: "UNAUTHORIZED" });
  const { provider } = request.params as { provider: string };
  const { kbId, userId } = request.query as { kbId?: string; userId?: string };
  const allowed = ["github", "gitlab", "google"];
  if (!allowed.includes(provider)) return reply.code(400).send({ error: "UNKNOWN_PROVIDER" });

  // Read per-integration credentials from Vault
  let clientId = "";
  let clientSecret = "";
  if (kbId && userId) {
    const perIntegrationSecrets = await readVaultKv(userSourceSecretPath(userId, kbId));
    clientId = String(perIntegrationSecrets.oauth_client_id ?? "").trim();
    clientSecret = String(perIntegrationSecrets.oauth_client_secret ?? "").trim();
  }

  // Fall back to env vars if not configured per-integration
  if (!clientId) {
    const envKey = provider.toUpperCase();
    clientId = String(process.env[`${envKey}_CLIENT_ID`] ?? "").trim();
    clientSecret = clientSecret || String(process.env[`${envKey}_CLIENT_SECRET`] ?? "").trim();
  }

  if (!clientId) return reply.code(404).send({ error: "OAUTH_NOT_CONFIGURED" });
  return reply.send({ clientId, clientSecret });
});

// PATCH /rag/integrations/:id/oauth-app-credentials — save OAuth App Client ID + Secret per-integration
app.patch("/rag/integrations/:id/oauth-app-credentials", async (request, reply) => {
  const { id: kbId } = request.params as { id: string };
  const { clientId, clientSecret } = (request.body ?? {}) as { clientId?: string; clientSecret?: string };
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  if (!userId || userId === "unknown") return reply.code(401).send({ error: "UNAUTHORIZED" });
  if (!clientId?.trim() && !clientSecret?.trim()) return reply.code(400).send({ error: "MISSING_CREDENTIALS" });

  const path = userSourceSecretPath(userId, kbId);
  const existing = await readVaultKv(path);
  const update: Record<string, unknown> = { ...existing };
  if (clientId?.trim()) update.oauth_client_id = clientId.trim();
  if (clientSecret?.trim()) update.oauth_client_secret = clientSecret.trim();
  await writeVaultKv(path, update);
  return reply.send({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────

app.listen({ host: "0.0.0.0", port: config.port }).catch((error) => {
  process.stderr.write(`[workflow-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
