import Fastify from "fastify";
import amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { loadConfig } from "@platform/config";
import { prisma } from "@platform/db";
import {
  PlatformEvents,
  type ExecutionType,
  type IntegrationAuthType,
  type WorkflowNode
} from "@platform/contracts";
import { createCorrelationId } from "@platform/observability";
import { connectAmqp, createTlsRuntime, tlsFetch } from "@platform/tls-runtime";
import { EventPublisher } from "./events.js";

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
const eventPublisher = new EventPublisher(config.rabbitmqUrl, "platform.events", (url) =>
  connectAmqp(tlsRuntime, amqp.connect, url) as Promise<ChannelModel>
);
const WORKFLOW_PUBLISH_AUDIT_QUEUE = "workflow-service.publish-audit.v1";
const EXECUTION_TYPES: ExecutionType[] = ["REST", "SSH", "NETCONF", "SCRIPT"];
const AUTH_TYPES: IntegrationAuthType[] = ["NO_AUTH", "OAUTH2", "BASIC", "MTLS", "API_KEY", "OIDC", "JWT"];
const SENSITIVE_KEY_PATTERN = /(password|token|secret|api[-_]?key|private[-_]?key|client[-_]?secret|authorization|credential|passphrase)/i;
const VAULT_REF_PATTERN = /^vault:[^#\s]+#[^#\s]+$/i;
const VAULT_KV_MOUNT = String(process.env.VAULT_KV_MOUNT ?? "secret").trim() || "secret";
const STRICT_VAULT_ONLY = String(process.env.VAULT_STRICT_SECRETS ?? "true").trim().toLowerCase() !== "false";

type SensitiveIssue = {
  path: string;
  code: "PLAINTEXT_SECRET_BLOCKED" | "ENV_SECRET_REF_BLOCKED" | "VAULT_SECRET_NOT_FOUND";
  message: string;
};

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function requesterUserId(headers: Record<string, unknown>): string {
  return String(headers["x-user-id"] ?? "").trim() || "unknown";
}

function requesterRoles(headers: Record<string, unknown>): string[] {
  const raw = String(headers["x-user-roles"] ?? "");
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAdmin(headers: Record<string, unknown>): boolean {
  return requesterRoles(headers).includes("admin");
}

function toJsonObject(value: unknown): any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

function isVaultRef(value: unknown): boolean {
  return typeof value === "string" && VAULT_REF_PATTERN.test(value.trim());
}

function validateSecretFields(
  value: unknown,
  options: {
    pathPrefix: string;
    allowSensitiveKeys: boolean;
    requireVaultRefForSensitive: boolean;
  },
  path: string[] = []
): SensitiveIssue[] {
  const issues: SensitiveIssue[] = [];
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      issues.push(...validateSecretFields(entry, options, [...path, String(index)]));
    }
    return issues;
  }
  if (!value || typeof value !== "object") {
    return issues;
  }
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const currentPath = [...path, key];
    const pointer = `${options.pathPrefix}.${currentPath.join(".")}`;
    if (typeof entry === "string" && entry.startsWith("env:")) {
      issues.push({
        path: pointer,
        code: "ENV_SECRET_REF_BLOCKED",
        message: `env secret reference is blocked at ${pointer}`
      });
    }
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      if (!options.allowSensitiveKeys) {
        issues.push({
          path: pointer,
          code: "PLAINTEXT_SECRET_BLOCKED",
          message: `sensitive key is not allowed in ${options.pathPrefix}`
        });
      } else if (options.requireVaultRefForSensitive && !isVaultRef(entry)) {
        issues.push({
          path: pointer,
          code: "PLAINTEXT_SECRET_BLOCKED",
          message: `sensitive key must use vault: reference at ${pointer}`
        });
      }
    }
    if (entry && typeof entry === "object") {
      issues.push(...validateSecretFields(entry, options, currentPath));
    }
  }
  return issues;
}

function collectAllVaultRefs(value: unknown, refs: Set<string> = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectAllVaultRefs(item, refs);
    return refs;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectAllVaultRefs(item, refs);
    }
    return refs;
  }
  if (typeof value === "string" && value.startsWith("vault:")) {
    refs.add(value.trim());
  }
  return refs;
}

function requireAdmin(headers: Record<string, unknown>): { allowed: boolean; error?: { error: string } } {
  if (!isAdmin(headers)) {
    return { allowed: false, error: { error: "FORBIDDEN_ADMIN_ONLY" } };
  }
  return { allowed: true };
}

function secretLogicalPath(input: { scope: string; username?: string; group?: string }): string {
  const group = String(input.group ?? "default").trim().replace(/[^a-zA-Z0-9/_-]/g, "_");
  if (input.scope === "global") {
    return `platform/global/${group}`;
  }
  const username = String(input.username ?? "").trim();
  if (!username) {
    throw new Error("USERNAME_REQUIRED_FOR_USER_SCOPE");
  }
  return `platform/users/${username}/${group}`;
}

function secretDataPath(logicalPath: string): string {
  return `${VAULT_KV_MOUNT}/data/${logicalPath}`;
}

function secretMetadataPath(logicalPath: string): string {
  return `${VAULT_KV_MOUNT}/metadata/${logicalPath}`;
}

