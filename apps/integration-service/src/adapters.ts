import { spawn } from "node:child_process";
import { Agent } from "undici";
import type { ExecutionType } from "@platform/contracts";

export interface IntegrationRequest {
  executionType: ExecutionType;
  commandRef: string;
  input?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface IntegrationResult {
  status: "SUCCESS" | "FAILED";
  executionType: ExecutionType;
  commandRef: string;
  durationMs: number;
  output?: unknown;
  error?: string;
  policy: {
    allowed: boolean;
    rule: string;
    reason?: string;
  };
}

const SENSITIVE_PATTERN = /(password|token|secret|authorization|api[-_]?key|private[-_]?key|passphrase|credential)/i;
const DANGEROUS_COMMAND_PATTERN =
  /(^|\s)(rm\s+-rf\s+\/|mkfs(\.| )|shutdown(\s|$)|reboot(\s|$)|:\(\)\s*\{|curl\s+.+\|\s*(sh|bash)|wget\s+.+\|\s*(sh|bash))/i;

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  return value as Record<string, unknown>;
}

interface SecretResolver {
  resolve(ref: string, path: string[]): Promise<string>;
}

class VaultSecretResolver implements SecretResolver {
  async resolve(ref: string, path: string[]): Promise<string> {
    const raw = ref.slice("vault:".length);
    const [vaultPath, fieldName] = raw.split("#");
    if (!vaultPath || !fieldName) {
      throw new Error(`Invalid vault reference format at ${path.join(".") || "root"}. Expected vault:path#field`);
    }
    const addr = process.env.VAULT_ADDR;
    if (!addr) {
      throw new Error("Vault is not configured. Set VAULT_ADDR");
    }
    const endpoint = new URL(`/v1/${vaultPath}`, addr);
    const headers: Record<string, string> = {};
    if (process.env.VAULT_NAMESPACE) {
      headers["X-Vault-Namespace"] = process.env.VAULT_NAMESPACE;
    }

    const response = await fetch(endpoint, { headers });
    if (!response.ok) {
      throw new Error(`Vault secret fetch failed with status ${response.status} for ${vaultPath}`);
    }
    const body = (await response.json()) as {
      data?: {
        data?: Record<string, string>;
      } & Record<string, string>;
    };

    const kv2 = body.data?.data?.[fieldName];
    const kv1 = (body.data as Record<string, string> | undefined)?.[fieldName];
    const value = kv2 ?? kv1;
    if (!value) {
      throw new Error(`Vault field not found: ${fieldName} in ${vaultPath}`);
    }
    return value;
  }
}

function createSecretResolver(provider: "vault"): SecretResolver {
  if (provider === "vault") return new VaultSecretResolver();
  throw new Error(`Unsupported secret provider: ${provider}`);
}

function timeoutOf(input: IntegrationRequest): number {
  return typeof input.timeoutMs === "number" ? input.timeoutMs : 30_000;
}

function maskText(value: string, secrets: Set<string>): string {
  let masked = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      masked = masked.split(secret).join("***");
    }
  }
  return masked;
}

function maskUnknown(value: unknown, secrets: Set<string>): unknown {
  if (typeof value === "string") return maskText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => maskUnknown(item, secrets));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_PATTERN.test(key)) {
      output[key] = "***";
      continue;
    }
    output[key] = maskUnknown(item, secrets);
  }
  return output;
}

async function resolveRefs(
  value: unknown,
  scopedEnv: Record<string, unknown>,
  path: string[] = []
): Promise<{ value: unknown; secrets: Set<string> }> {
  if (Array.isArray(value)) {
    const secrets = new Set<string>();
    const mapped: unknown[] = [];
    for (const [index, entry] of value.entries()) {
      const resolved = await resolveRefs(entry, scopedEnv, [...path, String(index)]);
      for (const secret of resolved.secrets) secrets.add(secret);
      mapped.push(resolved.value);
    }
    return { value: mapped, secrets };
  }

  if (value && typeof value === "object") {
    const secrets = new Set<string>();
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const resolved = await resolveRefs(entry, scopedEnv, [...path, key]);
      output[key] = resolved.value;
      for (const secret of resolved.secrets) secrets.add(secret);
      if (typeof resolved.value === "string" && SENSITIVE_PATTERN.test(key)) {
        secrets.add(resolved.value);
      }
    }
    return { value: output, secrets };
  }

  if (typeof value === "string" && (value.startsWith("env:") || value.startsWith("vault:"))) {
    if (value.startsWith("env:")) {
      throw new Error(`ENV_SECRET_REF_BLOCKED at ${path.join(".") || "root"}`);
    }
    const provider = "vault";
    const resolver = createSecretResolver(provider);
    const resolved = await resolver.resolve(value, path);
    const secrets = new Set<string>();
    if (SENSITIVE_PATTERN.test(value) || provider === "vault") {
      secrets.add(resolved);
    }
    return { value: resolved, secrets };
  }

  return { value, secrets: new Set<string>() };
}

