import { loadConfig } from "@platform/config";
import type {
  RagDiscussionSendMessageResponse,
  RagDiscussionSummary,
  RagDiscussionThread
} from "@platform/contracts";
import { prisma } from "@platform/db";
import { logInfo } from "@platform/observability";
import { createTlsRuntime, tlsFetch } from "@platform/tls-runtime";
import Fastify from "fastify";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DifyProvisioningConfig } from "./dify-config.js";
import {
  DEFAULT_WORKFLOW_IDS,
  buildDifyProvisioningConfig,
  resolveDifyWorkflowId
} from "./dify-config.js";
import {
  buildRagThreadExpiry,
  deriveRagThreadTitle,
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
function requesterUserId(headers: Record<string, unknown>): string {
  return String(headers["x-user-id"] ?? "").trim() || "unknown";
}

function requesterUserName(headers: Record<string, unknown>): string {
  // x-user-name is the Keycloak preferred_username forwarded by the API gateway.
  // Falls back to x-user-id (same value) if not set.
  return String(headers["x-user-name"] ?? headers["x-user-id"] ?? "").trim() || "unknown";
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

function isSensitiveSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("password") ||
    normalized.includes("secret") ||
    normalized.includes("token") ||
    normalized.endsWith("_key") ||
    normalized.includes("api_key") ||
    normalized === "key"
  );
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
  return Boolean(ext && ["md", "markdown", "txt", "html", "htm", "xml", "csv", "pdf", "docx", "xlsx", "xls", "pptx", "ppt", "eml", "msg", "epub", "rst", "mdx"].includes(ext));
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
  const workflowId = resolveDifyWorkflowId(sourceType, configSecret, DEFAULT_WORKFLOW_IDS);
  return {
    difyAppUrl: nonEmptyString(configSecret.default_app_url) ?? config.difyApiBaseUrl,
    defaultApiKey: nonEmptyString(configSecret.default_api_key),
    workflowId
  };
}

type DifyConsoleSession = {
  baseUrl: string;
  token: string;
  config: DifyProvisioningConfig;
};

type DifyDatasetDocument = {
  id?: string;
  name?: string;
  indexing_status?: string;
  archived?: boolean;
  error?: string | null;
  created_at?: string | number | null;
  updated_at?: string | number | null;
};

type FailedDifyIndexingDocument = {
  filePath?: string;
  difyDocId?: string;
  batchId?: string;
  indexingStatus?: string;
  error?: string;
  retryable?: boolean;
};

type RetryFailedDifyIndexingOptions = {
  syncJobId?: string;
  documentIds?: string[];
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function parseDifyDateMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 10_000_000_000 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
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

  return buildDifyProvisioningConfig({
    configSecret: {
      ...configSecret,
      default_app_url: difyAppUrl,
      console_email: consoleEmail,
      console_name: consoleName
    },
    defaults,
    consolePassword
  });
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

  const isCompatibleProvider = provisioningConfig.modelProvider === "openai_api_compatible";
  const endpointUrl = provisioningConfig.modelApiBase
    ? `${trimTrailingSlash(provisioningConfig.modelApiBase)}/v1`
    : undefined;

  // openai_api_compatible uses different credential keys and requires per-model registration
  if (isCompatibleProvider) {
    const baseCreds = {
      api_key: provisioningConfig.modelApiKey,
      endpoint_url: endpointUrl ?? "https://api.openai.com/v1"
    };
    await difyConsoleFetch(baseUrl, `/workspaces/current/model-providers/openai_api_compatible/models`, {
      method: "POST",
      token,
      body: {
        model: provisioningConfig.chatModel,
        model_type: "llm",
        credentials: { ...baseCreds, mode: "chat", context_size: "128000", max_tokens_to_sample: "4096", stream_mode_delimiter: "\n\n" }
      }
    });
    await difyConsoleFetch(baseUrl, `/workspaces/current/model-providers/openai_api_compatible/models`, {
      method: "POST",
      token,
      body: {
        model: provisioningConfig.embeddingModel,
        model_type: "text-embedding",
        credentials: { ...baseCreds, context_size: "8191" }
      }
    });
  } else {
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
    } catch {
      // Some OpenAI gateways only authorize selected models — fall back to per-model credentials.
      await difyConsoleFetch(baseUrl, `/workspaces/current/model-providers/${provisioningConfig.modelProvider}/models`, {
        method: "POST",
        token,
        body: { model: provisioningConfig.chatModel, model_type: "llm", credentials: modelCredentials }
      });
      await difyConsoleFetch(baseUrl, `/workspaces/current/model-providers/${provisioningConfig.modelProvider}/models`, {
        method: "POST",
        token,
        body: { model: provisioningConfig.embeddingModel, model_type: "text-embedding", credentials: modelCredentials }
      });
    }
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

async function configureDifyDatasetEmbedding(session: DifyConsoleSession, datasetId: string): Promise<void> {
  const existing = await difyConsoleFetch(session.baseUrl, `/datasets/${datasetId}`, {
    method: "GET",
    token: session.token
  });
  const dataset = existing.payload;
  const indexingTechnique = nonEmptyString(dataset.indexing_technique) ?? "high_quality";
  const embeddingModel = nonEmptyString(dataset.embedding_model);
  const embeddingProvider = nonEmptyString(dataset.embedding_model_provider);
  if (
    indexingTechnique !== "high_quality" ||
    (embeddingModel === session.config.embeddingModel && embeddingProvider === session.config.modelProvider)
  ) {
    return;
  }

  await difyConsoleFetch(session.baseUrl, `/datasets/${datasetId}`, {
    method: "PATCH",
    token: session.token,
    body: {
      name: nonEmptyString(dataset.name) ?? "Knowledge Base",
      description: nonEmptyString(dataset.description) ?? "",
      indexing_technique: "high_quality",
      permission: nonEmptyString(dataset.permission) ?? "only_me",
      embedding_model: session.config.embeddingModel,
      embedding_model_provider: session.config.modelProvider,
      retrieval_model: dataset.retrieval_model ?? {
        search_method: "semantic_search",
        reranking_enable: false,
        top_k: 4,
        score_threshold_enabled: false
      }
    }
  });
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
  await configureDifyDatasetEmbedding(session, datasetId);

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

/**
 * Resolve a visible knowledge base for starting or continuing a discussion.
 * Uses the new ownership model: ownerId or shared-with, no scope field.
 */
async function resolveVisibleKnowledgeBaseForDiscussion(
  ownerId: string,
  headers: Record<string, unknown>,
  requestedKnowledgeBaseId?: string
): Promise<{ id: string } | null> {
  const privileged = isAdminOrUserAdmin(headers);

  if (requestedKnowledgeBaseId) {
    // Check if the user can access this specific KB
    const canAccess = await canAccessKnowledgeBase(requestedKnowledgeBaseId, ownerId, privileged);
    if (!canAccess) return null;
    return { id: requestedKnowledgeBaseId };
  }

  // No specific KB requested — find user's default or most recent accessible KB
  const userConfig = await readUserRagConfig(ownerId);
  const userDefaultId = nonEmptyString(userConfig.default_kb_id);
  if (userDefaultId) {
    const canAccess = await canAccessKnowledgeBase(userDefaultId, ownerId, privileged);
    if (canAccess) return { id: userDefaultId };
  }

  // Fall back to first accessible KB (owned or shared-with)
  if (privileged) {
    const kb = await (prisma as any).ragKnowledgeBase.findFirst({
      select: { id: true },
      orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
    });
    return kb ?? null;
  }

  const sharedKbIds = await (prisma as any).ragKbShare.findMany({
    where: { sharedWithId: ownerId },
    select: { knowledgeBaseId: true }
  });
  const sharedIds = sharedKbIds.map((s: { knowledgeBaseId: string }) => s.knowledgeBaseId);
  const kb = await (prisma as any).ragKnowledgeBase.findFirst({
    where: {
      OR: [
        { ownerId },
        { id: { in: sharedIds } }
      ]
    },
    select: { id: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
  });
  return kb ?? null;
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

/**
 * Extracts token usage from a Dify chat-message response payload.
 * Dify returns usage inside: { metadata: { usage: { prompt_tokens, completion_tokens, total_tokens, ... } } }
 */
function extractDifyTokenUsage(payload: Record<string, unknown>): {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
} | null {
  const metadata = payload.metadata;
  if (!metadata || typeof metadata !== "object") return null;
  const usage = (metadata as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const promptTokens = typeof u.prompt_tokens === "number" ? u.prompt_tokens : 0;
  const completionTokens = typeof u.completion_tokens === "number" ? u.completion_tokens : 0;
  const totalTokens = typeof u.total_tokens === "number" ? u.total_tokens : promptTokens + completionTokens;
  if (promptTokens === 0 && completionTokens === 0 && totalTokens === 0) return null;
  return { promptTokens, completionTokens, totalTokens };
}

/**
 * Calls Dify chat-messages API for a given knowledge base.
 * The API key is fetched from Vault at runtime — it is never stored in env vars.
 * Vault path: platform/global/dify/{kbId} → app_api_key
 *
 * Auto-recovery on 401: If Dify returns 401 (stale/wiped API key), the service
 * automatically logs in to the Dify console, creates a fresh API key, updates
 * Vault, and retries once. This handles the case where the Dify container
 * restarts with a fresh DB (clearing all api_tokens) without operator intervention.
 */
async function sendToDify(
  content: string,
  difyConversationId: string | null,
  kbId: string,
  difyAppUrl: string,
  userId: string
): Promise<{ answer: string; conversationId: string; tokenUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | null }> {
  // Fetch the Dify API key from Vault — never from env vars
  const secrets = await readVaultKv(`platform/global/dify/${kbId}`);
  const apiKey = String(secrets.app_api_key ?? secrets.api_key ?? "").trim();
  if (!apiKey) throw new Error(`DIFY_API_KEY_NOT_CONFIGURED:${kbId}`);

  const chatBody = JSON.stringify({
    inputs: {},
    query: content,
    response_mode: "blocking",
    // Pass empty string for first message; Dify creates a new conversation
    conversation_id: difyConversationId ?? "",
    user: userId
  });

  const doRequest = async (key: string): Promise<Response> => {
    return fetch(`${difyAppUrl}/v1/chat-messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`
      },
      body: chatBody
    });
  };

  let response = await doRequest(apiKey);

  // Auto-recover stale API key: Dify wipes api_tokens on DB reset/container restart.
  // On 401 → login to Dify console, create fresh key, update Vault, retry once.
  if (response.status === 401) {
    logInfo("DIFY_KEY_STALE — attempting auto-recovery", {
      service: "workflow-service",
      kbId,
      userId
    });
    try {
      const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id: kbId } });
      const sourceType = String(kb?.sourceType ?? "github");
      const appId = nonEmptyString(secrets.app_id);
      if (!appId) throw new Error("DIFY_APP_ID_MISSING_IN_VAULT");

      // Login to Dify console and create a fresh app API key
      const session = await ensureDifyConsoleSession(sourceType);
      const freshAppApiKey = await createDifyAppApiKey(session, appId);

      // Persist the new key to Vault so subsequent requests use it immediately
      await writeVaultKv(`platform/global/dify/${kbId}`, {
        ...secrets,
        api_key: freshAppApiKey,
        app_api_key: freshAppApiKey
      });

      logInfo("DIFY_KEY_RECOVERED — retrying request", {
        service: "workflow-service",
        kbId,
        userId
      });

      // Retry once with the fresh key
      response = await doRequest(freshAppApiKey);

      if (response.status === 401) {
        throw new Error(`DIFY_AUTH_RECOVERY_FAILED:${kbId}`);
      }
    } catch (recoveryError) {
      const errMsg = recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
      // If recovery itself failed, surface original 401 with context
      throw new Error(`DIFY_REQUEST_FAILED:401:{"code":"unauthorized","message":"${errMsg}","status":401}`);
    }
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`DIFY_REQUEST_FAILED:${response.status}:${text}`);
  }
  const payload = await response.json() as Record<string, unknown>;
  const answer = typeof payload.answer === "string" && payload.answer.trim()
    ? payload.answer
    : (() => { throw new Error("DIFY_EMPTY_RESPONSE"); })();
  const conversationId = typeof payload.conversation_id === "string" ? payload.conversation_id : "";
  // Extract token usage from Dify's metadata — used for observability/cost tracking
  const tokenUsage = extractDifyTokenUsage(payload);
  return { answer, conversationId, tokenUsage };
}