async function vaultCall(method: string, path: string, body?: Record<string, unknown>): Promise<Response> {
  const response = await fetch(new URL(`/v1/${path}`, process.env.VAULT_ADDR ?? "http://vault:8200"), {
    method,
    headers: {
      "content-type": "application/json",
      ...(process.env.VAULT_NAMESPACE ? { "X-Vault-Namespace": process.env.VAULT_NAMESPACE } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return response;
}

async function readVaultKv(logicalPath: string): Promise<Record<string, unknown>> {
  const response = await vaultCall("GET", secretDataPath(logicalPath));
  if (response.status === 404) return {};
  if (!response.ok) {
    throw new Error(`VAULT_SECRET_NOT_FOUND:${logicalPath}`);
  }
  const payload = (await response.json()) as { data?: { data?: Record<string, unknown> } };
  return payload.data?.data ?? {};
}

async function writeVaultKv(logicalPath: string, data: Record<string, unknown>): Promise<void> {
  const response = await vaultCall("POST", secretDataPath(logicalPath), { data });
  if (!response.ok) {
    throw new Error(`VAULT_WRITE_FAILED:${logicalPath}`);
  }
}

function sanitizeLogicalPath(path: string): string {
  const normalized = String(path ?? "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!normalized.startsWith("platform/")) {
    throw new Error("SECRET_PATH_MUST_START_WITH_PLATFORM");
  }
  return normalized;
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
  if (!response.ok) {
    throw new Error(`VAULT_LIST_FAILED:${prefix}`);
  }
  const payload = (await response.json()) as { data?: { keys?: string[] } };
  return payload.data?.keys ?? [];
}

async function listVaultLeafPaths(prefix: string): Promise<string[]> {
  const children = await listVaultChildren(prefix);
  const output: string[] = [];
  for (const key of children) {
    const next = `${prefix}/${key}`.replace(/\/+/g, "/");
    if (key.endsWith("/")) {
      const nested = await listVaultLeafPaths(next.replace(/\/+$/, ""));
      output.push(...nested);
    } else {
      output.push(next);
    }
  }
  return output;
}

async function vaultRefExists(ref: string): Promise<boolean> {
  if (!isVaultRef(ref)) return false;
  const raw = ref.slice("vault:".length);
  const [path, field] = raw.split("#");
  if (!path || !field) return false;
  const response = await vaultCall("GET", path);
  if (!response.ok) return false;
  const payload = (await response.json()) as { data?: { data?: Record<string, unknown> } & Record<string, unknown> };
  const kv2 = payload.data?.data?.[field];
  const kv1 = (payload.data as Record<string, unknown> | undefined)?.[field];
  return kv2 !== undefined || kv1 !== undefined;
}

async function enforceStrictSecretPolicy(): Promise<void> {
  if (!STRICT_VAULT_ONLY) return;
  const [integrations, environments] = await Promise.all([
    prisma.integrationProfile.findMany({ select: { id: true, credentialJson: true } }),
    prisma.userEnvironment.findMany({ select: { id: true, variablesJson: true } })
  ]);
  const violations: string[] = [];
  for (const integration of integrations) {
    const issues = validateSecretFields(integration.credentialJson, {
      pathPrefix: `integration:${integration.id}.credentials`,
      allowSensitiveKeys: true,
      requireVaultRefForSensitive: true
    });
    violations.push(...issues.map((entry) => `${entry.code}:${entry.path}`));
  }
  for (const environment of environments) {
    const issues = validateSecretFields(environment.variablesJson, {
      pathPrefix: `environment:${environment.id}.variables`,
      allowSensitiveKeys: false,
      requireVaultRefForSensitive: false
    });
    violations.push(...issues.map((entry) => `${entry.code}:${entry.path}`));
  }
  if (violations.length > 0) {
    throw new Error(`STRICT_VAULT_ONLY_POLICY_VIOLATIONS:${violations.slice(0, 20).join(",")}`);
  }
}

function normalizeExecutionType(value: unknown): ExecutionType | undefined {
  const normalized = String(value ?? "").trim().toUpperCase();
  return EXECUTION_TYPES.find((entry) => entry === normalized as ExecutionType);
}

function normalizeAuthType(value: unknown): IntegrationAuthType | undefined {
  const normalized = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "_");
  return AUTH_TYPES.find((entry) => entry === normalized as IntegrationAuthType);
}

function parseScope(value: unknown): "owned" | "shared" | "all" {
  const scope = String(value ?? "owned").trim().toLowerCase();
  if (scope === "shared" || scope === "all") return scope;
  return "owned";
}

function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    output.push(item);
  }
  return output;
}

function toNodeArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => entry && typeof entry === "object") as Array<Record<string, unknown>>;
}

function integrationIdUsedInNodes(nodes: unknown, integrationId: string): boolean {
  return toNodeArray(nodes).some((node) => String(node.integrationProfileId ?? "").trim() === integrationId);
}

function environmentIdUsedInNodes(nodes: unknown, environmentId: string): boolean {
  return toNodeArray(nodes).some((node) => String(node.environmentId ?? "").trim() === environmentId);
}

async function findIntegrationWorkflowUsage(integrationId: string): Promise<
  Array<{
    workflowId: string;
    workflowName: string;
    workflowVersionId: string;
    version: number;
    status: string;
  }>
> {
  const versions = await prisma.workflowVersion.findMany({
    include: { workflow: true },
    orderBy: [{ createdAt: "desc" }]
  });
  const usage = versions
    .filter((version) => integrationIdUsedInNodes(version.nodesJson, integrationId))
    .map((version) => ({
      workflowId: version.workflowId,
      workflowName: version.workflow.name,
      workflowVersionId: version.id,
      version: version.version,
      status: version.status
    }));
  return uniqueById(usage.map((entry) => ({ ...entry, id: `${entry.workflowVersionId}` }))).map(({ id: _id, ...rest }) => rest);
}

async function findEnvironmentWorkflowUsage(environmentId: string): Promise<
  Array<{
    workflowId: string;
    workflowName: string;
    workflowVersionId: string;
    version: number;
    status: string;
  }>
> {
  const versions = await prisma.workflowVersion.findMany({
    include: { workflow: true },
    orderBy: [{ createdAt: "desc" }]
  });
  const usage = versions
    .filter((version) => environmentIdUsedInNodes(version.nodesJson, environmentId))
    .map((version) => ({
      workflowId: version.workflowId,
      workflowName: version.workflow.name,
      workflowVersionId: version.id,
      version: version.version,
      status: version.status
    }));
  return uniqueById(usage.map((entry) => ({ ...entry, id: `${entry.workflowVersionId}` }))).map(({ id: _id, ...rest }) => rest);
}

async function loadIntegrationWithAccess(integrationId: string, requester: string, admin: boolean) {
  const integration = await prisma.integrationProfile.findUnique({
    where: { id: integrationId },
    include: { shares: true }
  });
  if (!integration) return { integration: null, owner: false, shared: false, allowed: false };
  const owner = integration.ownerId === requester;
  const shared = integration.shares.some((entry) => entry.sharedWithUserId === requester);
  const allowed = admin || owner || shared;
  return { integration, owner, shared, allowed };
}

async function loadEnvironmentWithAccess(environmentId: string, requester: string, admin: boolean) {
  const environment = await prisma.userEnvironment.findUnique({
    where: { id: environmentId },
    include: { shares: true }
  });
  if (!environment) return { environment: null, owner: false, shared: false, allowed: false };
  const owner = environment.ownerId === requester;
  const shared = environment.shares.some((entry) => entry.sharedWithUserId === requester);
  const allowed = admin || owner || shared;
  return { environment, owner, shared, allowed };
}