function allowlistRegexFromEnv(name: string, fallback: string): RegExp {
  const source = process.env[name] ?? fallback;
  try {
    return new RegExp(source);
  } catch {
    return new RegExp(fallback);
  }
}

function defaultAllowlist(executionType: ExecutionType): string {
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    return executionType === "REST" ? "^https?://|^http://localhost:" : ".*";
  }
  if (executionType === "REST") {
    return "^https://";
  }
  return "^$";
}

function mergeHeaders(...sources: Array<Record<string, unknown>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || value === null) continue;
      out[key] = String(value);
    }
  }
  return out;
}

function isAbsoluteHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function joinUrl(baseUrl: string, pathOrUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const target = pathOrUrl.replace(/^\/+/, "");
  return `${base}/${target}`;
}

function interpolateTemplateText(text: string, variables: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = variables[key];
    if (value === undefined || value === null) {
      return _match;
    }
    return String(value);
  });
}

function interpolateUnknown(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return interpolateTemplateText(value, variables);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => interpolateUnknown(entry, variables));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    output[key] = interpolateUnknown(entry, variables);
  }
  return output;
}

type OAuthTokenCacheEntry = {
  accessToken: string;
  expiresAtMs: number;
};

const oauthTokenCache = new Map<string, OAuthTokenCacheEntry>();

function oauthCacheKey(credentials: Record<string, unknown>): string {
  return JSON.stringify({
    tokenUrl: credentials.tokenUrl,
    grantType: credentials.grantType,
    clientId: credentials.clientId,
    username: credentials.username,
    scope: credentials.scope
  });
}

async function fetchOauthAccessToken(credentials: Record<string, unknown>): Promise<string> {
  const tokenUrl = String(credentials.tokenUrl ?? credentials.accessTokenUrl ?? "").trim();
  if (!tokenUrl) {
    throw new Error("OAUTH2 token URL is required");
  }
  const cacheKey = oauthCacheKey(credentials);
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.accessToken;
  }

  const grantType = String(credentials.grantType ?? "client_credentials").trim().toLowerCase();
  if (grantType !== "client_credentials" && grantType !== "password") {
    throw new Error(`OAUTH2 grant type not supported: ${grantType}`);
  }
  const clientId = String(credentials.clientId ?? "").trim();
  const clientSecret = String(credentials.clientSecret ?? "").trim();
  const scope = String(credentials.scope ?? "").trim();
  const clientAuthMethod = String(credentials.clientAuthMethod ?? "body").trim().toLowerCase();

  const form = new URLSearchParams();
  form.set("grant_type", grantType);
  if (scope) {
    form.set("scope", scope);
  }
  if (grantType === "password") {
    const username = String(credentials.username ?? "").trim();
    const password = String(credentials.password ?? "").trim();
    if (!username || !password) {
      throw new Error("OAUTH2 password grant requires username and password");
    }
    form.set("username", username);
    form.set("password", password);
  }

  const headers: Record<string, string> = {
    "content-type": "application/x-www-form-urlencoded"
  };
  if (clientAuthMethod === "basic") {
    if (!clientId || !clientSecret) {
      throw new Error("OAUTH2 basic auth requires clientId and clientSecret");
    }
    headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
  } else {
    if (!clientId) {
      throw new Error("OAUTH2 clientId is required");
    }
    form.set("client_id", clientId);
    if (clientSecret) {
      form.set("client_secret", clientSecret);
    }
  }

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers,
    body: form.toString()
  });
  const raw = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    payload = {};
  }
  if (!response.ok) {
    throw new Error(String(payload.error_description ?? payload.error ?? `OAUTH2 token request failed (${response.status})`));
  }
  const accessToken = String(payload.access_token ?? "").trim();
  if (!accessToken) {
    throw new Error("OAUTH2 access token missing in response");
  }
  const expiresIn = Number(payload.expires_in ?? 300);
  const ttlMs = Number.isFinite(expiresIn) ? Math.max(Math.trunc(expiresIn) - 30, 30) * 1000 : 300_000;
  oauthTokenCache.set(cacheKey, {
    accessToken,
    expiresAtMs: Date.now() + ttlMs
  });
  return accessToken;
}