async function difyDatasetFetch(
  difyAppUrl: string,
  path: string,
  apiKey: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
    ok?: number[];
  } = {}
): Promise<Record<string, any>> {
  const response = await fetch(`${trimTrailingSlash(difyAppUrl)}/v1${path}`, {
    method: options.method ?? "GET",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) as Record<string, any> : {};
  const expected = options.ok ?? [200, 201];
  if (!expected.includes(response.status)) {
    const message = typeof payload.message === "string" ? payload.message : text;
    throw new Error(`DIFY_DATASET_REQUEST_FAILED:${path}:${response.status}:${message}`);
  }
  return payload;
}

async function listDifyDatasetDocuments(
  difyAppUrl: string,
  datasetId: string,
  apiKey: string
): Promise<DifyDatasetDocument[]> {
  const documents: DifyDatasetDocument[] = [];
  for (let page = 1; page <= 20; page++) {
    const payload = await difyDatasetFetch(
      difyAppUrl,
      `/datasets/${encodeURIComponent(datasetId)}/documents?page=${page}&limit=100`,
      apiKey
    );
    const data = Array.isArray(payload.data) ? payload.data as DifyDatasetDocument[] : [];
    documents.push(...data);
    if (!payload.has_more || data.length === 0) break;
  }
  return documents;
}

function isDifyIndexingActive(status: string): boolean {
  return ["waiting", "parsing", "cleaning", "splitting", "indexing"].includes(status);
}

function isRetryableDifyIndexingError(error: string | undefined): boolean {
  const normalized = String(error ?? "").toLowerCase();
  if (!normalized) return false;
  return [
    "too many requests",
    "rate limit",
    "ratelimit",
    "429",
    "timeout",
    "timed out",
    "temporary",
    "temporarily",
    "embedding",
    "upstream",
    "unavailable",
    "overloaded",
    "try again"
  ].some((needle) => normalized.includes(needle));
}

function normalizeFailedDifyDocuments(value: unknown): FailedDifyIndexingDocument[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((raw) => {
      const o = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const filePath = nonEmptyString(o.filePath) ?? nonEmptyString(o.name);
      const difyDocId = nonEmptyString(o.difyDocId) ?? nonEmptyString(o.docId) ?? nonEmptyString(o.documentId);
      const batchId = nonEmptyString(o.batchId);
      const indexingStatus = nonEmptyString(o.indexingStatus) ?? nonEmptyString(o.indexing_status);
      const error = nonEmptyString(o.error) ?? nonEmptyString(o.errorMessage);
      const retryable = typeof o.retryable === "boolean" ? o.retryable : undefined;
      return { filePath, difyDocId, batchId, indexingStatus, error, retryable };
    })
    .filter((doc) => doc.filePath || doc.difyDocId || doc.batchId || doc.error);
}

function mergeFailedDifyDocumentDetails(
  requested: FailedDifyIndexingDocument[],
  documents: DifyDatasetDocument[]
): FailedDifyIndexingDocument[] {
  return requested.map((doc) => {
    const match = documents.find((candidate) =>
      (doc.difyDocId && candidate.id === doc.difyDocId) ||
      (doc.filePath && candidate.name === doc.filePath)
    );
    if (!match) return doc;
    return {
      ...doc,
      filePath: doc.filePath ?? match.name,
      difyDocId: doc.difyDocId ?? match.id,
      indexingStatus: String(match.indexing_status ?? doc.indexingStatus ?? ""),
      error: nonEmptyString(match.error) ?? doc.error
    };
  });
}

function failedDifyDocumentFromDatasetDocument(doc: DifyDatasetDocument): FailedDifyIndexingDocument {
  return {
    filePath: doc.name,
    difyDocId: doc.id,
    indexingStatus: doc.indexing_status,
    error: doc.error ?? undefined,
    retryable: isRetryableDifyIndexingError(doc.error ?? undefined)
  };
}

function dedupeFailedDifyDocuments(documents: FailedDifyIndexingDocument[]): FailedDifyIndexingDocument[] {
  const seen = new Set<string>();
  const deduped: FailedDifyIndexingDocument[] = [];
  for (const doc of documents) {
    const key = doc.difyDocId ?? `${doc.filePath ?? "unknown"}:${doc.batchId ?? ""}:${doc.error ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(doc);
  }
  return deduped;
}

function failedDocumentsFromSyncJob(job: Record<string, any> | null | undefined): FailedDifyIndexingDocument[] {
  const steps = Array.isArray(job?.stepsJson) ? job.stepsJson as Record<string, unknown>[] : [];
  const failedDocuments = steps.flatMap((step) => normalizeFailedDifyDocuments(step.failedDocuments));
  return dedupeFailedDifyDocuments(failedDocuments);
}

async function inferFailedDifyDocumentsForSyncJob(input: {
  job: Record<string, any>;
  difyAppUrl: string;
  datasetId: string;
  datasetApiKey: string;
}): Promise<FailedDifyIndexingDocument[]> {
  const explicit = failedDocumentsFromSyncJob(input.job);
  if (explicit.length) return explicit;

  const documents = await listDifyDatasetDocuments(input.difyAppUrl, input.datasetId, input.datasetApiKey);
  const startedAtMs = parseDifyDateMs(input.job.startedAt);
  const completedAtMs = parseDifyDateMs(input.job.completedAt) ?? Date.now();
  const windowStartMs = startedAtMs == null ? null : startedAtMs - 60_000;
  const windowEndMs = completedAtMs + 60_000;
  const failed = documents.filter((doc) => {
    if (!doc.id || doc.archived || String(doc.indexing_status ?? "") !== "error") return false;
    const createdAtMs = parseDifyDateMs(doc.created_at) ?? parseDifyDateMs(doc.updated_at);
    if (windowStartMs == null || createdAtMs == null) return true;
    return createdAtMs >= windowStartMs && createdAtMs <= windowEndMs;
  });
  return dedupeFailedDifyDocuments(failed.map(failedDifyDocumentFromDatasetDocument));
}

async function updateSyncJobStep(syncJobId: string, step: Record<string, unknown>): Promise<void> {
  const job = await (prisma as any).ragKbSyncJob.findUnique({ where: { id: syncJobId } });
  if (!job) return;
  const existing = Array.isArray(job.stepsJson)
    ? (job.stepsJson as Record<string, unknown>[])
    : [];
  const stepName = String(step.stepName ?? step.task ?? "dify_indexing");
  const idx = existing.findIndex((s) => String(s["stepName"] ?? s["task"] ?? "") === stepName);
  if (idx >= 0) existing[idx] = { ...existing[idx], ...step };
  else existing.push(step);
  await (prisma as any).ragKbSyncJob.update({
    where: { id: syncJobId },
    data: { stepsJson: existing }
  });
}

async function pollDifyRetryIndexingJob(input: {
  syncJobId: string;
  sourceSyncJobId?: string;
  difyAppUrl: string;
  datasetId: string;
  datasetApiKey: string;
  documentIds: string[];
}): Promise<void> {
  const maxAttempts = 48;
  const intervalMs = 5000;
  let latestDocuments: DifyDatasetDocument[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    latestDocuments = await listDifyDatasetDocuments(input.difyAppUrl, input.datasetId, input.datasetApiKey);
    const targetDocuments = latestDocuments.filter((doc) => doc.id && input.documentIds.includes(doc.id));
    const completed = targetDocuments.filter((doc) => String(doc.indexing_status ?? "") === "completed").length;
    const active = targetDocuments.some((doc) => isDifyIndexingActive(String(doc.indexing_status ?? "")));
    const failedDocuments = targetDocuments
      .filter((doc) => String(doc.indexing_status ?? "") === "error")
      .map(failedDifyDocumentFromDatasetDocument);

    await (prisma as any).ragKbSyncJob.update({
      where: { id: input.syncJobId },
      data: {
        filesProcessed: completed,
        chunksProcessed: completed,
        stepsJson: [
          {
            task: "Retry Failed Indexing",
            stepName: "retry_failed_indexing",
            status: active ? "running" : "completed",
            message: `${completed}/${input.documentIds.length} failed documents recovered`,
            failedDocuments
          }
        ]
      }
    }).catch(() => undefined);

    if (!active) break;
  }

  const finalDocuments = latestDocuments.length
    ? latestDocuments
    : await listDifyDatasetDocuments(input.difyAppUrl, input.datasetId, input.datasetApiKey);
  const targetDocuments = finalDocuments.filter((doc) => doc.id && input.documentIds.includes(doc.id));
  const completed = targetDocuments.filter((doc) => String(doc.indexing_status ?? "") === "completed").length;
  const failed = targetDocuments.filter((doc) => String(doc.indexing_status ?? "") === "error");
  const active = targetDocuments.some((doc) => isDifyIndexingActive(String(doc.indexing_status ?? "")));
  const firstError = failed.find((doc) => doc.error)?.error;
  const failedDocuments = failed.map(failedDifyDocumentFromDatasetDocument);
  const finalStatus = failed.length || active ? "failed" : "completed";
  const errorMessage = active
    ? "Dify retry indexing timed out"
    : failed.length
      ? `${failed.length} documents still failed indexing${firstError ? `: ${firstError}` : ""}`
      : null;

  await (prisma as any).ragKbSyncJob.update({
    where: { id: input.syncJobId },
    data: {
      status: finalStatus,
      filesProcessed: completed,
      chunksProcessed: completed,
      errorMessage,
      completedAt: new Date(),
      stepsJson: [
        {
          task: "Retry Failed Indexing",
          stepName: "retry_failed_indexing",
          status: finalStatus,
          startedAt: undefined,
          completedAt: new Date().toISOString(),
          message: `${completed}/${input.documentIds.length} failed documents recovered`,
          errorMessage: errorMessage ?? undefined,
          failedDocuments
        }
      ]
    }
  });

  if (input.sourceSyncJobId) {
    const sourceJob = await (prisma as any).ragKbSyncJob.findUnique({ where: { id: input.sourceSyncJobId } }).catch(() => null);
    const sourceFailedDocuments = failedDocumentsFromSyncJob(sourceJob);
    if (sourceJob && sourceFailedDocuments.length > 0) {
      const sourceIds = sourceFailedDocuments.map((doc) => doc.difyDocId).filter(Boolean) as string[];
      const sourceTargets = finalDocuments.filter((doc) => doc.id && sourceIds.includes(doc.id));
      const remaining = sourceTargets
        .filter((doc) => String(doc.indexing_status ?? "") === "error" || isDifyIndexingActive(String(doc.indexing_status ?? "")))
        .map(failedDifyDocumentFromDatasetDocument);
      const sourceTotal = Number(sourceJob.filesTotal ?? sourceIds.length);
      const sourceCompleted = sourceTotal > 0 ? Math.max(0, sourceTotal - remaining.length) : sourceTargets.filter((doc) => String(doc.indexing_status ?? "") === "completed").length;
      const sourceStatus = remaining.length ? "failed" : "completed";
      const sourceErrorMessage = remaining.length ? `${remaining.length} documents still failed indexing` : null;
      await (prisma as any).ragKbSyncJob.update({
        where: { id: input.sourceSyncJobId },
        data: {
          status: sourceStatus,
          filesProcessed: sourceCompleted,
          chunksProcessed: sourceCompleted,
          errorMessage: sourceErrorMessage,
          completedAt: new Date()
        }
      }).catch(() => undefined);
      await updateSyncJobStep(input.sourceSyncJobId, {
        task: "Dify Indexing",
        stepName: "dify_indexing",
        status: sourceStatus,
        completedAt: new Date().toISOString(),
        message: remaining.length ? `${sourceCompleted} indexed, ${remaining.length} errors` : `${sourceCompleted} / ${sourceTotal || sourceCompleted} indexed`,
        errorMessage: sourceErrorMessage ?? undefined,
        failedDocuments: remaining
      }).catch(() => undefined);
    }
  }
}

async function pollFailedDifyDocumentsAfterRetry(input: {
  difyAppUrl: string;
  datasetId: string;
  datasetApiKey: string;
  failedDocuments: FailedDifyIndexingDocument[];
}): Promise<{ completed: number; failed: FailedDifyIndexingDocument[]; active: boolean }> {
  const targetIds = input.failedDocuments.map((doc) => doc.difyDocId).filter(Boolean) as string[];
  let latestDocuments: DifyDatasetDocument[] = [];

  for (let attempt = 0; attempt < 48; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    latestDocuments = await listDifyDatasetDocuments(input.difyAppUrl, input.datasetId, input.datasetApiKey);
    const targets = latestDocuments.filter((doc) => doc.id && targetIds.includes(doc.id));
    const active = targets.some((doc) => isDifyIndexingActive(String(doc.indexing_status ?? "")));
    const failed = targets.filter((doc) => String(doc.indexing_status ?? "") === "error");
    if (!active && targets.length >= targetIds.length) {
      return {
        completed: targets.filter((doc) => String(doc.indexing_status ?? "") === "completed").length,
        failed: mergeFailedDifyDocumentDetails(input.failedDocuments, failed),
        active: false
      };
    }
  }

  const targets = latestDocuments.filter((doc) => doc.id && targetIds.includes(doc.id));
  const failedOrActive = targets.filter((doc) =>
    String(doc.indexing_status ?? "") === "error" ||
    isDifyIndexingActive(String(doc.indexing_status ?? ""))
  );
  return {
    completed: targets.filter((doc) => String(doc.indexing_status ?? "") === "completed").length,
    failed: mergeFailedDifyDocumentDetails(input.failedDocuments, failedOrActive),
    active: failedOrActive.some((doc) => isDifyIndexingActive(String(doc.indexing_status ?? "")))
  };
}

async function autoRetryFailedDifyIndexingForJob(input: {
  syncJobId: string;
  knowledgeBaseId: string;
  failedDocuments: FailedDifyIndexingDocument[];
}): Promise<void> {
  const retryDelaysMs = [60_000, 120_000];
  const nonRetryableFailures = input.failedDocuments.filter((doc) =>
    !doc.difyDocId ||
    doc.retryable === false ||
    !isRetryableDifyIndexingError(doc.error)
  );
  let remaining = input.failedDocuments.filter((doc) =>
    doc.difyDocId &&
    doc.retryable !== false &&
    isRetryableDifyIndexingError(doc.error)
  );

  const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id: input.knowledgeBaseId } });
  if (!kb) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");
  const difySecrets = await readVaultKv(`platform/global/dify/${input.knowledgeBaseId}`);
  const difyDatasetId = nonEmptyString(kb.difyDatasetId) ?? nonEmptyString(difySecrets.dataset_id);
  const datasetApiKey = nonEmptyString(difySecrets.dataset_api_key);
  if (!difyDatasetId) throw new Error("DIFY_DATASET_NOT_CONFIGURED");
  if (!datasetApiKey) throw new Error("DIFY_DATASET_API_KEY_NOT_CONFIGURED");

  for (let round = 0; round < retryDelaysMs.length && remaining.length > 0; round++) {
    const delayMs = retryDelaysMs[round];
    await (prisma as any).ragKbSyncJob.update({
      where: { id: input.syncJobId },
      data: {
        status: "running",
        completedAt: null,
        errorMessage: `${remaining.length} files failed indexing. Waiting before retry...`
      }
    });
    await updateSyncJobStep(input.syncJobId, {
      task: "Dify Indexing",
      stepName: "dify_indexing",
      status: "running",
      message: `${remaining.length} files failed indexing. Waiting before retry...`,
      failedDocuments: [...nonRetryableFailures, ...remaining]
    });

    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const latestJob = await (prisma as any).ragKbSyncJob.findUnique({ where: { id: input.syncJobId } });
    if (String(latestJob?.status ?? "") === "cancelled") return;

    const session = await ensureDifyConsoleSession(String(kb.sourceType ?? "github"));
    await updateSyncJobStep(input.syncJobId, {
      task: "Dify Indexing",
      stepName: "dify_indexing",
      status: "running",
      message: `Retrying ${remaining.length} failed files`,
      failedDocuments: [...nonRetryableFailures, ...remaining]
    });
    await difyConsoleFetch(session.baseUrl, `/datasets/${difyDatasetId}/retry`, {
      method: "POST",
      token: session.token,
      body: { document_ids: remaining.map((doc) => doc.difyDocId).filter(Boolean) },
      ok: [204]
    });

    const result = await pollFailedDifyDocumentsAfterRetry({
      difyAppUrl: String(kb.difyAppUrl ?? ""),
      datasetId: difyDatasetId,
      datasetApiKey,
      failedDocuments: remaining
    });
    remaining = result.failed;

    const job = await (prisma as any).ragKbSyncJob.findUnique({ where: { id: input.syncJobId } });
    const total = Number(job?.filesTotal ?? 0);
    const processed = total > 0 ? Math.max(0, total - remaining.length) : result.completed;
    await (prisma as any).ragKbSyncJob.update({
      where: { id: input.syncJobId },
      data: {
        filesProcessed: processed,
        chunksProcessed: processed,
        errorMessage: nonRetryableFailures.length + remaining.length
          ? `${nonRetryableFailures.length + remaining.length} files failed indexing${remaining.length && round + 1 < retryDelaysMs.length ? ". Waiting before retry..." : ""}`
          : null
      }
    });
  }

  const finalJob = await (prisma as any).ragKbSyncJob.findUnique({ where: { id: input.syncJobId } });
  const total = Number(finalJob?.filesTotal ?? 0);
  const finalFailures = [...nonRetryableFailures, ...remaining];
  const finalStatus = finalFailures.length ? "failed" : "completed";
  const first = finalFailures[0];
  const errorMessage = finalFailures.length
    ? `${finalFailures.length} files failed indexing: ${first?.filePath ?? first?.difyDocId ?? "unknown document"}${first?.error ? `: ${first.error}` : ""}`
    : null;
  const processed = total > 0 ? Math.max(0, total - finalFailures.length) : Number(finalJob?.filesProcessed ?? 0);

  await (prisma as any).ragKbSyncJob.update({
    where: { id: input.syncJobId },
    data: {
      status: finalStatus,
      filesProcessed: processed,
      chunksProcessed: processed,
      errorMessage,
      completedAt: new Date()
    }
  });
  await updateSyncJobStep(input.syncJobId, {
    task: "Dify Indexing",
    stepName: "dify_indexing",
    status: finalStatus,
    completedAt: new Date().toISOString(),
    message: finalFailures.length ? `${processed} / ${total || processed + finalFailures.length} indexed` : `${total || processed} / ${total || processed} indexed`,
    errorMessage: errorMessage ?? undefined,
    failedDocuments: finalFailures
  });
}

async function retryFailedDifyIndexing(
  kbId: string,
  triggeredById: string,
  options: RetryFailedDifyIndexingOptions = {}
): Promise<string> {
  let kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");

  await ensureDifyKnowledgeBaseProvisioned(kbId);
  kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id: kbId } });
  if (!kb) throw new Error("KNOWLEDGE_BASE_NOT_FOUND");

  const difySecrets = await readVaultKv(`platform/global/dify/${kbId}`);
  const difyDatasetId = nonEmptyString(kb.difyDatasetId) ?? nonEmptyString(difySecrets.dataset_id);
  const datasetApiKey = nonEmptyString(difySecrets.dataset_api_key);
  if (!difyDatasetId) throw new Error("DIFY_DATASET_NOT_CONFIGURED");
  if (!datasetApiKey) throw new Error("DIFY_DATASET_API_KEY_NOT_CONFIGURED");

  const sourceJob = options.syncJobId
    ? await (prisma as any).ragKbSyncJob.findFirst({
      where: { id: options.syncJobId, knowledgeBaseId: kbId }
    })
    : (await (prisma as any).ragKbSyncJob.findMany({
      where: { knowledgeBaseId: kbId, status: "failed" },
      orderBy: { createdAt: "desc" },
      take: 20
    })).find((job: Record<string, any>) =>
      Array.isArray(job.stepsJson) &&
      (job.stepsJson as Record<string, unknown>[]).some((step) => step.stepName === "dify_indexing")
    ) ?? null;
  const documents = await listDifyDatasetDocuments(String(kb.difyAppUrl ?? ""), difyDatasetId, datasetApiKey);
  const failedFromJob = sourceJob
    ? await inferFailedDifyDocumentsForSyncJob({
      job: sourceJob,
      difyAppUrl: String(kb.difyAppUrl ?? ""),
      datasetId: difyDatasetId,
      datasetApiKey
    })
    : [];
  if (sourceJob && failedFromJob.length) {
    await updateSyncJobStep(sourceJob.id, {
      task: "Dify Indexing",
      stepName: "dify_indexing",
      failedDocuments: failedFromJob
    }).catch(() => undefined);
  }
  const requestedIds = new Set((options.documentIds ?? []).filter(Boolean));
  const documentIdsFromJob = new Set(failedFromJob.map((doc) => doc.difyDocId).filter(Boolean) as string[]);
  const failedDocuments = documents
    .filter((doc) =>
      doc.id &&
      !doc.archived &&
      String(doc.indexing_status ?? "") === "error" &&
      (requestedIds.size > 0 ? requestedIds.has(doc.id) : documentIdsFromJob.size > 0 ? documentIdsFromJob.has(doc.id) : true)
    );
  const failedDocumentDetails = mergeFailedDifyDocumentDetails(
    failedDocuments.map(failedDifyDocumentFromDatasetDocument),
    documents
  );

  const syncJob = await (prisma as any).ragKbSyncJob.create({
    data: {
      knowledgeBaseId: kbId,
      trigger: "retry_failed_indexing",
      triggeredById,
      status: failedDocuments.length ? "running" : "completed",
      startedAt: new Date(),
      completedAt: failedDocuments.length ? null : new Date(),
      filesTotal: failedDocuments.length,
      filesProcessed: 0,
      chunksTotal: failedDocuments.length,
      chunksProcessed: 0,
      errorMessage: failedDocuments.length ? null : "No failed Dify documents to retry",
      stepsJson: [
        {
          task: "Retry Failed Indexing",
          stepName: "retry_failed_indexing",
          status: failedDocuments.length ? "running" : "completed",
          startedAt: new Date().toISOString(),
          message: failedDocuments.length
            ? `Retrying ${failedDocuments.length} failed documents`
            : "No failed Dify documents to retry",
          failedDocuments: failedDocumentDetails
        }
      ]
    }
  });

  if (!failedDocuments.length) return syncJob.id;

  const session = await ensureDifyConsoleSession(String(kb.sourceType ?? "github"));
  const documentIds = failedDocuments.map((doc) => String(doc.id));
  try {
    await difyConsoleFetch(session.baseUrl, `/datasets/${difyDatasetId}/retry`, {
      method: "POST",
      token: session.token,
      body: { document_ids: documentIds },
      ok: [204]
    });
  } catch (error) {
    await (prisma as any).ragKbSyncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : String(error),
        stepsJson: [
          {
            task: "Retry Failed Indexing",
            stepName: "retry_failed_indexing",
            status: "failed",
            completedAt: new Date().toISOString(),
            errorMessage: error instanceof Error ? error.message : String(error)
          }
        ]
      }
    });
    return syncJob.id;
  }

  void pollDifyRetryIndexingJob({
    syncJobId: syncJob.id,
    sourceSyncJobId: sourceJob?.id,
    difyAppUrl: String(kb.difyAppUrl ?? ""),
    datasetId: difyDatasetId,
    datasetApiKey,
    documentIds
  }).catch(async (error) => {
    await (prisma as any).ragKbSyncJob.update({
      where: { id: syncJob.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        errorMessage: error instanceof Error ? error.message : String(error)
      }
    }).catch(() => undefined);
  });

  return syncJob.id;
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
    // Log token usage for cost observability — Dify includes this in every chat response
    if (result.tokenUsage) {
      logInfo("dify_chat_token_usage", {
        service: "workflow-service",
        threadId,
        knowledgeBaseId: thread.knowledgeBaseId,
        userId: ownerId,
        promptTokens: result.tokenUsage.promptTokens,
        completionTokens: result.tokenUsage.completionTokens,
        totalTokens: result.tokenUsage.totalTokens
      });
    }
  } else {
    throw new Error("LEGACY_FLOWISE_THREAD_EXPIRED");
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
  // syncProvisioned: requires dataset API key but NOT difyDatasetId — after cleanup, difyDatasetId is cleared
  // but triggerKbSync will auto-provision a fresh Dify dataset when sync is triggered.
  // So we allow sync as long as the dataset API key exists (or chatReady = app key exists).
  const syncProvisioned = Boolean(nonEmptyString(difySecrets.dataset_api_key)) || chatReady;
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
      sourcePaths: kb.sourcePaths ?? [],
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
  // Admins see ALL KBs across all users.
  // Regular users see: KBs they own + KBs explicitly shared with them via RagKbShare.
  if (isPrivileged) {
    return (prisma as any).ragKnowledgeBase.findMany({
      include: { config: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 1 }, shares: true },
      orderBy: { createdAt: "desc" }
    });
  }
  // Find KBs shared with this user
  const sharedKbIds = await (prisma as any).ragKbShare.findMany({
    where: { sharedWithId: userId },
    select: { knowledgeBaseId: true }
  });
  const sharedIds = sharedKbIds.map((s: { knowledgeBaseId: string }) => s.knowledgeBaseId);
  return (prisma as any).ragKnowledgeBase.findMany({
    where: {
      OR: [
        { ownerId: userId },
        { id: { in: sharedIds } }
      ]
    },
    include: { config: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 1 }, shares: { where: { sharedWithId: userId } } },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
  });
}

/**
 * Check if a user can access a specific KB (owner, shared-with, or admin).
 */
async function canAccessKnowledgeBase(kbId: string, userId: string, isPrivileged: boolean): Promise<boolean> {
  if (isPrivileged) return true;
  const kb = await (prisma as any).ragKnowledgeBase.findFirst({
    where: {
      id: kbId,
      OR: [
        { ownerId: userId },
        { shares: { some: { sharedWithId: userId } } }
      ]
    },
    select: { id: true }
  });
  return Boolean(kb);
}

/**
 * Check if a user is the owner of a specific KB (or an admin).
 */
async function isKbOwner(kbId: string, userId: string, isPrivileged: boolean): Promise<boolean> {
  if (isPrivileged) return true;
  const kb = await (prisma as any).ragKnowledgeBase.findFirst({
    where: { id: kbId, ownerId: userId },
    select: { id: true }
  });
  return Boolean(kb);
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
    void tlsFetch(tlsRuntime, new URL(webhookUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kbId,
        syncJobId: syncJob.id,
        sourceUrl: kb.sourceUrl,
        sourceBranch: kb.sourceBranch,
      sourcePath: kb.sourcePath,
      sourcePaths: (kb as any).sourcePaths ?? [],
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
    sourcePaths?: string[];
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
        ownerId: userId,
        ownerUsername: requesterUserName(headers),
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
    sourcePaths?: string[];
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

      // Every KB is owned by the creating user — no global scope.
      // ownerUsername is the Keycloak preferred_username (same as userId in this system).
      return (tx as any).ragKnowledgeBase.create({
        data: {
          name,
          description: body.description ?? null,
          sourceType,
          sourceUrl,
          sourceBranch: body.sourceBranch ?? null,
          sourcePath: body.sourcePath ?? null,
          sourcePaths: Array.isArray(body.sourcePaths) ? body.sourcePaths : (body.sourcePath ? [body.sourcePath] : []),
          syncSchedule: body.syncSchedule ?? null,
          difyAppUrl: body.difyAppUrl ?? defaults.difyAppUrl,
          ownerId: userId,
          ownerUsername: userId,
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

// Get a single knowledge base — checks ownership or share access
app.get("/rag/knowledge-bases/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const privileged = isAdminOrUserAdmin(request.headers as Record<string, unknown>);
  const hasAccess = await canAccessKnowledgeBase(id, userId, privileged);
  if (!hasAccess) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });
  const kb = await (prisma as any).ragKnowledgeBase.findUnique({
    where: { id },
    include: { config: true, syncJobs: { orderBy: { createdAt: "desc" }, take: 5 }, shares: true }
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

// Retry Dify documents that uploaded successfully but failed during indexing.
app.post("/rag/knowledge-bases/:id/retry-failed-indexing", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const userId = requesterUserId(request.headers as Record<string, unknown>);
  const body = (request.body ?? {}) as { syncJobId?: string; documentIds?: unknown };
  const documentIds = Array.isArray(body.documentIds)
    ? body.documentIds.map((value) => String(value ?? "").trim()).filter(Boolean)
    : undefined;
  try {
    const syncJobId = await retryFailedDifyIndexing(id, userId, {
      syncJobId: nonEmptyString(body.syncJobId),
      documentIds
    });
    return reply.code(202).send({ accepted: true, syncJobId, knowledgeBaseId: id });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg === "KNOWLEDGE_BASE_NOT_FOUND") return reply.code(404).send({ error: msg });
    return reply.code(500).send({ error: "DIFY_RETRY_FAILED_INDEXING_TRIGGER_FAILED", details: msg });
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

// Helper to evaluate if a path matches the configured sourcePaths
function matchesSourcePaths(path: string, basePathStr: string | null, sourcePathsArr: string[]): boolean {
  if (!sourcePathsArr || sourcePathsArr.length === 0) {
    if (!basePathStr) return true;
    const basePath = basePathStr.replace(/^\/+|\/+$/g, "");
    return !basePath || path.startsWith(basePath + "/") || path === basePath;
  }

  return sourcePathsArr.some((p) => {
    const cleanPath = p.replace(/^\/+|\/+$/g, "");
    if (!cleanPath) return true;
    return path.startsWith(cleanPath + "/") || path === cleanPath;
  });
}

// Calculate the sync diff, clear obsolete files from Dify and DB, return list of files to upload
app.post("/rag/knowledge-bases/:id/sync-diff", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as {
    tree?: Array<{ path?: string; type?: string; sha?: string }>;
    syncJobId?: string;
  };

  if (!body.syncJobId) return reply.code(400).send({ error: "SYNC_JOB_ID_REQUIRED" });

  const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id } });
  if (!kb) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });

  try {
    const difySecrets = await readVaultKv(`platform/global/dify/${id}`);
    const difyDatasetId = nonEmptyString(kb.difyDatasetId) ?? nonEmptyString(difySecrets.dataset_id);
    const datasetApiKey = nonEmptyString(difySecrets.dataset_api_key);

    if (!difyDatasetId || !datasetApiKey) {
      throw new Error("Dify dataset not configured");
    }

    const session = await ensureDifyConsoleSession(String(kb.sourceType ?? "github"));

    // 1. Filter valid current files from Git tree
    const tree = body.tree ?? [];
    const basePathStr = kb.sourcePath;
    const sourcePathsArr = kb.sourcePaths ?? [];

    const validCurrentFiles = new Map<string, { path: string; sha: string }>();

    for (const item of tree) {
      const path = String(item.path ?? "");
      const sha = String(item.sha ?? "");

      if (item.type !== "blob" || !supportedDocumentPath(path) || !matchesSourcePaths(path, basePathStr, sourcePathsArr)) {
        continue;
      }
      validCurrentFiles.set(path, { path, sha });
    }

    await updateSyncJobStep(body.syncJobId, {
      task: "Calculating Diff",
      stepName: "calculate_diff",
      status: "running",
      startedAt: new Date().toISOString(),
      message: `Analyzing ${validCurrentFiles.size} matching files against existing tracker`
    });

    // 2. Fetch tracked files from database
    const trackedFiles = await (prisma as any).ragKbFileTracker.findMany({
      where: { knowledgeBaseId: id }
    });

    // 3. Compare to find obsolete files (in tracker but not in valid current files)
    const obsoleteFiles = trackedFiles.filter((tracked: any) => !validCurrentFiles.has(tracked.filePath));

    if (obsoleteFiles.length > 0) {
      await updateSyncJobStep(body.syncJobId, {
        task: "Cleanup Removed Paths",
        stepName: "cleanup_removed_paths",
        status: "running",
        startedAt: new Date().toISOString(),
        message: `Removing ${obsoleteFiles.length} obsolete documents from Dify`
      });

      let deleteErrors = 0;
      for (const obs of obsoleteFiles) {
        try {
          await deleteDifyResourceIfPresent(session, `/datasets/${difyDatasetId}/documents/${obs.difyDocumentId}`);
          await (prisma as any).ragKbFileTracker.delete({ where: { id: obs.id } });
        } catch (err) {
          console.warn(`Failed to delete document ${obs.difyDocumentId} from Dify`, err);
          deleteErrors++;
        }
      }

      await updateSyncJobStep(body.syncJobId, {
        task: "Cleanup Removed Paths",
        stepName: "cleanup_removed_paths",
        status: "completed",
        completedAt: new Date().toISOString(),
        message: `Removed ${obsoleteFiles.length} obsolete documents${deleteErrors > 0 ? ` (${deleteErrors} errors)` : ""}`
      });
    }

    // 4. Find new and modified files to upload
    const filesToUpload: Array<{ path: string; sha: string; difyDocumentId?: string; isUpdate: boolean }> = [];

    for (const [path, current] of validCurrentFiles.entries()) {
      const tracked = trackedFiles.find((t: any) => t.filePath === path);
      if (!tracked) {
        // New file
        filesToUpload.push({ path: current.path, sha: current.sha, isUpdate: false });
      } else if (tracked.fileSha !== current.sha) {
        // Modified file
        filesToUpload.push({ path: current.path, sha: current.sha, difyDocumentId: tracked.difyDocumentId, isUpdate: true });
      }
    }

    await updateSyncJobStep(body.syncJobId, {
      task: "Calculating Diff",
      stepName: "calculate_diff",
      status: "completed",
      completedAt: new Date().toISOString(),
      message: `Found ${filesToUpload.length} files to sync (${filesToUpload.filter(f => f.isUpdate).length} updates, ${filesToUpload.filter(f => !f.isUpdate).length} new)`
    });

    // Update job file totals
    await (prisma as any).ragKbSyncJob.update({
      where: { id: body.syncJobId },
      data: { filesTotal: filesToUpload.length }
    });

    return { ok: true, files: filesToUpload };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await updateSyncJobStep(body.syncJobId, {
      task: "Calculating Diff",
      stepName: "calculate_diff",
      status: "failed",
      completedAt: new Date().toISOString(),
      errorMessage: msg
    });
    return reply.code(500).send({ error: "SYNC_DIFF_FAILED", details: msg });
  }
});

// Cleanup: remove all Dify documents and vector index for a KB without deleting the KB record.
// The integration stays — users can re-sync to rebuild the index afterwards.
// Only deletion operations — no file fetch, no upload, no re-indexing.
app.post("/rag/knowledge-bases/:id/cleanup", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  try {
    const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id } });
    if (!kb) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });

    const headers = request.headers as Record<string, unknown>;
    const userId = requesterUserId(headers);

    // Cancel any running sync job for this KB so it doesn't conflict with cleanup
    const runningJob = await (prisma as any).ragKbSyncJob.findFirst({
      where: { knowledgeBaseId: id, status: { in: ["pending", "running"] } },
      orderBy: { createdAt: "desc" }
    });
    if (runningJob) {
      await (prisma as any).ragKbSyncJob.update({
        where: { id: runningJob.id },
        data: { status: "cancelled", errorMessage: "Cancelled by cleanup operation", completedAt: new Date() }
      });
    }

    // Delete all Dify resources (dataset / app) for this KB — leaves KB record intact
    await deleteDifyKnowledgeBaseResources(kb);

    // Clear Dify dataset ID from the KB record so re-sync will re-provision fresh resources.
    // Note: chatReady is computed from Vault secrets, not stored in the DB.
    await (prisma as any).ragKnowledgeBase.update({
      where: { id },
      data: { difyDatasetId: null }
    });

    // Also clear the old dataset_id and app_id from Vault so provisioning starts fresh.
    // If we don't do this, ensureDifyKnowledgeBaseProvisioned will find the stale IDs
    // and try to configure the deleted Dify resources, causing 404 errors on next sync.
    const existingDifySecrets = await readVaultKv(`platform/global/dify/${id}`);
    const cleanedSecrets = { ...existingDifySecrets };
    delete cleanedSecrets.dataset_id;
    delete cleanedSecrets.app_id;
    // Keep API keys, workflow ID, and other config — only remove the resource IDs
    await writeVaultKv(`platform/global/dify/${id}`, cleanedSecrets);

    // Save a real completed cleanup job to the DB so it appears as "Latest" in the Sync Monitor.
    // This makes the cleanup job visible in the history dropdown immediately after running cleanup.
    const nowIso = new Date();
    await (prisma as any).ragKbSyncJob.create({
      data: {
        knowledgeBaseId: id,
        trigger: "cleanup",
        triggeredById: userId,
        status: "completed",
        startedAt: nowIso,
        completedAt: nowIso,
        filesProcessed: 0,
        filesTotal: 0,
        stepsJson: [
          {
            task: "Cleanup: Remove documents from Dify knowledge base",
            stepName: "cleanup_dify_documents",
            status: "completed",
            startedAt: nowIso.toISOString(),
            completedAt: nowIso.toISOString(),
            message: "All indexed documents deleted from Dify"
          },
          {
            task: "Cleanup: Clear vector embeddings",
            stepName: "cleanup_vector_embeddings",
            status: "completed",
            startedAt: nowIso.toISOString(),
            completedAt: nowIso.toISOString(),
            message: "All vector embeddings removed"
          },
          {
            task: "Cleanup: Reset knowledge base state",
            stepName: "cleanup_reset_state",
            status: "completed",
            startedAt: nowIso.toISOString(),
            completedAt: nowIso.toISOString(),
            message: "Sync status and counters reset"
          },
          {
            task: "Cleanup: Clear file tracker database",
            stepName: "cleanup_file_tracker",
            status: "completed",
            startedAt: nowIso.toISOString(),
            completedAt: nowIso.toISOString(),
            message: "Cleared all synced file records"
          }
        ]
      }
    });

    // Clear file tracker database records
    await (prisma as any).ragKbFileTracker.deleteMany({
      where: { knowledgeBaseId: id }
    });

    // Prune history to keep only the last 10 jobs per KB so the monitor stays clean
    const allJobs = await (prisma as any).ragKbSyncJob.findMany({
      where: { knowledgeBaseId: id },
      orderBy: { createdAt: "desc" },
      select: { id: true }
    });
    if (allJobs.length > 10) {
      const idsToDelete = allJobs.slice(10).map((j: { id: string }) => j.id);
      await (prisma as any).ragKbSyncJob.deleteMany({ where: { id: { in: idsToDelete } } });
    }

    logInfo("KB cleanup completed", { service: "workflow-service", kbId: id, userId });
    return reply.code(200).send({ ok: true, message: "All indexed documents and Dify KB data removed. Re-sync to rebuild the index." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logInfo("KB cleanup failed", { service: "workflow-service", kbId: id, error: message });
    return reply.code(500).send({ error: "CLEANUP_FAILED", details: message });
  }
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
      failedDocuments?: FailedDifyIndexingDocument[];
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
    // Handle successful file sync - populate file tracker
    if (body.step?.stepName === "upload_files" && body.step.status === "completed") {
       // if we have specific success records attached to body.step we'd process them here,
       // but typically the n8n webhook reports progress per file or at end.
    }

    if (body.status === "running" && body.step?.stepName === "upload_file_success") {
        // Custom payload from n8n when a file successfully uploads
        const payload = body as any;
        if (payload.difyDocumentId && payload.filePath && payload.fileSha) {
             await (prisma as any).ragKbFileTracker.upsert({
                 where: {
                     knowledgeBaseId_filePath: {
                         knowledgeBaseId: existingJob.knowledgeBaseId,
                         filePath: payload.filePath
                     }
                 },
                 create: {
                     knowledgeBaseId: existingJob.knowledgeBaseId,
                     filePath: payload.filePath,
                     fileSha: payload.fileSha,
                     difyDocumentId: payload.difyDocumentId
                 },
                 update: {
                     fileSha: payload.fileSha,
                     difyDocumentId: payload.difyDocumentId,
                     syncedAt: new Date()
                 }
             });
        }
    }

    let failedDocuments = normalizeFailedDifyDocuments(body.step?.failedDocuments);
    if (
      body.status === "failed" &&
      body.step?.stepName === "dify_indexing" &&
      failedDocuments.length === 0
    ) {
      const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id: existingJob.knowledgeBaseId } });
      const difySecrets = await readVaultKv(`platform/global/dify/${existingJob.knowledgeBaseId}`);
      const difyDatasetId = nonEmptyString(kb?.difyDatasetId) ?? nonEmptyString(difySecrets.dataset_id);
      const datasetApiKey = nonEmptyString(difySecrets.dataset_api_key);
      if (kb && difyDatasetId && datasetApiKey) {
        failedDocuments = await inferFailedDifyDocumentsForSyncJob({
          job: { ...existingJob, completedAt: new Date(), stepsJson: existingJob.stepsJson },
          difyAppUrl: String(kb.difyAppUrl ?? ""),
          datasetId: difyDatasetId,
          datasetApiKey
        });
      }
    }
    const autoRetryableDocuments = failedDocuments.filter((doc) =>
      doc.difyDocId &&
      doc.retryable !== false &&
      isRetryableDifyIndexingError(doc.error)
    );
    if (
      body.status === "failed" &&
      body.step?.stepName === "dify_indexing" &&
      autoRetryableDocuments.length > 0
    ) {
      await (prisma as any).ragKbSyncJob.update({
        where: { id: body.syncJobId },
        data: {
          status: "running",
          filesProcessed: body.filesProcessed ?? undefined,
          filesTotal: body.filesTotal ?? undefined,
          chunksProcessed: body.chunksProcessed ?? undefined,
          errorMessage: `${autoRetryableDocuments.length} files failed indexing. Waiting before retry...`,
          completedAt: null
        }
      });
      await updateSyncJobStep(body.syncJobId, {
        ...body.step,
        status: "running",
        message: `${autoRetryableDocuments.length} files failed indexing. Waiting before retry...`,
        failedDocuments
      });
      void autoRetryFailedDifyIndexingForJob({
        syncJobId: body.syncJobId,
        knowledgeBaseId: existingJob.knowledgeBaseId,
        failedDocuments
      }).catch(async (error) => {
        const msg = error instanceof Error ? error.message : String(error);
        await (prisma as any).ragKbSyncJob.update({
          where: { id: body.syncJobId },
          data: {
            status: "failed",
            completedAt: new Date(),
            errorMessage: `Dify retry failed: ${msg}`
          }
        }).catch(() => undefined);
        await updateSyncJobStep(body.syncJobId!, {
          task: "Dify Indexing",
          stepName: "dify_indexing",
          status: "failed",
          completedAt: new Date().toISOString(),
          errorMessage: `Dify retry failed: ${msg}`,
          failedDocuments
        }).catch(() => undefined);
      });
      return { updated: true, autoRetry: true };
    }

    const adjustedFilesProcessed =
      body.status === "failed" && body.step?.stepName === "dify_indexing" && failedDocuments.length > 0
        ? Math.max(0, Number(body.filesTotal ?? existingJob.filesTotal ?? 0) - failedDocuments.length)
        : body.filesProcessed;
    const isCompleted = body.status === "completed" || body.status === "failed";
    await (prisma as any).ragKbSyncJob.update({
      where: { id: body.syncJobId },
      data: {
        status: body.status ?? "running",
        filesProcessed: adjustedFilesProcessed ?? undefined,
        filesTotal: body.filesTotal ?? undefined,
        chunksProcessed: body.chunksProcessed ?? undefined,
        errorMessage: body.errorMessage ?? null,
        lastProgressAt: new Date(),
        ...(isCompleted ? { completedAt: new Date() } : {})
      }
    });

    // Upsert step into stepsJson
    if (body.step) {
      const stepToStore = body.step.stepName === "dify_indexing" && failedDocuments.length
        ? { ...body.step, failedDocuments }
        : { ...body.step };
      const existing = Array.isArray(existingJob.stepsJson)
        ? (existingJob.stepsJson as Record<string, unknown>[])
        : [];
      const idx = existing.findIndex((s) => s["stepName"] === body.step!.stepName);
      if (idx >= 0) existing[idx] = { ...existing[idx], ...stepToStore };
      else existing.push(stepToStore);
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

// ─── KB Share Management Endpoints ───────────────────────────────────────────
// Owner or platform admin can share a KB with specific users by their username.
// Shared users get chat access only — they cannot edit, delete, or sync the KB.

// POST /rag/knowledge-bases/:id/shares — share KB with a user
app.post("/rag/knowledge-bases/:id/shares", async (request, reply) => {
  const kbId = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requesterId = requesterUserId(headers);
  const privileged = isAdminOrUserAdmin(headers);

  // Verify requester is owner or admin
  const ownerCheck = await isKbOwner(kbId, requesterId, privileged);
  if (!ownerCheck) return reply.code(403).send({ error: "FORBIDDEN_KB_OWNER_OR_ADMIN_ONLY" });

  const body = (request.body ?? {}) as { sharedWithUserId?: string };
  const sharedWithId = String(body.sharedWithUserId ?? "").trim();
  if (!sharedWithId) return reply.code(400).send({ error: "SHARED_WITH_USER_ID_REQUIRED" });

  // Prevent sharing with self
  if (sharedWithId === requesterId && !privileged) {
    return reply.code(400).send({ error: "CANNOT_SHARE_WITH_SELF" });
  }

  // Check KB exists
  const kb = await (prisma as any).ragKnowledgeBase.findUnique({ where: { id: kbId }, select: { id: true } });
  if (!kb) return reply.code(404).send({ error: "KNOWLEDGE_BASE_NOT_FOUND" });

  try {
    const share = await (prisma as any).ragKbShare.create({
      data: {
        id: randomUUID(),
        knowledgeBaseId: kbId,
        sharedWithId,
        sharedById: requesterId,
        permission: "chat"
      }
    });
    logInfo("KB shared", { service: "workflow-service", kbId, sharedWithId, sharedById: requesterId });
    return reply.code(201).send(share);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    // Unique constraint violation = already shared
    if (msg.includes("Unique constraint") || msg.includes("unique")) {
      return reply.code(409).send({ error: "ALREADY_SHARED_WITH_USER" });
    }
    return reply.code(500).send({ error: "SHARE_CREATE_FAILED", details: msg });
  }
});

// GET /rag/knowledge-bases/:id/shares — list who has access to this KB
app.get("/rag/knowledge-bases/:id/shares", async (request, reply) => {
  const kbId = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requesterId = requesterUserId(headers);
  const privileged = isAdminOrUserAdmin(headers);

  const ownerCheck = await isKbOwner(kbId, requesterId, privileged);
  if (!ownerCheck) return reply.code(403).send({ error: "FORBIDDEN_KB_OWNER_OR_ADMIN_ONLY" });

  const shares = await (prisma as any).ragKbShare.findMany({
    where: { knowledgeBaseId: kbId },
    orderBy: { createdAt: "asc" }
  });
  return { shares };
});

// DELETE /rag/knowledge-bases/:id/shares/:shareId — revoke a share
// No request body needed — all info is in URL params and auth headers.
app.delete("/rag/knowledge-bases/:id/shares/:shareId", { config: { rawBody: false } }, async (request, reply) => {
  const { id: kbId, shareId } = request.params as { id: string; shareId: string };
  const headers = request.headers as Record<string, unknown>;
  const requesterId = requesterUserId(headers);
  const privileged = isAdminOrUserAdmin(headers);

  const ownerCheck = await isKbOwner(kbId, requesterId, privileged);
  if (!ownerCheck) return reply.code(403).send({ error: "FORBIDDEN_KB_OWNER_OR_ADMIN_ONLY" });

  const deleted = await (prisma as any).ragKbShare.deleteMany({
    where: { id: shareId, knowledgeBaseId: kbId }
  });
  if (deleted.count === 0) return reply.code(404).send({ error: "SHARE_NOT_FOUND" });
  logInfo("KB share revoked", { service: "workflow-service", kbId, shareId, revokedBy: requesterId });
  return reply.code(204).send();
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
    const sourcePathMatches = paths
      .map((path) => path.match(/^platform\/users\/([^/]+)\/sources\/([^/]+)$/))
      .filter((match): match is RegExpMatchArray => Boolean(match));
    const sourceKbIds = [...new Set(sourcePathMatches.map((match) => match[2]))];
    const sourceKbs = sourceKbIds.length > 0
      ? await (prisma as any).ragKnowledgeBase.findMany({
          where: { id: { in: sourceKbIds } },
          select: { id: true, name: true, sourceType: true }
        })
      : [];
    const sourceKbById = new Map<string, { name?: string | null; sourceType?: string | null }>(
      sourceKbs.map((kb: { id: string; name?: string | null; sourceType?: string | null }) => [kb.id, kb])
    );
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
      valueMasked: boolean;
    }> = [];

    for (const path of paths) {
      const [data, metadata] = await Promise.all([readVaultKv(path), readVaultKvMetadata(path)]);
      const userMatch = path.match(/^platform\/users\/([^/]+)\//);
      const sourceMatch = path.match(/^platform\/users\/([^/]+)\/sources\/([^/]+)$/);
      const isGlobal = path.startsWith("platform/global/");
      const sourceKb = sourceMatch ? sourceKbById.get(sourceMatch[2]) : undefined;
      for (const key of Object.keys(data).sort()) {
        const valueMasked = isSensitiveSecretKey(key);
        items.push({
          path,
          key,
          value: valueMasked ? "***" : String(data[key] ?? ""),
          version: metadata.version,
          updatedAt: metadata.updatedAt,
          purpose: isGlobal ? "Global platform secret" : sourceMatch ? "Integration credential" : "User platform secret",
          ownerId: userMatch?.[1] ?? null,
          resourceType: sourceMatch ? "integration" : isGlobal ? "global" : "user",
          resourceId: sourceMatch?.[2] ?? null,
          resourceName: sourceKb?.name ?? sourceKb?.sourceType ?? null,
          valueMasked
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

// Dedicated error handler endpoint for n8n Error Trigger
// n8n calls this with the full execution context, and we extract syncJobId from it
app.post("/rag/sync-error-handler", async (request, reply) => {
  const body = (request.body ?? {}) as any;
  const errMsg = String(
    body?.execution?.error?.message ||
    body?.execution?.error?.description ||
    body?.error?.message ||
    "Workflow execution failed"
  );

  // Extract syncJobId from execution run data - try Parse Sync Params first, then Webhook Trigger body
  let syncJobId = "";
  let progressCallbackUrl = "";
  let progressCallbackToken = "";

  try {
    const runData = body?.execution?.data?.resultData?.runData || {};
    const parseParamsData = runData["Parse Sync Params"]?.[0]?.data?.main?.[0]?.[0]?.json;
    if (parseParamsData?.syncJobId) {
      syncJobId = parseParamsData.syncJobId;
      progressCallbackUrl = parseParamsData.progressCallbackUrl || "";
      progressCallbackToken = parseParamsData.progressCallbackToken || "";
    } else {
      // Try from webhook trigger
      const webhookData = runData["Webhook Trigger"]?.[0]?.data?.main?.[0]?.[0]?.json;
      const webhookBody = webhookData?.body || webhookData || {};
      syncJobId = webhookBody.syncJobId || "";
      progressCallbackUrl = webhookBody.progressCallbackUrl || "";
      progressCallbackToken = webhookBody.progressCallbackToken || "";
    }
  } catch {}

  if (!syncJobId) {
    return reply.code(200).send({ ok: false, reason: "syncJobId not found in execution data" });
  }

  // Mark the sync job as failed in the database
  try {
    await (prisma as any).ragKbSyncJob.updateMany({
      where: { id: syncJobId, status: { in: ["running", "pending"] } },
      data: {
        status: "failed",
        errorMessage: errMsg,
        completedAt: new Date()
      }
    });

    // Safety net: mark any step still showing 'running' as failed with the error message.
    // This covers cases where the inline step callback in n8n never fired (e.g. the node
    // crashed before it could send the callback).
    const currentJob = await (prisma as any).ragKbSyncJob.findUnique({
      where: { id: syncJobId },
      select: { stepsJson: true }
    });
    if (currentJob?.stepsJson) {
      const steps = Array.isArray(currentJob.stepsJson) ? currentJob.stepsJson : [];
      const updatedSteps = steps.map((s: any) =>
        s.status === "running"
          ? { ...s, status: "failed", errorMessage: errMsg, completedAt: new Date().toISOString() }
          : s
      );
      await (prisma as any).ragKbSyncJob.update({
        where: { id: syncJobId },
        data: { stepsJson: updatedSteps }
      });
    }

    logInfo("Sync job marked failed via error handler", { service: "workflow-service", syncJobId, errMsg });
    return reply.code(200).send({ ok: true, syncJobId });
  } catch (error) {
    return reply.code(500).send({ error: "Failed to update sync job", details: error instanceof Error ? error.message : String(error) });
  }
});

// Auto-fail stale sync jobs that have received no progress callback for 15 minutes.
// Uses lastProgressAt (set on every n8n callback) falling back to createdAt for jobs
// that never sent a single callback (e.g. n8n crashed at startup).
async function sweepStaleJobs(): Promise<void> {
  const staleThresholdMs = 15 * 60 * 1000; // 15 minutes
  const staleThresholdDate = new Date(Date.now() - staleThresholdMs);
  try {
    const activeJobs = await (prisma as any).ragKbSyncJob.findMany({
      where: { status: { in: ["running", "pending"] } },
      select: { id: true, lastProgressAt: true, createdAt: true }
    });
    const staleIds = activeJobs
      .filter((j: any) => (j.lastProgressAt ?? j.createdAt) <= staleThresholdDate)
      .map((j: any) => j.id);
    if (staleIds.length > 0) {
      await (prisma as any).ragKbSyncJob.updateMany({
        where: { id: { in: staleIds } },
        data: {
          status: "failed",
          errorMessage: "Sync timed out — no progress received for 15 minutes. Please retry.",
          completedAt: new Date()
        }
      });
    }
  } catch {
    // Ignore errors during sweep
  }
}

app.listen({ host: "0.0.0.0", port: config.port }).then(() => {
  // Sweep stale jobs every 30 seconds for fast failure feedback
  setInterval(() => {
    sweepStaleJobs().catch(() => undefined);
  }, 30_000);
  // Run once on startup after 10 seconds
  setTimeout(() => {
    sweepStaleJobs().catch(() => undefined);
  }, 10_000);
}).catch((error) => {
  process.stderr.write(`[workflow-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