function toIntegrationResponse(
  integration: {
    id: string;
    name: string;
    ownerId: string;
    executionType: string;
    authType: string;
    lifecycleState: string;
    baseConfigJson: unknown;
    credentialJson: unknown;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
    shares?: Array<{ sharedWithUserId: string }>;
  },
  requester: string,
  admin: boolean
): Record<string, unknown> {
  const access = admin ? "ADMIN" : integration.ownerId === requester ? "OWNER" : "SHARED";
  return {
    ...integration,
    baseConfigJson: integration.baseConfigJson ?? {},
    credentialJson: integration.credentialJson ?? {},
    access,
    sharedWithUsers: (integration.shares ?? []).map((entry) => entry.sharedWithUserId)
  };
}

function toEnvironmentResponse(
  environment: {
    id: string;
    name: string;
    ownerId: string;
    variablesJson: unknown;
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
    shares?: Array<{ sharedWithUserId: string }>;
  },
  requester: string,
  admin: boolean
): Record<string, unknown> {
  const access = admin ? "ADMIN" : environment.ownerId === requester ? "OWNER" : "SHARED";
  return {
    ...environment,
    variablesJson: environment.variablesJson ?? {},
    access,
    sharedWithUsers: (environment.shares ?? []).map((entry) => entry.sharedWithUserId)
  };
}