async function applyRestAuth(
  authTypeRaw: unknown,
  credentials: Record<string, unknown>,
  headers: Record<string, string>,
  query: URLSearchParams
): Promise<{
  headers: Record<string, string>;
  query: URLSearchParams;
  dispatcher?: Agent;
  error?: string;
}> {
  const authType = String(authTypeRaw ?? "NO_AUTH").trim().toUpperCase();
  const nextHeaders = { ...headers };
  const nextQuery = new URLSearchParams(query);

  if (authType === "NO_AUTH") {
    return { headers: nextHeaders, query: nextQuery };
  }

  if (authType === "BASIC") {
    const username = String(credentials.username ?? "").trim();
    const password = String(credentials.password ?? "").trim();
    if (!username) return { headers: nextHeaders, query: nextQuery, error: "BASIC auth username is required" };
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    nextHeaders.authorization = `Basic ${encoded}`;
    return { headers: nextHeaders, query: nextQuery };
  }

  if (authType === "API_KEY") {
    const keyName = String(credentials.key ?? credentials.keyName ?? credentials.headerName ?? "").trim();
    const keyValue = String(credentials.value ?? credentials.apiKey ?? credentials.token ?? "").trim();
    if (!keyValue) return { headers: nextHeaders, query: nextQuery, error: "API key value is required" };
    const inLocation = String(credentials.addTo ?? credentials.in ?? "header").trim().toLowerCase();
    const headerName = keyName || "x-api-key";
    const queryName = keyName || "api_key";
    if (inLocation === "query") {
      nextQuery.set(queryName, keyValue);
    } else {
      nextHeaders[headerName] = keyValue;
    }
    return { headers: nextHeaders, query: nextQuery };
  }

  if (authType === "OAUTH2") {
    try {
      const bearer = String(
        credentials.accessToken ?? credentials.token ?? credentials.idToken ?? credentials.jwt ?? credentials.bearerToken ?? ""
      ).trim() || (await fetchOauthAccessToken(credentials));
      nextHeaders.authorization = `Bearer ${bearer.replace(/^Bearer\s+/i, "")}`;
      return { headers: nextHeaders, query: nextQuery };
    } catch (error) {
      return {
        headers: nextHeaders,
        query: nextQuery,
        error: error instanceof Error ? error.message : "OAUTH2 token generation failed"
      };
    }
  }

  if (authType === "OIDC" || authType === "JWT") {
    const bearer = String(
      credentials.accessToken ?? credentials.token ?? credentials.idToken ?? credentials.jwt ?? credentials.bearerToken ?? ""
    ).trim();
    if (!bearer) return { headers: nextHeaders, query: nextQuery, error: `${authType} token is required` };
    nextHeaders.authorization = `Bearer ${bearer.replace(/^Bearer\s+/i, "")}`;
    return { headers: nextHeaders, query: nextQuery };
  }

  if (authType === "MTLS") {
    const cert = String(credentials.cert ?? credentials.clientCert ?? credentials.certificate ?? "").trim();
    const key = String(credentials.key ?? credentials.privateKey ?? credentials.keyPem ?? "").trim();
    const ca = String(credentials.ca ?? "").trim();
    if (!cert || !key) {
      return { headers: nextHeaders, query: nextQuery, error: "mTLS cert and key are required" };
    }
    const dispatcher = new Agent({
      connect: {
        cert,
        key,
        ca: ca || undefined,
        rejectUnauthorized: credentials.rejectUnauthorized !== false
      }
    });
    return { headers: nextHeaders, query: nextQuery, dispatcher };
  }

  return { headers: nextHeaders, query: nextQuery };
}

