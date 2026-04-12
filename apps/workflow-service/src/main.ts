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
      credentialJson: toJsonObject(body.credentials)
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
  if (body.credentials !== undefined) data.credentialJson = toJsonObject(body.credentials);

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

  const environment = await prisma.userEnvironment.create({
    data: {
      name,
      ownerId,
      variablesJson: toJsonObject(body.variables),
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
  if (body.variables !== undefined) data.variablesJson = toJsonObject(body.variables);
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