async function startPublishAuditWorker(): Promise<{ connection: ChannelModel; channel: Channel } | undefined> {
  try {
    const connection = (await connectAmqp(tlsRuntime, amqp.connect, config.rabbitmqUrl)) as ChannelModel;
    const channel = await connection.createChannel();
    await channel.assertExchange("platform.events", "topic", { durable: true });
    await channel.assertQueue(WORKFLOW_PUBLISH_AUDIT_QUEUE, { durable: true });
    await channel.bindQueue(WORKFLOW_PUBLISH_AUDIT_QUEUE, "platform.events", PlatformEvents.workflowPublished);
    await channel.consume(
      WORKFLOW_PUBLISH_AUDIT_QUEUE,
      async (message: ConsumeMessage | null) => {
        if (!message) return;
        try {
          const decoded = tryParseJson(message.content.toString("utf8")) as
            | {
                event?: string;
                timestamp?: string;
                payload?: {
                  workflowId?: string;
                  workflowVersionId?: string;
                  version?: number;
                  correlationId?: string;
                };
              }
            | undefined;

          if (!decoded?.payload?.workflowId || !decoded.payload.workflowVersionId || typeof decoded.payload.version !== "number") {
            channel.ack(message);
            return;
          }

          await prisma.workflowPublishAudit.upsert({
            where: { workflowVersionId: decoded.payload.workflowVersionId },
            create: {
              workflowId: decoded.payload.workflowId,
              workflowVersionId: decoded.payload.workflowVersionId,
              version: decoded.payload.version,
              correlationId: decoded.payload.correlationId,
              eventTimestamp: decoded.timestamp ? new Date(decoded.timestamp) : undefined,
              status: "PROCESSED",
              processedAt: new Date()
            },
            update: {
              correlationId: decoded.payload.correlationId,
              eventTimestamp: decoded.timestamp ? new Date(decoded.timestamp) : undefined,
              status: "PROCESSED",
              errorMessage: null,
              processedAt: new Date()
            }
          });
          channel.ack(message);
        } catch (error) {
          console.warn("[workflow-service] publish-audit worker failed", error instanceof Error ? error.message : String(error));
          channel.nack(message, false, true);
        }
      },
      { noAck: false }
    );
    return { connection, channel };
  } catch (error) {
    console.warn("[workflow-service] publish-audit worker disabled", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

app.get("/health", async () => ({ ok: true, service: config.serviceName }));

app.get("/security/tls", async (request, reply) => {
  const token = String(request.headers["x-security-token"] ?? "");
  if (tlsRuntime.diagnosticsToken && token !== tlsRuntime.diagnosticsToken) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
  return tlsRuntime.getStatus();
});

app.post("/workflows", async (request, reply) => {
  const body = request.body as { name: string; description?: string; nodes?: WorkflowNode[] };
  const workflow = await prisma.workflow.create({
    data: {
      name: body.name,
      description: body.description
    }
  });

  const version = await prisma.workflowVersion.create({
    data: {
      workflowId: workflow.id,
      version: 1,
      status: "DRAFT",
      nodesJson: JSON.parse(JSON.stringify(body.nodes ?? []))
    }
  });

  await prisma.workflow.update({
    where: { id: workflow.id },
    data: { latestVersionId: version.id }
  });

  reply.code(201).send({ workflow, version });
});

app.get("/workflows", async () => prisma.workflow.findMany({ orderBy: { createdAt: "desc" } }));

app.get("/workflows/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const workflow = await prisma.workflow.findUnique({ where: { id } });
  if (!workflow) {
    return reply.code(404).send({ error: "WORKFLOW_NOT_FOUND" });
  }
  const versions = await prisma.workflowVersion.findMany({ where: { workflowId: id }, orderBy: { version: "desc" } });
  return { workflow, versions };
});

app.post("/workflows/:id/publish", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const correlationId = String(request.headers["x-correlation-id"] ?? createCorrelationId("workflow-publish"));
  const latest = await prisma.workflowVersion.findFirst({
    where: { workflowId: id },
    orderBy: { version: "desc" }
  });
  if (!latest) {
    return reply.code(404).send({ error: "WORKFLOW_VERSION_NOT_FOUND" });
  }
  const published = await prisma.workflowVersion.update({
    where: { id: latest.id },
    data: { status: "PUBLISHED" }
  });

  await eventPublisher.publish(PlatformEvents.workflowPublished, {
    workflowId: id,
    workflowVersionId: published.id,
    version: published.version,
    status: published.status,
    correlationId
  });

  return { event: PlatformEvents.workflowPublished, version: published, correlationId };
});

app.get("/workflows/:id/publish-audits", async (request) => {
  const id = (request.params as { id: string }).id;
  return prisma.workflowPublishAudit.findMany({
    where: { workflowId: id },
    orderBy: { createdAt: "desc" },
    take: 100
  });
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
    const updatedAt = metadataPayload.data?.updated_time;
    const version = metadataPayload.data?.current_version ?? 0;
    return {
      scope: String(query.scope ?? "global").trim().toLowerCase(),
      username: query.username ?? null,
      group: query.group ?? "default",
      path: logicalPath,
      secrets: Object.keys(dataPayload).map((key) => ({
        key,
        value: "***",
        version,
        updatedAt: updatedAt ?? null
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
    const integrationMap = new Map(
      (
        await prisma.integrationProfile.findMany({
          select: { id: true, name: true, ownerId: true }
        })
      ).map((entry) => [entry.id, entry])
    );
    const environmentMap = new Map(
      (
        await prisma.userEnvironment.findMany({
          select: { id: true, name: true, ownerId: true }
        })
      ).map((entry) => [entry.id, entry])
    );

    function enrichPathMeta(path: string): {
      purpose: string;
      ownerId: string | null;
      resourceType: string;
      resourceId: string | null;
      resourceName: string | null;
      workflowCount: number | null;
    } {
      const integrationMatch = path.match(/^platform\/users\/([^/]+)\/integration\/([^/]+)$/);
      if (integrationMatch) {
        const [, ownerId, integrationId] = integrationMatch;
        const integration = integrationMap.get(integrationId);
        return {
          purpose: "Integration Credential",
          ownerId,
          resourceType: "integration",
          resourceId: integrationId,
          resourceName: integration?.name ?? null,
          workflowCount: null
        };
      }
      const environmentMatch = path.match(/^platform\/users\/([^/]+)\/environment\/([^/]+)$/);
      if (environmentMatch) {
        const [, ownerId, environmentId] = environmentMatch;
        const environment = environmentMap.get(environmentId);
        return {
          purpose: "Environment Secret Backup",
          ownerId,
          resourceType: "environment",
          resourceId: environmentId,
          resourceName: environment?.name ?? null,
          workflowCount: null
        };
      }
      if (path.startsWith("platform/global/")) {
        return {
          purpose: "Global Shared Secret",
          ownerId: null,
          resourceType: "global",
          resourceId: null,
          resourceName: null,
          workflowCount: null
        };
      }
      return {
        purpose: "Platform Secret",
        ownerId: null,
        resourceType: "other",
        resourceId: null,
        resourceName: null,
        workflowCount: null
      };
    }

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
      workflowCount: number | null;
    }> = [];
    for (const path of paths) {
      const [data, metadata] = await Promise.all([readVaultKv(path), readVaultKvMetadata(path)]);
      const meta = enrichPathMeta(path);
      let workflowCount = meta.workflowCount;
      if (meta.resourceType === "integration" && meta.resourceId) {
        workflowCount = (await findIntegrationWorkflowUsage(meta.resourceId)).length;
      } else if (meta.resourceType === "environment" && meta.resourceId) {
        workflowCount = (await findEnvironmentWorkflowUsage(meta.resourceId)).length;
      }
      for (const key of Object.keys(data).sort()) {
        items.push({
          path,
          key,
          value: "***",
          version: metadata.version,
          updatedAt: metadata.updatedAt,
          purpose: meta.purpose,
          ownerId: meta.ownerId,
          resourceType: meta.resourceType,
          resourceId: meta.resourceId,
          resourceName: meta.resourceName,
          workflowCount
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
  const value = String(body.value ?? "");
  if (!key) return reply.code(400).send({ error: "SECRET_KEY_REQUIRED" });
  try {
    const data = await readVaultKv(path);
    data[key] = value;
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
  const value = String(body.value ?? "");
  if (!key) return reply.code(400).send({ error: "SECRET_KEY_REQUIRED" });
  try {
    const data = await readVaultKv(path);
    if (!(key in data)) {
      return reply.code(404).send({ error: "VAULT_SECRET_NOT_FOUND", details: key });
    }
    data[key] = value;
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
      if (!response.ok && response.status !== 404) {
        return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: path });
      }
      return { deleted: true, path };
    }
    const data = await readVaultKv(path);
    if (!(key in data)) {
      return reply.code(404).send({ error: "VAULT_SECRET_NOT_FOUND", details: key });
    }
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
  const value = String(body.value ?? "");
  try {
    const logicalPath = secretLogicalPath({
      scope: String(body.scope ?? "global").trim().toLowerCase(),
      username: body.username,
      group: body.group
    });
    const existing = await readVaultKv(logicalPath);
    existing[key] = value;
    await writeVaultKv(logicalPath, existing);
    return reply.code(201).send({
      scope: String(body.scope ?? "global").trim().toLowerCase(),
      username: body.username ?? null,
      group: body.group ?? "default",
      path: logicalPath,
      key,
      value: "***",
      updatedAt: new Date().toISOString()
    });
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
  const value = String(body.value ?? "");
  try {
    const logicalPath = secretLogicalPath({
      scope: String(body.scope ?? "global").trim().toLowerCase(),
      username: body.username,
      group: body.group
    });
    const existing = await readVaultKv(logicalPath);
    if (!(key in existing)) {
      return reply.code(404).send({ error: "VAULT_SECRET_NOT_FOUND", details: key });
    }
    existing[key] = value;
    await writeVaultKv(logicalPath, existing);
    return {
      scope: String(body.scope ?? "global").trim().toLowerCase(),
      username: body.username ?? null,
      group: body.group ?? "default",
      path: logicalPath,
      key,
      value: "***",
      updatedAt: new Date().toISOString()
    };
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
      if (!response.ok && response.status !== 404) {
        return reply.code(400).send({ error: "VAULT_WRITE_FAILED", details: logicalPath });
      }
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

app.get("/admin/secrets/usage", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const query = request.query as { ref?: string };
  const ref = String(query.ref ?? "").trim();
  if (!ref) return reply.code(400).send({ error: "SECRET_REF_REQUIRED" });
  const [integrations, environments, versions] = await Promise.all([
    prisma.integrationProfile.findMany({ select: { id: true, name: true, ownerId: true, credentialJson: true } }),
    prisma.userEnvironment.findMany({ select: { id: true, name: true, ownerId: true, variablesJson: true } }),
    prisma.workflowVersion.findMany({ select: { id: true, workflowId: true, version: true, nodesJson: true } })
  ]);
  const inIntegrations = integrations.filter((entry) => JSON.stringify(entry.credentialJson ?? {}).includes(ref));
  const inEnvironments = environments.filter((entry) => JSON.stringify(entry.variablesJson ?? {}).includes(ref));
  const inWorkflows = versions.filter((entry) => JSON.stringify(entry.nodesJson ?? {}).includes(ref));
  return {
    ref,
    usage: {
      integrations: inIntegrations.map((entry) => ({ id: entry.id, name: entry.name, ownerId: entry.ownerId })),
      environments: inEnvironments.map((entry) => ({ id: entry.id, name: entry.name, ownerId: entry.ownerId })),
      workflows: inWorkflows.map((entry) => ({ id: entry.id, workflowId: entry.workflowId, version: entry.version }))
    }
  };
});

app.post("/admin/secrets/migrate", async (request, reply) => {
  const auth = requireAdmin(request.headers as Record<string, unknown>);
  if (!auth.allowed) return reply.code(403).send(auth.error);
  const migrationId = `mig_${Date.now()}`;
  const report: {
    migrationId: string;
    converted: number;
    skipped: number;
    failed: number;
    rollbackMap: Array<{ entityType: string; entityId: string; path: string; vaultRef: string; backupRef: string }>;
    errors: Array<{ entityType: string; entityId: string; path: string; error: string }>;
  } = { migrationId, converted: 0, skipped: 0, failed: 0, rollbackMap: [], errors: [] };

  function pathKey(path: string[]): string {
    return path.join("_").replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  }

  async function migrateObjectSecrets(input: {
    entityType: "integration" | "environment";
    entityId: string;
    ownerId: string;
    object: Record<string, unknown>;
    disallowSensitive: boolean;
  }): Promise<Record<string, unknown>> {
    const clone = JSON.parse(JSON.stringify(input.object)) as Record<string, unknown>;
    async function visit(node: unknown, path: string[]): Promise<void> {
      if (!node || typeof node !== "object") return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        const nextPath = [...path, key];
        if (value && typeof value === "object") {
          await visit(value, nextPath);
          continue;
        }
        if (!SENSITIVE_KEY_PATTERN.test(key)) continue;
        if (typeof value !== "string" || value.length === 0) {
          report.skipped += 1;
          continue;
        }
        if (value.startsWith("vault:")) {
          report.skipped += 1;
          continue;
        }
        if (value.startsWith("env:")) {
          report.failed += 1;
          report.errors.push({
            entityType: input.entityType,
            entityId: input.entityId,
            path: nextPath.join("."),
            error: "ENV_SECRET_REF_BLOCKED"
          });
          continue;
        }
        if (input.disallowSensitive) {
          report.failed += 1;
          report.errors.push({
            entityType: input.entityType,
            entityId: input.entityId,
            path: nextPath.join("."),
            error: "PLAINTEXT_SECRET_BLOCKED"
          });
          continue;
        }
        const targetLogicalPath = `platform/users/${input.ownerId}/${input.entityType}/${input.entityId}`;
        const backupLogicalPath = `platform/global/migration-backup/${migrationId}/${input.entityType}/${input.entityId}`;
        const keyName = pathKey(nextPath);
        const target = await readVaultKv(targetLogicalPath);
        target[keyName] = value;
        await writeVaultKv(targetLogicalPath, target);
        const backup = await readVaultKv(backupLogicalPath);
        backup[keyName] = value;
        await writeVaultKv(backupLogicalPath, backup);
        (node as Record<string, unknown>)[key] = `vault:${secretDataPath(targetLogicalPath)}#${keyName}`;
        report.converted += 1;
        report.rollbackMap.push({
          entityType: input.entityType,
          entityId: input.entityId,
          path: nextPath.join("."),
          vaultRef: `vault:${secretDataPath(targetLogicalPath)}#${keyName}`,
          backupRef: `vault:${secretDataPath(backupLogicalPath)}#${keyName}`
        });
      }
    }
    await visit(clone, []);
    return clone;
  }

  const [integrations, environments] = await Promise.all([
    prisma.integrationProfile.findMany({ select: { id: true, ownerId: true, credentialJson: true } }),
    prisma.userEnvironment.findMany({ select: { id: true, ownerId: true, variablesJson: true } })
  ]);

  for (const integration of integrations) {
    try {
      const next = await migrateObjectSecrets({
        entityType: "integration",
        entityId: integration.id,
        ownerId: integration.ownerId,
        object: toJsonObject(integration.credentialJson),
        disallowSensitive: false
      });
      await prisma.integrationProfile.update({
        where: { id: integration.id },
        data: { credentialJson: next as any }
      });
    } catch (error) {
      report.failed += 1;
      report.errors.push({
        entityType: "integration",
        entityId: integration.id,
        path: "credentialJson",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  for (const environment of environments) {
    try {
      await migrateObjectSecrets({
        entityType: "environment",
        entityId: environment.id,
        ownerId: environment.ownerId,
        object: toJsonObject(environment.variablesJson),
        disallowSensitive: true
      });
    } catch (error) {
      report.failed += 1;
      report.errors.push({
        entityType: "environment",
        entityId: environment.id,
        path: "variablesJson",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return report;
});

app.post("/integrations", async (request, reply) => {
  const body = (request.body ?? {}) as {
    name?: string;
    ownerId?: string;
    executionType?: ExecutionType;
    authType?: IntegrationAuthType;
    baseConfig?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  };
  const name = String(body.name ?? "").trim();
  if (!name) {
    return reply.code(400).send({ error: "INTEGRATION_NAME_REQUIRED" });
  }

  const executionType = normalizeExecutionType(body.executionType);
  if (!executionType) {
    return reply.code(400).send({ error: "INTEGRATION_EXECUTION_TYPE_INVALID" });
  }

  const authType = normalizeAuthType(body.authType ?? "API_KEY");
  if (!authType) {
    return reply.code(400).send({ error: "INTEGRATION_AUTH_TYPE_INVALID" });
  }
  const credentialObject = toJsonObject(body.credentials);
  const credentialIssues = validateSecretFields(credentialObject, {
    pathPrefix: "integration.credentials",
    allowSensitiveKeys: true,
    requireVaultRefForSensitive: true
  });
  if (credentialIssues.length > 0) {
    return reply.code(400).send({ error: credentialIssues[0].code, details: credentialIssues[0].message, issues: credentialIssues });
  }
  const refs = [...collectAllVaultRefs(credentialObject)];
  for (const ref of refs) {
    const exists = await vaultRefExists(ref);
    if (!exists) {
      return reply.code(400).send({ error: "VAULT_SECRET_NOT_FOUND", details: ref });
    }
  }

  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const ownerId = String(body.ownerId ?? requester).trim() || requester;
  if (ownerId !== requester && !isAdmin(request.headers as Record<string, unknown>)) {
    return reply.code(403).send({ error: "FORBIDDEN_OWNER_OVERRIDE" });
  }

  const integration = await prisma.integrationProfile.create({
    data: {
      name,
      ownerId,
      executionType,
      authType,
      lifecycleState: "ACTIVE",
      isActive: true,
      baseConfigJson: toJsonObject(body.baseConfig),
      credentialJson: credentialObject
    },
    include: { shares: true }
  });

  return reply.code(201).send(toIntegrationResponse(integration, requester, isAdmin(request.headers as Record<string, unknown>)));
});

app.get("/integrations", async (request) => {
  const query = request.query as { ownerId?: string; includeAll?: string; limit?: string; scope?: string };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const includeAll = query.includeAll === "true";
  const requestedOwner = String(query.ownerId ?? "").trim();
  const ownerId = admin ? requestedOwner || requester : requester;
  const scope = parseScope(query.scope);
  const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);

  if (includeAll && admin) {
    const all = await prisma.integrationProfile.findMany({
      include: { shares: true },
      orderBy: [{ updatedAt: "desc" }],
      take: limit
    });
    return all.map((integration) => toIntegrationResponse(integration, requester, admin));
  }

  if (scope === "shared") {
    const shared = await prisma.integrationShare.findMany({
      where: { sharedWithUserId: requester },
      include: { integration: { include: { shares: true } } },
      orderBy: [{ createdAt: "desc" }],
      take: limit
    });
    return shared.map((entry) => toIntegrationResponse(entry.integration, requester, admin));
  }

  if (scope === "all") {
    const [owned, shared] = await Promise.all([
      prisma.integrationProfile.findMany({
        where: { ownerId },
        include: { shares: true },
        orderBy: [{ updatedAt: "desc" }],
        take: limit
      }),
      prisma.integrationShare.findMany({
        where: { sharedWithUserId: requester },
        include: { integration: { include: { shares: true } } },
        orderBy: [{ createdAt: "desc" }],
        take: limit
      })
    ]);
    const merged = uniqueById([...owned, ...shared.map((entry) => entry.integration)]).slice(0, limit);
    return merged.map((integration) => toIntegrationResponse(integration, requester, admin));
  }

  const owned = await prisma.integrationProfile.findMany({
    where: { ownerId },
    include: { shares: true },
    orderBy: [{ updatedAt: "desc" }],
    take: limit
  });
  return owned.map((integration) => toIntegrationResponse(integration, requester, admin));
});

app.get("/integrations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) {
    return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  }
  if (!access.allowed) {
    return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_ACCESS" });
  }
  return toIntegrationResponse(access.integration, requester, admin);
});

app.patch("/integrations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as {
    name?: string;
    executionType?: ExecutionType;
    authType?: IntegrationAuthType;
    baseConfig?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_MUTATION" });

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return reply.code(400).send({ error: "INTEGRATION_NAME_REQUIRED" });
    data.name = name;
  }
  if (body.executionType !== undefined) {
    const executionType = normalizeExecutionType(body.executionType);
    if (!executionType) return reply.code(400).send({ error: "INTEGRATION_EXECUTION_TYPE_INVALID" });
    data.executionType = executionType;
  }
  if (body.authType !== undefined) {
    const authType = normalizeAuthType(body.authType);
    if (!authType) return reply.code(400).send({ error: "INTEGRATION_AUTH_TYPE_INVALID" });
    data.authType = authType;
  }
  if (body.baseConfig !== undefined) data.baseConfigJson = toJsonObject(body.baseConfig);
  if (body.credentials !== undefined) {
    const credentialObject = toJsonObject(body.credentials);
    const credentialIssues = validateSecretFields(credentialObject, {
      pathPrefix: "integration.credentials",
      allowSensitiveKeys: true,
      requireVaultRefForSensitive: true
    });
    if (credentialIssues.length > 0) {
      return reply.code(400).send({ error: credentialIssues[0].code, details: credentialIssues[0].message, issues: credentialIssues });
    }
    const refs = [...collectAllVaultRefs(credentialObject)];
    for (const ref of refs) {
      const exists = await vaultRefExists(ref);
      if (!exists) {
        return reply.code(400).send({ error: "VAULT_SECRET_NOT_FOUND", details: ref });
      }
    }
    data.credentialJson = credentialObject;
  }

  const updated = await prisma.integrationProfile.update({
    where: { id },
    data,
    include: { shares: true }
  });
  return toIntegrationResponse(updated, requester, admin);
});

app.get("/integrations/:id/shares", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.allowed) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_ACCESS" });
  return access.integration.shares.map((entry) => ({
    username: entry.sharedWithUserId,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt
  }));
});

app.post("/integrations/:id/share", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as { username?: string };
  const username = String(body.username ?? "").trim();
  if (!username) {
    return reply.code(400).send({ error: "SHARE_USERNAME_REQUIRED" });
  }
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_SHARE" });
  if (username === access.integration.ownerId) {
    return reply.code(400).send({ error: "OWNER_ALREADY_HAS_ACCESS" });
  }
  await prisma.integrationShare.upsert({
    where: { integrationId_sharedWithUserId: { integrationId: id, sharedWithUserId: username } },
    create: {
      integrationId: id,
      sharedWithUserId: username,
      createdBy: requester
    },
    update: {}
  });
  const updated = await prisma.integrationProfile.findUnique({
    where: { id },
    include: { shares: true }
  });
  return toIntegrationResponse(updated!, requester, admin);
});

app.delete("/integrations/:id/share/:username", async (request, reply) => {
  const params = request.params as { id: string; username: string };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(params.id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_SHARE" });
  await prisma.integrationShare.deleteMany({
    where: {
      integrationId: params.id,
      sharedWithUserId: params.username
    }
  });
  const updated = await prisma.integrationProfile.findUnique({
    where: { id: params.id },
    include: { shares: true }
  });
  return toIntegrationResponse(updated!, requester, admin);
});

app.post("/integrations/:id/duplicate", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as { name?: string };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.allowed) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_ACCESS" });
  const name = String(body.name ?? `${access.integration.name} Copy`).trim();
  if (!name) return reply.code(400).send({ error: "INTEGRATION_NAME_REQUIRED" });
  const copy = await prisma.integrationProfile.create({
    data: {
      name,
      ownerId: requester,
      executionType: access.integration.executionType,
      authType: access.integration.authType,
      lifecycleState: "ACTIVE",
      isActive: true,
      baseConfigJson: toJsonObject(access.integration.baseConfigJson),
      credentialJson: toJsonObject(access.integration.credentialJson)
    },
    include: { shares: true }
  });
  return reply.code(201).send(toIntegrationResponse(copy, requester, admin));
});

app.get("/integrations/:id/usage", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.allowed) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_ACCESS" });
  const workflows = await findIntegrationWorkflowUsage(id);
  return { integrationId: id, inUse: workflows.length > 0, workflows };
});

app.post("/integrations/:id/activate", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_LCM" });
  const updated = await prisma.integrationProfile.update({
    where: { id },
    data: { lifecycleState: "ACTIVE", isActive: true },
    include: { shares: true }
  });
  return toIntegrationResponse(updated, requester, admin);
});

app.post("/integrations/:id/deactivate", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_LCM" });
  const workflows = await findIntegrationWorkflowUsage(id);
  if (workflows.length > 0) {
    return reply.code(409).send({
      error: "INTEGRATION_IN_USE",
      warning: "This integration is currently referenced by workflows and cannot be deactivated.",
      workflows
    });
  }
  const updated = await prisma.integrationProfile.update({
    where: { id },
    data: { lifecycleState: "INACTIVE", isActive: false },
    include: { shares: true }
  });
  return toIntegrationResponse(updated, requester, admin);
});

app.delete("/integrations/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_LCM" });
  const workflows = await findIntegrationWorkflowUsage(id);
  if (workflows.length > 0) {
    return reply.code(409).send({
      error: "INTEGRATION_IN_USE",
      warning: "This integration is currently referenced by workflows and cannot be terminated.",
      workflows
    });
  }
  await prisma.integrationProfile.delete({ where: { id } });
  return { deleted: true, integrationId: id };
});

app.post("/integrations/:id/test", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as {
    commandRef?: string;
    timeoutMs?: number;
    input?: Record<string, unknown>;
    environmentId?: string;
  };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadIntegrationWithAccess(id, requester, admin);
  if (!access.integration) return reply.code(404).send({ error: "INTEGRATION_NOT_FOUND" });
  if (!access.allowed) return reply.code(403).send({ error: "FORBIDDEN_INTEGRATION_ACCESS" });
  if (!access.integration.isActive) {
    return reply.code(400).send({ error: "INTEGRATION_NOT_ACTIVE" });
  }

  let environmentVariables: Record<string, unknown> = {};
  if (body.environmentId) {
    const envAccess = await loadEnvironmentWithAccess(body.environmentId, requester, admin);
    if (!envAccess.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
    if (!envAccess.allowed) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_ACCESS" });
    environmentVariables = toJsonObject(envAccess.environment.variablesJson);
  }

  const baseConfig = toJsonObject(access.integration.baseConfigJson);
  const credentials = toJsonObject(access.integration.credentialJson);
  const commandRef =
    String(body.commandRef ?? "").trim() ||
    String(baseConfig.healthPath ?? "").trim() ||
    String(baseConfig.path ?? "").trim() ||
    String(baseConfig.url ?? "").trim() ||
    String(baseConfig.baseUrl ?? "").trim();
  if (!commandRef) {
    return reply.code(400).send({ error: "INTEGRATION_TEST_COMMAND_REQUIRED" });
  }

  try {
    const upstream = await tlsFetch(tlsRuntime, new URL("/integrations/execute", config.integrationServiceUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        executionType: access.integration.executionType,
        commandRef,
        timeoutMs: body.timeoutMs,
        input: {
          ...(toJsonObject(body.input) ?? {}),
          env: environmentVariables,
          integrationConfig: {
            ...baseConfig,
            authType: access.integration.authType
          },
          integrationCredentials: credentials
        }
      })
    });
    const raw = await upstream.text();
    const payload = raw.length > 0 ? JSON.parse(raw) : {};
    const ok = upstream.ok && String(payload.status ?? "") === "SUCCESS";
    return {
      ok,
      integrationId: id,
      testedAt: new Date().toISOString(),
      result: payload
    };
  } catch (error) {
    return reply.code(502).send({
      error: "INTEGRATION_TEST_FAILED",
      details: error instanceof Error ? error.message : "Unknown integration test failure"
    });
  }
});