function validateCommandPolicy(executionType: ExecutionType, command: string): {
  allowed: boolean;
  rule: string;
  reason?: string;
} {
  if (executionType !== "REST" && DANGEROUS_COMMAND_PATTERN.test(command)) {
    return {
      allowed: false,
      rule: "dangerous-command",
      reason: "Command blocked by dangerous command policy"
    };
  }
  const allowlistVar =
    executionType === "SCRIPT"
      ? "INTEGRATION_SCRIPT_ALLOWLIST"
      : executionType === "SSH"
        ? "INTEGRATION_SSH_ALLOWLIST"
        : executionType === "NETCONF"
        ? "INTEGRATION_NETCONF_ALLOWLIST"
          : "INTEGRATION_REST_URL_ALLOWLIST";
  const fallback = defaultAllowlist(executionType);
  const pattern = allowlistRegexFromEnv(allowlistVar, fallback);
  if (pattern.test(command)) {
    return {
      allowed: true,
      rule: allowlistVar
    };
  }
  return {
    allowed: false,
    rule: allowlistVar,
    reason: `Command blocked by allowlist policy: ${allowlistVar}`
  };
}

async function runCommand(
  cmd: string,
  args: string[],
  opts: { stdin?: string; timeoutMs: number }
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
      }
    }, opts.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      finished = true;
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    if (opts.stdin) {
      child.stdin.write(opts.stdin);
    }
    child.stdin.end();
  });
}