app.post("/environments", async (request, reply) => {
  const body = (request.body ?? {}) as {
    name?: string;
    ownerId?: string;
    variables?: Record<string, unknown>;
    isDefault?: boolean;
  };
  const name = String(body.name ?? "").trim();
  if (!name) {
    return reply.code(400).send({ error: "ENVIRONMENT_NAME_REQUIRED" });
  }

  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const ownerId = String(body.ownerId ?? requester).trim() || requester;
  if (ownerId !== requester && !isAdmin(request.headers as Record<string, unknown>)) {
    return reply.code(403).send({ error: "FORBIDDEN_OWNER_OVERRIDE" });
  }

  if (body.isDefault) {
    await prisma.userEnvironment.updateMany({
      where: { ownerId },
      data: { isDefault: false }
    });
  }
  const variablesObject = toJsonObject(body.variables);
  const variableIssues = validateSecretFields(variablesObject, {
    pathPrefix: "environment.variables",
    allowSensitiveKeys: false,
    requireVaultRefForSensitive: false
  });
  if (variableIssues.length > 0) {
    return reply.code(400).send({ error: variableIssues[0].code, details: variableIssues[0].message, issues: variableIssues });
  }

  const environment = await prisma.userEnvironment.create({
    data: {
      name,
      ownerId,
      variablesJson: variablesObject,
      isDefault: Boolean(body.isDefault)
    },
    include: { shares: true }
  });

  return reply.code(201).send(toEnvironmentResponse(environment, requester, isAdmin(request.headers as Record<string, unknown>)));
});

app.get("/environments", async (request) => {
  const query = request.query as { ownerId?: string; includeAll?: string; limit?: string; scope?: string };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const includeAll = query.includeAll === "true";
  const requestedOwner = String(query.ownerId ?? "").trim();
  const ownerId = admin ? requestedOwner || requester : requester;
  const scope = parseScope(query.scope);
  const limit = Math.min(Math.max(Number(query.limit ?? 100) || 100, 1), 500);

  if (includeAll && admin) {
    const all = await prisma.userEnvironment.findMany({
      include: { shares: true },
      orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
      take: limit
    });
    return all.map((entry) => toEnvironmentResponse(entry, requester, admin));
  }

  if (scope === "shared") {
    const shared = await prisma.environmentShare.findMany({
      where: { sharedWithUserId: requester },
      include: { environment: { include: { shares: true } } },
      orderBy: [{ createdAt: "desc" }],
      take: limit
    });
    return shared.map((entry) => toEnvironmentResponse(entry.environment, requester, admin));
  }

  if (scope === "all") {
    const [owned, shared] = await Promise.all([
      prisma.userEnvironment.findMany({
        where: { ownerId },
        include: { shares: true },
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
        take: limit
      }),
      prisma.environmentShare.findMany({
        where: { sharedWithUserId: requester },
        include: { environment: { include: { shares: true } } },
        orderBy: [{ createdAt: "desc" }],
        take: limit
      })
    ]);
    const merged = uniqueById([...owned, ...shared.map((entry) => entry.environment)]).slice(0, limit);
    return merged.map((entry) => toEnvironmentResponse(entry, requester, admin));
  }

  const owned = await prisma.userEnvironment.findMany({
    where: { ownerId },
    include: { shares: true },
    orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
    take: limit
  });
  return owned.map((entry) => toEnvironmentResponse(entry, requester, admin));
});