async function executeRest(request: IntegrationRequest): Promise<IntegrationResult> {
  const started = Date.now();
  const scopedEnv = toObject(toObject(request.input).env);
  let resolvedInput: { value: unknown; secrets: Set<string> };
  try {
    resolvedInput = await resolveRefs(request.input ?? {}, scopedEnv);
  } catch (error) {
    return {
      status: "FAILED",
      executionType: "REST",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Input reference resolution failed",
      policy: { allowed: false, rule: "secret-resolution", reason: "Input reference resolution failed" }
    };
  }
  const input = toObject(resolvedInput.value);
  const integrationConfig = toObject(interpolateUnknown(toObject(input.integrationConfig), scopedEnv));
  const integrationCredentials = toObject(interpolateUnknown(toObject(input.integrationCredentials), scopedEnv));
  const stepInputVariables = toObject(input.stepInputVariables);
  const configuredBaseUrl = String(integrationConfig.baseUrl ?? "").trim();
  const requestedUrl = String(interpolateTemplateText(String(input.url ?? "").trim(), scopedEnv)).trim();
  const commandRef = String(request.commandRef ?? "").trim();
  const urlCandidate = requestedUrl || interpolateTemplateText(commandRef, scopedEnv);
  const url =
    isAbsoluteHttpUrl(urlCandidate) || !configuredBaseUrl
      ? urlCandidate
      : joinUrl(configuredBaseUrl, urlCandidate);

  if (!url) {
    return {
      status: "FAILED",
      executionType: "REST",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: "REST target URL is required via commandRef/url/baseUrl",
      policy: { allowed: false, rule: "rest-url-required", reason: "Missing REST URL" }
    };
  }

  const policy = validateCommandPolicy("REST", url);
  if (!policy.allowed) {
    return {
      status: "FAILED",
      executionType: "REST",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: policy.reason,
      policy
    };
  }
  const method = String(input.method ?? integrationConfig.method ?? "POST").toUpperCase();
  const configHeaders = toObject(integrationConfig.headers);
  const inlineHeaders = toObject(input.headers);
  const credentialHeaders = toObject(integrationCredentials.headers);
  for (const [key, value] of Object.entries(integrationCredentials)) {
    if (key === "headers") continue;
    if (value === undefined || value === null || typeof value === "object") continue;
    credentialHeaders[key] = String(value);
  }
  const headers = mergeHeaders(configHeaders, credentialHeaders, inlineHeaders);
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type") && method !== "GET") {
    headers["content-type"] = "application/json";
  }

  const mergedQuery = new URLSearchParams();
  const configQuery = toObject(integrationConfig.query);
  const inlineQuery = toObject(input.query);
  for (const [key, value] of Object.entries(configQuery)) {
    if (value !== undefined && value !== null) mergedQuery.set(key, String(value));
  }
  for (const [key, value] of Object.entries(inlineQuery)) {
    if (value !== undefined && value !== null) mergedQuery.set(key, String(value));
  }
  if (method === "GET" && !input.query && Object.keys(stepInputVariables).length > 0) {
    for (const [key, value] of Object.entries(stepInputVariables)) {
      if (value !== undefined && value !== null) mergedQuery.set(key, String(value));
    }
  }

  let finalUrl: URL;
  try {
    finalUrl = new URL(url);
  } catch {
    return {
      status: "FAILED",
      executionType: "REST",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: `Invalid REST URL: ${url}`,
      policy: { allowed: false, rule: "rest-url-format", reason: "Invalid REST URL format" }
    };
  }
  for (const [key, value] of mergedQuery.entries()) {
    finalUrl.searchParams.set(key, value);
  }

  const authApplied = await applyRestAuth(integrationConfig.authType ?? "NO_AUTH", integrationCredentials, headers, finalUrl.searchParams);
  if (authApplied.error) {
    return {
      status: "FAILED",
      executionType: "REST",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: authApplied.error,
      policy: { allowed: false, rule: "auth-validation", reason: authApplied.error }
    };
  }
  const effectiveHeaders = authApplied.headers;
  finalUrl.search = authApplied.query.toString();

  const body = input.body ?? integrationConfig.body ?? (method === "GET" ? undefined : stepInputVariables);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutOf(request));
  try {
    const requestInit: RequestInit & { dispatcher?: Agent } = {
      method,
      headers: effectiveHeaders,
      body: method === "GET" ? undefined : body === undefined ? "{}" : JSON.stringify(body),
      dispatcher: authApplied.dispatcher,
      signal: controller.signal
    };
    const response = await fetch(finalUrl, requestInit);
    const text = await response.text();
    const durationMs = Date.now() - started;
    const parsed = text.length > 0 ? JSON.parse(text) : {};
    return {
      status: response.ok ? "SUCCESS" : "FAILED",
      executionType: "REST",
      commandRef: request.commandRef,
      durationMs,
      output: {
        statusCode: response.status,
        body: maskUnknown(parsed, resolvedInput.secrets)
      },
      error: response.ok ? undefined : maskText(`REST call failed with status ${response.status}`, resolvedInput.secrets),
      policy
    };
  } catch (error) {
    return {
      status: "FAILED",
      executionType: "REST",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: error instanceof Error ? maskText(error.message, resolvedInput.secrets) : "REST execution failed",
      policy
    };
  } finally {
    clearTimeout(timer);
    await authApplied.dispatcher?.close().catch(() => undefined);
  }
}

async function executeScript(request: IntegrationRequest): Promise<IntegrationResult> {
  const started = Date.now();
  const policy = validateCommandPolicy("SCRIPT", request.commandRef);
  if (!policy.allowed) {
    return {
      status: "FAILED",
      executionType: "SCRIPT",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: policy.reason,
      policy
    };
  }
  let resolvedInput: { value: unknown; secrets: Set<string> };
  try {
    resolvedInput = await resolveRefs(request.input ?? {}, toObject(toObject(request.input).env));
  } catch (error) {
    return {
      status: "FAILED",
      executionType: "SCRIPT",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Input reference resolution failed",
      policy: { allowed: false, rule: "secret-resolution", reason: "Input reference resolution failed" }
    };
  }
  const result = await runCommand("bash", ["-lc", request.commandRef], {
    stdin: request.input ? JSON.stringify(resolvedInput.value) : undefined,
    timeoutMs: timeoutOf(request)
  });
  return {
    status: result.code === 0 ? "SUCCESS" : "FAILED",
    executionType: "SCRIPT",
    commandRef: request.commandRef,
    durationMs: Date.now() - started,
    output: {
      exitCode: result.code,
      stdout: maskText(result.stdout, resolvedInput.secrets)
    },
    error: result.code === 0 ? undefined : maskText(result.stderr || "Script execution failed", resolvedInput.secrets),
    policy
  };
}