app.get("/environments/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadEnvironmentWithAccess(id, requester, admin);
  if (!access.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
  if (!access.allowed) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_ACCESS" });
  return toEnvironmentResponse(access.environment, requester, admin);
});

app.patch("/environments/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as {
    name?: string;
    variables?: Record<string, unknown>;
    isDefault?: boolean;
  };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadEnvironmentWithAccess(id, requester, admin);
  if (!access.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_MUTATION" });

  if (body.isDefault) {
    await prisma.userEnvironment.updateMany({
      where: { ownerId: access.environment.ownerId },
      data: { isDefault: false }
    });
  }

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return reply.code(400).send({ error: "ENVIRONMENT_NAME_REQUIRED" });
    data.name = name;
  }
  if (body.variables !== undefined) {
    const variablesObject = toJsonObject(body.variables);
    const variableIssues = validateSecretFields(variablesObject, {
      pathPrefix: "environment.variables",
      allowSensitiveKeys: false,
      requireVaultRefForSensitive: false
    });
    if (variableIssues.length > 0) {
      return reply.code(400).send({ error: variableIssues[0].code, details: variableIssues[0].message, issues: variableIssues });
    }
    data.variablesJson = variablesObject;
  }
  if (body.isDefault !== undefined) data.isDefault = Boolean(body.isDefault);

  const updated = await prisma.userEnvironment.update({
    where: { id },
    data,
    include: { shares: true }
  });
  return toEnvironmentResponse(updated, requester, admin);
});

app.get("/environments/:id/shares", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadEnvironmentWithAccess(id, requester, admin);
  if (!access.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
  if (!access.allowed) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_ACCESS" });
  return access.environment.shares.map((entry) => ({
    username: entry.sharedWithUserId,
    createdBy: entry.createdBy,
    createdAt: entry.createdAt
  }));
});

app.post("/environments/:id/share", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as { username?: string };
  const username = String(body.username ?? "").trim();
  if (!username) return reply.code(400).send({ error: "SHARE_USERNAME_REQUIRED" });
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadEnvironmentWithAccess(id, requester, admin);
  if (!access.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_SHARE" });
  if (username === access.environment.ownerId) return reply.code(400).send({ error: "OWNER_ALREADY_HAS_ACCESS" });
  await prisma.environmentShare.upsert({
    where: { environmentId_sharedWithUserId: { environmentId: id, sharedWithUserId: username } },
    create: {
      environmentId: id,
      sharedWithUserId: username,
      createdBy: requester
    },
    update: {}
  });
  const updated = await prisma.userEnvironment.findUnique({
    where: { id },
    include: { shares: true }
  });
  return toEnvironmentResponse(updated!, requester, admin);
});

app.delete("/environments/:id/share/:username", async (request, reply) => {
  const params = request.params as { id: string; username: string };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadEnvironmentWithAccess(params.id, requester, admin);
  if (!access.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_SHARE" });
  await prisma.environmentShare.deleteMany({
    where: {
      environmentId: params.id,
      sharedWithUserId: params.username
    }
  });
  const updated = await prisma.userEnvironment.findUnique({
    where: { id: params.id },
    include: { shares: true }
  });
  return toEnvironmentResponse(updated!, requester, admin);
});

app.post("/environments/:id/duplicate", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const body = (request.body ?? {}) as { name?: string };
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadEnvironmentWithAccess(id, requester, admin);
  if (!access.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
  if (!access.allowed) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_ACCESS" });
  const name = String(body.name ?? `${access.environment.name} Copy`).trim();
  if (!name) return reply.code(400).send({ error: "ENVIRONMENT_NAME_REQUIRED" });
  const copy = await prisma.userEnvironment.create({
    data: {
      name,
      ownerId: requester,
      variablesJson: toJsonObject(access.environment.variablesJson),
      isDefault: false
    },
    include: { shares: true }
  });
  return reply.code(201).send(toEnvironmentResponse(copy, requester, admin));
});

app.delete("/environments/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const requester = requesterUserId(request.headers as Record<string, unknown>);
  const admin = isAdmin(request.headers as Record<string, unknown>);
  const access = await loadEnvironmentWithAccess(id, requester, admin);
  if (!access.environment) return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
  if (!access.owner && !admin) return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_MUTATION" });
  const workflows = await findEnvironmentWorkflowUsage(id);
  if (workflows.length > 0) {
    return reply.code(409).send({
      error: "ENVIRONMENT_IN_USE",
      warning: "This environment is currently referenced by workflows and cannot be deleted.",
      workflows
    });
  }
  await prisma.userEnvironment.delete({ where: { id } });
  return { deleted: true, environmentId: id };
});

let worker: { connection: ChannelModel; channel: Channel } | undefined;

app.addHook("onClose", async () => {
  await tlsRuntime.close();
  if (worker) {
    await worker.channel.close().catch(() => undefined);
    await worker.connection.close().catch(() => undefined);
  }
  await eventPublisher.close();
});

async function start(): Promise<void> {
  await enforceStrictSecretPolicy();
  await app.listen({ port: config.port, host: "0.0.0.0" });
  tlsRuntime.onReload((error) => {
    if (error) return;
    tlsRuntime.applyServerSecureContext(app.server);
  });
  tlsRuntime.startWatching();
  worker = await startPublishAuditWorker();
}

start().catch((error) => {
  process.stderr.write(`[workflow-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