async function executeSsh(request: IntegrationRequest): Promise<IntegrationResult> {
  const started = Date.now();
  const policy = validateCommandPolicy("SSH", request.commandRef);
  if (!policy.allowed) {
    return {
      status: "FAILED",
      executionType: "SSH",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: policy.reason,
      policy
    };
  }
  let resolvedInput: { value: unknown; secrets: Set<string> };
  try {
    resolvedInput = await resolveRefs(request.input ?? {}, toObject(toObject(request.input).env));
  } catch (error) {
    return {
      status: "FAILED",
      executionType: "SSH",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Input reference resolution failed",
      policy: { allowed: false, rule: "secret-resolution", reason: "Input reference resolution failed" }
    };
  }
  const input = toObject(resolvedInput.value);
  const host = String(input.host ?? "");
  const user = String(input.user ?? "root");
  const port = String(input.port ?? "22");
  const identityFile = input.identityFile ? String(input.identityFile) : undefined;

  if (!host) {
    return {
      status: "FAILED",
      executionType: "SSH",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: "SSH input.host is required",
      policy
    };
  }

  const args = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-p",
    port
  ];
  if (identityFile) {
    args.push("-i", identityFile);
  }
  args.push(`${user}@${host}`, request.commandRef);

  const result = await runCommand("ssh", args, { timeoutMs: timeoutOf(request) });
  return {
    status: result.code === 0 ? "SUCCESS" : "FAILED",
    executionType: "SSH",
    commandRef: request.commandRef,
    durationMs: Date.now() - started,
    output: {
      exitCode: result.code,
      stdout: maskText(result.stdout, resolvedInput.secrets)
    },
    error: result.code === 0 ? undefined : maskText(result.stderr || "SSH execution failed", resolvedInput.secrets),
    policy
  };
}

async function executeNetconf(request: IntegrationRequest): Promise<IntegrationResult> {
  const started = Date.now();
  const policy = validateCommandPolicy("NETCONF", request.commandRef);
  if (!policy.allowed) {
    return {
      status: "FAILED",
      executionType: "NETCONF",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: policy.reason,
      policy
    };
  }
  let resolvedInput: { value: unknown; secrets: Set<string> };
  try {
    resolvedInput = await resolveRefs(request.input ?? {}, toObject(toObject(request.input).env));
  } catch (error) {
    return {
      status: "FAILED",
      executionType: "NETCONF",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : "Input reference resolution failed",
      policy: { allowed: false, rule: "secret-resolution", reason: "Input reference resolution failed" }
    };
  }
  const input = toObject(resolvedInput.value);
  const host = String(input.host ?? "");
  const user = String(input.user ?? "root");
  const port = String(input.port ?? "830");

  if (!host) {
    return {
      status: "FAILED",
      executionType: "NETCONF",
      commandRef: request.commandRef,
      durationMs: Date.now() - started,
      error: "NETCONF input.host is required",
      policy
    };
  }

  const args = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-p",
    port,
    `${user}@${host}`,
    "-s",
    "netconf"
  ];

  const payload = `${request.commandRef}\n`;
  const result = await runCommand("ssh", args, { stdin: payload, timeoutMs: timeoutOf(request) });
  return {
    status: result.code === 0 ? "SUCCESS" : "FAILED",
    executionType: "NETCONF",
    commandRef: request.commandRef,
    durationMs: Date.now() - started,
    output: {
      exitCode: result.code,
      response: maskText(result.stdout, resolvedInput.secrets)
    },
    error: result.code === 0 ? undefined : maskText(result.stderr || "NETCONF execution failed", resolvedInput.secrets),
    policy
  };
}

export async function executeIntegration(request: IntegrationRequest): Promise<IntegrationResult> {
  switch (request.executionType) {
    case "REST":
      return executeRest(request);
    case "SCRIPT":
      return executeScript(request);
    case "SSH":
      return executeSsh(request);
    case "NETCONF":
      return executeNetconf(request);
    default:
      return {
        status: "FAILED",
        executionType: request.executionType,
        commandRef: request.commandRef,
        durationMs: 0,
        error: `Unsupported execution type: ${request.executionType}`,
        policy: {
          allowed: false,
          rule: "unsupported-execution-type",
          reason: `Unsupported execution type: ${request.executionType}`
        }
      };
  }
}
