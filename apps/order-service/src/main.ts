import Fastify from "fastify";
import amqp from "amqplib";
import type { Channel, ChannelModel } from "amqplib";
import { loadConfig } from "@platform/config";
import { prisma } from "@platform/db";
import { createCorrelationId } from "@platform/observability";
import { PlatformEvents, type OrderExecutionRequest, type WorkflowNode, type WorkflowStep } from "@platform/contracts";
import { connectAmqp, createTlsRuntime, tlsFetch } from "@platform/tls-runtime";

const config = loadConfig("order-service", 4002);
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
const PLATFORM_EVENTS_EXCHANGE = "platform.events";

class EventPublisher {
  private connection?: ChannelModel;
  private channel?: Channel;
  private connecting?: Promise<void>;

  private async connect(): Promise<void> {
    if (this.channel) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }

    this.connecting = (async () => {
      this.connection = (await connectAmqp(tlsRuntime, amqp.connect, config.rabbitmqUrl)) as ChannelModel;
      const channel = await this.connection.createChannel();
      await channel.assertExchange(PLATFORM_EVENTS_EXCHANGE, "topic", { durable: true });
      this.channel = channel;
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async publish(event: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.connect();
      if (!this.channel) return;
      this.channel.publish(
        PLATFORM_EVENTS_EXCHANGE,
        event,
        Buffer.from(
          JSON.stringify({
            event,
            timestamp: new Date().toISOString(),
            payload
          })
        ),
        { contentType: "application/json", persistent: true }
      );
    } catch (error) {
      console.warn("[order-service] failed to publish event", event, error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}

const eventPublisher = new EventPublisher();
const ORDER_STATUSES = [
  "PENDING",
  "RUNNING",
  "PENDING_APPROVAL",
  "FAILED",
  "PARTIAL",
  "SUCCESS",
  "ROLLING_BACK",
  "ROLLED_BACK"
] as const;

type OrderStatus = (typeof ORDER_STATUSES)[number];

function parseLimit(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? "");
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function parseOrderStatus(value: string | undefined): OrderStatus | undefined {
  if (!value) return undefined;
  return ORDER_STATUSES.find((status) => status === value);
}

function toJsonValue(value: unknown): any {
  return JSON.parse(JSON.stringify(value ?? {}));
}

type RuntimeOrderState = {
  id: string;
  workflowVersionId: string;
  environmentId?: string | null;
  status: string;
  currentNodeOrder: number;
  currentStepIndex: number;
  failurePolicy: string;
  correlationId: string;
  inputJson: unknown;
  envSnapshotJson?: unknown;
};

type EngineRunResult = {
  status: "SUCCESS" | "PARTIAL" | "FAILED" | "PENDING_APPROVAL";
  currentNodeOrder: number;
  currentStepIndex: number;
  failureReason?: string;
};

type EngineRunResponse = {
  result: EngineRunResult;
  checkpoints: Array<{ nodeOrder: number; stepIndex: number }>;
  audits: Array<{
    nodeId: string;
    stepId: string;
    status: "SUCCESS" | "FAILED" | "SKIPPED";
    retryCount: number;
    durationMs: number;
    errorMessage?: string;
    requestPayload?: Record<string, unknown>;
    responsePayload?: Record<string, unknown>;
    startedAt: string;
    finishedAt: string;
  }>;
};

type RuntimeIntegrationProfile = {
  id: string;
  executionType: string;
  authType: string;
  baseConfigJson: unknown;
  credentialJson: unknown;
};

function requesterUserId(headers: Record<string, unknown>): string {
  return String(headers["x-user-id"] ?? "").trim() || "unknown";
}

function requesterRoles(headers: Record<string, unknown>): string[] {
  const raw = String(headers["x-user-roles"] ?? "");
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function isAdmin(headers: Record<string, unknown>): boolean {
  return requesterRoles(headers).includes("admin");
}

function toObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function extractNodeIntegrationIds(nodes: WorkflowNode[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes as Array<WorkflowNode & { integrationProfileId?: string }>) {
    const integrationId = String(node.integrationProfileId ?? "").trim();
    if (integrationId) {
      ids.add(integrationId);
    }
  }
  return [...ids];
}

function extractNodeEnvironmentIds(nodes: WorkflowNode[]): string[] {
  const ids = new Set<string>();
  for (const node of nodes as Array<WorkflowNode & { environmentId?: string }>) {
    const environmentId = String(node.environmentId ?? "").trim();
    if (environmentId) {
      ids.add(environmentId);
    }
  }
  return [...ids];
}

function buildIntegrationMapByNode(
  nodes: WorkflowNode[],
  integrations: RuntimeIntegrationProfile[]
): Record<string, { id: string; executionType: string; authType: string; baseConfig: Record<string, unknown>; credentials: Record<string, unknown> }> {
  const integrationById = new Map(integrations.map((integration) => [integration.id, integration]));
  const byNode: Record<
    string,
    { id: string; executionType: string; authType: string; baseConfig: Record<string, unknown>; credentials: Record<string, unknown> }
  > = {};
  for (const node of nodes as Array<WorkflowNode & { integrationProfileId?: string }>) {
    const integrationId = String(node.integrationProfileId ?? "").trim();
    if (!integrationId) continue;
    const integration = integrationById.get(integrationId);
    if (!integration) continue;
    byNode[node.id] = {
      id: integration.id,
      executionType: integration.executionType,
      authType: integration.authType,
      baseConfig: {
        ...toObject(integration.baseConfigJson),
        authType: integration.authType
      },
      credentials: toObject(integration.credentialJson)
    };
  }
  return byNode;
}

function buildNodeEnvironmentMap(
  nodes: WorkflowNode[],
  environments: Array<{ id: string; variablesJson: unknown }>
): Record<string, Record<string, unknown>> {
  const envById = new Map(environments.map((environment) => [environment.id, toObject(environment.variablesJson)]));
  const byNode: Record<string, Record<string, unknown>> = {};
  for (const node of nodes as Array<WorkflowNode & { environmentId?: string }>) {
    const environmentId = String(node.environmentId ?? "").trim();
    if (!environmentId) continue;
    const env = envById.get(environmentId);
    if (!env) continue;
    byNode[node.id] = env;
  }
  return byNode;
}

async function callExecutionEngine(
  order: RuntimeOrderState,
  nodes: WorkflowNode[],
  integrationProfilesByNode: Record<
    string,
    { id: string; executionType: string; authType: string; baseConfig: Record<string, unknown>; credentials: Record<string, unknown> }
  >,
  nodeEnvironmentsByNode: Record<string, Record<string, unknown>>,
  approvedNodeOrders?: number[]
): Promise<EngineRunResponse> {
  const response = await tlsFetch(tlsRuntime, new URL("/engine/run", config.executionEngineServiceUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      order: {
        id: order.id,
        currentNodeOrder: order.currentNodeOrder,
        currentStepIndex: order.currentStepIndex,
        failurePolicy: order.failurePolicy
      },
      workflowNodes: nodes,
      input: (order.inputJson as Record<string, unknown>) ?? {},
      environmentVariables: toObject(order.envSnapshotJson),
      nodeEnvironmentsByNode,
      integrationProfilesByNode,
      approvedNodeOrders
    })
  });

  const raw = await response.text();
  const payload = raw.length > 0 ? (JSON.parse(raw) as EngineRunResponse | { error?: string }) : {};
  if (!response.ok || !("result" in payload)) {
    const details = typeof payload === "object" && payload && "error" in payload ? payload.error : undefined;
    throw new Error(`Execution engine run failed with status ${response.status}${details ? `: ${String(details)}` : ""}`);
  }
  return payload;
}

async function runExecutionForOrder(
  order: RuntimeOrderState,
  nodes: WorkflowNode[],
  integrationProfilesByNode: Record<
    string,
    { id: string; executionType: string; authType: string; baseConfig: Record<string, unknown>; credentials: Record<string, unknown> }
  >,
  nodeEnvironmentsByNode: Record<string, Record<string, unknown>>,
  approvedNodeOrders?: number[]
): Promise<EngineRunResult> {
  const engineResponse = await callExecutionEngine(order, nodes, integrationProfilesByNode, nodeEnvironmentsByNode, approvedNodeOrders);
  const result = engineResponse.result;

  for (const checkpoint of engineResponse.checkpoints) {
    await prisma.executionCheckpoint.create({
      data: {
        orderId: order.id,
        nodeOrder: checkpoint.nodeOrder,
        stepIndex: checkpoint.stepIndex
      }
    });
  }

  for (const audit of engineResponse.audits) {
    await prisma.stepExecution.create({
      data: {
        orderId: order.id,
        nodeId: audit.nodeId,
        stepId: audit.stepId,
        status: audit.status,
        retryCount: audit.retryCount,
        durationMs: audit.durationMs,
        errorSource: audit.status === "FAILED" ? "SBI" : undefined,
        errorMessage: audit.errorMessage,
        requestPayload: toJsonValue(audit.requestPayload),
        responsePayload: toJsonValue(audit.responsePayload),
        startedAt: new Date(audit.startedAt),
        finishedAt: new Date(audit.finishedAt)
      }
    });

    const event = audit.status === "FAILED" ? PlatformEvents.executionStepFailed : PlatformEvents.executionStepCompleted;
    await eventPublisher.publish(event, {
      orderId: order.id,
      nodeId: audit.nodeId,
      stepId: audit.stepId,
      status: audit.status,
      retryCount: audit.retryCount,
      durationMs: audit.durationMs,
      errorMessage: audit.errorMessage,
      correlationId: order.correlationId
    });
  }

  await prisma.order.update({
    where: { id: order.id },
    data: {
      status: result.status,
      currentNodeOrder: result.currentNodeOrder,
      currentStepIndex: result.currentStepIndex,
      lastError: result.failureReason
    }
  });

  await prisma.statusTransition.create({
    data: {
      orderId: order.id,
      from: "RUNNING",
      to: result.status,
      reason: result.failureReason
    }
  });

  if (result.status === "FAILED") {
    const failedNode = nodes.find((node) => node.order === result.currentNodeOrder);
    await eventPublisher.publish(PlatformEvents.orderNodeFailed, {
      orderId: order.id,
      nodeId: failedNode?.id,
      nodeOrder: result.currentNodeOrder,
      reason: result.failureReason,
      correlationId: order.correlationId
    });
  } else if (result.status === "PENDING_APPROVAL") {
    await eventPublisher.publish(PlatformEvents.orderNodeStarted, {
      orderId: order.id,
      nodeOrder: result.currentNodeOrder,
      status: result.status,
      reason: result.failureReason,
      correlationId: order.correlationId
    });
  } else {
    const completedNode = nodes.find((node) => node.order === Math.max(result.currentNodeOrder - 1, 0));
    await eventPublisher.publish(PlatformEvents.orderNodeCompleted, {
      orderId: order.id,
      nodeId: completedNode?.id,
      nodeOrder: result.currentNodeOrder - 1,
      status: result.status,
      correlationId: order.correlationId
    });
  }

  return result;
}

function flattenWorkflowSteps(nodes: WorkflowNode[]): WorkflowStep[] {
  const orderedNodes = [...nodes].sort((a, b) => a.order - b.order);
  const steps: WorkflowStep[] = [];
  for (const node of orderedNodes) {
    for (const step of node.steps) {
      steps.push(step);
    }
  }
  return steps;
}

async function runRollbackForOrder(order: RuntimeOrderState, nodes: WorkflowNode[]): Promise<{
  status: "ROLLED_BACK" | "PARTIAL";
  failedActions: string[];
}> {
  const successfulExecutions = await prisma.stepExecution.findMany({
    where: { orderId: order.id, status: "SUCCESS" },
    orderBy: { finishedAt: "desc" }
  });

  const rollbackActionsByStep = new Map<string, { executionType: WorkflowStep["executionType"]; rollbackAction: string }>();
  for (const step of flattenWorkflowSteps(nodes)) {
    if (step.rollbackAction && step.rollbackAction.trim().length > 0) {
      rollbackActionsByStep.set(step.id, {
        executionType: step.executionType,
        rollbackAction: step.rollbackAction
      });
    }
  }

  const failedActions: string[] = [];
  for (const executedStep of successfulExecutions) {
    const rollback = rollbackActionsByStep.get(executedStep.stepId);
    if (!rollback) continue;
    const startedAt = new Date();
    let success = false;
    let errorMessage: string | undefined;
    let payload: Record<string, unknown> = {};
    try {
      const response = await tlsFetch(tlsRuntime, new URL("/integrations/execute", config.integrationServiceUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          executionType: rollback.executionType,
          commandRef: rollback.rollbackAction,
          input: (order.inputJson as Record<string, unknown>) ?? {},
          metadata: {
            orderId: order.id,
            nodeId: executedStep.nodeId,
            stepId: `${executedStep.stepId}:rollback`
          }
        })
      });
      const raw = await response.text();
      payload = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
      success = response.ok && String(payload.status ?? "") === "SUCCESS";
      errorMessage = typeof payload.error === "string" ? payload.error : success ? undefined : "Rollback action failed";
    } catch (error) {
      success = false;
      errorMessage = error instanceof Error ? error.message : "Rollback action request failed";
      payload = { error: errorMessage };
    }
    const finishedAt = new Date();

    await prisma.stepExecution.create({
      data: {
        orderId: order.id,
        nodeId: executedStep.nodeId,
        stepId: `${executedStep.stepId}:rollback`,
        status: success ? "SUCCESS" : "FAILED",
        retryCount: 0,
        durationMs: Math.max(finishedAt.getTime() - startedAt.getTime(), 0),
        errorSource: success ? undefined : "SBI",
        errorMessage,
        requestPayload: toJsonValue({
          executionType: rollback.executionType,
          commandRef: rollback.rollbackAction
        }),
        responsePayload: toJsonValue(payload),
        startedAt,
        finishedAt
      }
    });

    await eventPublisher.publish(
      success ? PlatformEvents.executionStepCompleted : PlatformEvents.executionStepFailed,
      {
        orderId: order.id,
        nodeId: executedStep.nodeId,
        stepId: `${executedStep.stepId}:rollback`,
        status: success ? "SUCCESS" : "FAILED",
        retryCount: 0,
        durationMs: Math.max(finishedAt.getTime() - startedAt.getTime(), 0),
        errorMessage,
        correlationId: order.correlationId
      }
    );

    if (!success) {
      failedActions.push(`${executedStep.stepId}: ${errorMessage ?? "Rollback failed"}`);
    }
  }

  return {
    status: failedActions.length > 0 ? "PARTIAL" : "ROLLED_BACK",
    failedActions
  };
}

app.get("/health", async () => ({ ok: true, service: config.serviceName }));

app.get("/security/tls", async (request, reply) => {
  const token = String(request.headers["x-security-token"] ?? "");
  if (tlsRuntime.diagnosticsToken && token !== tlsRuntime.diagnosticsToken) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
  return tlsRuntime.getStatus();
});

app.post("/orders/execute", async (request, reply) => {
  const body = request.body as OrderExecutionRequest;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const initiatedBy = String(body.initiatedBy ?? requester).trim() || requester;
  if (initiatedBy !== requester && !admin) {
    return reply.code(403).send({ error: "FORBIDDEN_INITIATOR_OVERRIDE" });
  }
  const version = await prisma.workflowVersion.findUnique({ where: { id: body.workflowVersionId } });
  if (!version || version.status !== "PUBLISHED") {
    return reply.code(400).send({ error: "WORKFLOW_VERSION_NOT_PUBLISHED" });
  }

  let selectedEnvironment:
    | {
        id: string;
        ownerId: string;
        variablesJson: unknown;
        shares?: Array<{ sharedWithUserId: string }>;
      }
    | null = null;

  if (body.environmentId) {
    selectedEnvironment = await prisma.userEnvironment.findUnique({
      where: { id: body.environmentId },
      select: { id: true, ownerId: true, variablesJson: true, shares: { select: { sharedWithUserId: true } } }
    });
    if (!selectedEnvironment) {
      return reply.code(404).send({ error: "ENVIRONMENT_NOT_FOUND" });
    }
    const isShared = (selectedEnvironment.shares ?? []).some((entry) => entry.sharedWithUserId === initiatedBy);
    if (selectedEnvironment.ownerId !== initiatedBy && !isShared && !admin) {
      return reply.code(403).send({ error: "FORBIDDEN_ENVIRONMENT_ACCESS" });
    }
  } else {
    selectedEnvironment = await prisma.userEnvironment.findFirst({
      where: { ownerId: initiatedBy, isDefault: true },
      orderBy: { updatedAt: "desc" },
      select: { id: true, ownerId: true, variablesJson: true }
    });
  }

  const order = await prisma.order.create({
    data: {
      workflowVersionId: body.workflowVersionId,
      environmentId: selectedEnvironment?.id,
      status: "RUNNING",
      failurePolicy: "RETRY",
      correlationId: createCorrelationId("order"),
      inputJson: JSON.parse(JSON.stringify(body.input)),
      envSnapshotJson: selectedEnvironment?.variablesJson ? JSON.parse(JSON.stringify(selectedEnvironment.variablesJson)) : undefined,
      initiatedBy
    }
  });

  await eventPublisher.publish(PlatformEvents.orderCreated, {
    orderId: order.id,
    workflowVersionId: order.workflowVersionId,
    correlationId: order.correlationId,
    initiatedBy,
    environmentId: order.environmentId,
    status: order.status
  });

  await prisma.statusTransition.create({
    data: { orderId: order.id, from: "PENDING", to: "RUNNING", reason: "Order created and started" }
  });

  const nodes = JSON.parse(JSON.stringify(version.nodesJson ?? [])) as unknown as WorkflowNode[];
  const integrationIds = extractNodeIntegrationIds(nodes);
  const integrations =
    integrationIds.length > 0
      ? await prisma.integrationProfile.findMany({
          where: { id: { in: integrationIds }, isActive: true },
          select: { id: true, executionType: true, authType: true, baseConfigJson: true, credentialJson: true }
        })
      : [];
  const nodeEnvironmentIds = extractNodeEnvironmentIds(nodes);
  const nodeEnvironments =
    nodeEnvironmentIds.length > 0
      ? await prisma.userEnvironment.findMany({
          where: { id: { in: nodeEnvironmentIds } },
          select: { id: true, variablesJson: true }
        })
      : [];
  const integrationProfilesByNode = buildIntegrationMapByNode(nodes, integrations);
  const nodeEnvironmentsByNode = buildNodeEnvironmentMap(nodes, nodeEnvironments);
  try {
    const result = await runExecutionForOrder(order, nodes, integrationProfilesByNode, nodeEnvironmentsByNode);
    return reply.code(201).send({ orderId: order.id, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    await prisma.order.update({
      where: { id: order.id },
      data: {
        status: "FAILED",
        lastError: message
      }
    });
    await prisma.statusTransition.create({
      data: {
        orderId: order.id,
        from: "RUNNING",
        to: "FAILED",
        reason: `Execution engine unavailable: ${message}`
      }
    });
    return reply.code(502).send({ error: "EXECUTION_ENGINE_UNAVAILABLE", details: message, orderId: order.id });
  }
});

app.get("/orders", async (request) => {
  const query = request.query as {
    status?: string;
    workflowVersionId?: string;
    initiatedBy?: string;
    limit?: string;
  };
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const status = parseOrderStatus(query.status);
  const limit = parseLimit(query.limit, 50);
  const initiatedBy = admin ? query.initiatedBy : requester;
  return prisma.order.findMany({
    where: {
      status,
      workflowVersionId: query.workflowVersionId,
      initiatedBy
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      workflowVersionId: true,
      environmentId: true,
      status: true,
      currentNodeOrder: true,
      currentStepIndex: true,
      failurePolicy: true,
      correlationId: true,
      lastError: true,
      initiatedBy: true,
      createdAt: true,
      updatedAt: true
    }
  });
});

app.get("/orders/approvals", async (request) => {
  const query = request.query as { limit?: string };
  const limit = parseLimit(query.limit, 50);
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  return prisma.order.findMany({
    where: {
      status: "PENDING_APPROVAL",
      initiatedBy: admin ? undefined : requester
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      workflowVersionId: true,
      environmentId: true,
      status: true,
      currentNodeOrder: true,
      currentStepIndex: true,
      failurePolicy: true,
      correlationId: true,
      lastError: true,
      initiatedBy: true,
      createdAt: true,
      updatedAt: true
    }
  });
});

app.get("/orders/:id/approvals", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const order = await prisma.order.findUnique({ where: { id }, select: { id: true, initiatedBy: true } });
  if (!order) return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
  if (!admin && order.initiatedBy !== requester) return reply.code(403).send({ error: "FORBIDDEN_ORDER_ACCESS" });
  return prisma.approvalDecision.findMany({
    where: { orderId: id },
    orderBy: { createdAt: "desc" }
  });
});

app.post("/orders/:id/request-approval", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const body = (request.body ?? {}) as { requestedBy?: string; comment?: string };
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) {
    return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
  }
  if (!admin && order.initiatedBy !== requester) {
    return reply.code(403).send({ error: "FORBIDDEN_ORDER_ACCESS" });
  }
  if (order.status === "PENDING_APPROVAL") {
    return { status: "PENDING_APPROVAL", orderId: id };
  }
  await prisma.statusTransition.create({
    data: {
      orderId: id,
      from: order.status,
      to: "PENDING_APPROVAL",
      reason: body.comment ?? "Approval requested"
    }
  });
  await prisma.order.update({
    where: { id },
    data: {
      status: "PENDING_APPROVAL",
      lastError: body.comment ?? order.lastError
    }
  });
  await eventPublisher.publish(PlatformEvents.orderNodeStarted, {
    orderId: id,
    status: "PENDING_APPROVAL",
    requestedBy: body.requestedBy ?? requester,
    comment: body.comment,
    correlationId: order.correlationId
  });
  return { status: "PENDING_APPROVAL", orderId: id };
});

app.get("/orders/:id", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      checkpoints: { orderBy: { createdAt: "asc" } },
      transitions: { orderBy: { createdAt: "asc" } },
      stepExecutions: { orderBy: { startedAt: "asc" } },
      approvals: { orderBy: { createdAt: "desc" } }
    }
  });
  if (!order) {
    return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
  }
  if (!admin && order.initiatedBy !== requester) {
    return reply.code(403).send({ error: "FORBIDDEN_ORDER_ACCESS" });
  }
  return order;
});

app.post("/orders/:id/approve", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const body = (request.body ?? {}) as { decidedBy?: string; comment?: string };
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) {
    return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
  }
  if (!admin && order.initiatedBy !== requester) {
    return reply.code(403).send({ error: "FORBIDDEN_ORDER_ACCESS" });
  }
  if (order.status !== "PENDING_APPROVAL") {
    return reply.code(400).send({ error: "ORDER_NOT_PENDING_APPROVAL", status: order.status });
  }

  await prisma.approvalDecision.create({
    data: {
      orderId: id,
      nodeOrder: order.currentNodeOrder,
      decision: "APPROVED",
      decidedBy: body.decidedBy ?? requester,
      comment: body.comment
    }
  });

  await prisma.statusTransition.create({
    data: {
      orderId: id,
      from: "PENDING_APPROVAL",
      to: "RUNNING",
      reason: body.comment ?? "Approval granted"
    }
  });
  await prisma.order.update({
    where: { id },
    data: { status: "RUNNING", lastError: null }
  });
  await eventPublisher.publish(PlatformEvents.orderExecutionResumed, {
    orderId: id,
    fromStatus: "PENDING_APPROVAL",
    toStatus: "RUNNING",
    resumeFrom: { node: order.currentNodeOrder, step: order.currentStepIndex },
    approvedBy: body.decidedBy ?? requester,
    correlationId: order.correlationId
  });

  const version = await prisma.workflowVersion.findUnique({ where: { id: order.workflowVersionId } });
  if (!version) {
    return reply.code(404).send({ error: "WORKFLOW_VERSION_NOT_FOUND" });
  }
  const nodes = JSON.parse(JSON.stringify(version.nodesJson ?? [])) as unknown as WorkflowNode[];
  const integrationIds = extractNodeIntegrationIds(nodes);
  const integrations =
    integrationIds.length > 0
      ? await prisma.integrationProfile.findMany({
          where: { id: { in: integrationIds }, isActive: true },
          select: { id: true, executionType: true, authType: true, baseConfigJson: true, credentialJson: true }
        })
      : [];
  const nodeEnvironmentIds = extractNodeEnvironmentIds(nodes);
  const nodeEnvironments =
    nodeEnvironmentIds.length > 0
      ? await prisma.userEnvironment.findMany({
          where: { id: { in: nodeEnvironmentIds } },
          select: { id: true, variablesJson: true }
        })
      : [];
  const integrationProfilesByNode = buildIntegrationMapByNode(nodes, integrations);
  const nodeEnvironmentsByNode = buildNodeEnvironmentMap(nodes, nodeEnvironments);
  try {
    const result = await runExecutionForOrder(
      {
        id: order.id,
        workflowVersionId: order.workflowVersionId,
        environmentId: order.environmentId,
        status: "RUNNING",
        currentNodeOrder: order.currentNodeOrder,
        currentStepIndex: order.currentStepIndex,
        failurePolicy: order.failurePolicy,
        correlationId: order.correlationId,
        inputJson: order.inputJson,
        envSnapshotJson: order.envSnapshotJson
      },
      nodes,
      integrationProfilesByNode,
      nodeEnvironmentsByNode,
      [order.currentNodeOrder]
    );

    return { status: "APPROVAL_ACCEPTED", orderId: id, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    await prisma.order.update({
      where: { id },
      data: { status: "FAILED", lastError: message }
    });
    await prisma.statusTransition.create({
      data: {
        orderId: id,
        from: "RUNNING",
        to: "FAILED",
        reason: `Execution engine unavailable after approval: ${message}`
      }
    });
    return reply.code(502).send({ error: "EXECUTION_ENGINE_UNAVAILABLE", details: message, orderId: id });
  }
});

app.post("/orders/:id/reject", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const body = (request.body ?? {}) as { decidedBy?: string; comment?: string };
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) {
    return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
  }
  if (!admin && order.initiatedBy !== requester) {
    return reply.code(403).send({ error: "FORBIDDEN_ORDER_ACCESS" });
  }
  if (order.status !== "PENDING_APPROVAL") {
    return reply.code(400).send({ error: "ORDER_NOT_PENDING_APPROVAL", status: order.status });
  }

  const reason = body.comment ?? "Approval rejected";
  await prisma.approvalDecision.create({
    data: {
      orderId: id,
      nodeOrder: order.currentNodeOrder,
      decision: "REJECTED",
      decidedBy: body.decidedBy ?? requester,
      comment: reason
    }
  });
  await prisma.statusTransition.create({
    data: {
      orderId: id,
      from: "PENDING_APPROVAL",
      to: "FAILED",
      reason
    }
  });
  await prisma.order.update({
    where: { id },
    data: { status: "FAILED", lastError: reason }
  });
  await eventPublisher.publish(PlatformEvents.orderNodeFailed, {
    orderId: id,
    nodeOrder: order.currentNodeOrder,
    reason,
    rejectedBy: body.decidedBy ?? requester,
    correlationId: order.correlationId
  });
  return { status: "APPROVAL_REJECTED", orderId: id };
});

app.post("/orders/:id/retry", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) {
    return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
  }
  if (!admin && order.initiatedBy !== requester) {
    return reply.code(403).send({ error: "FORBIDDEN_ORDER_ACCESS" });
  }
  if (order.status === "SUCCESS") {
    return reply.code(400).send({ error: "ORDER_NOT_RETRYABLE", status: order.status });
  }
  await prisma.statusTransition.create({
    data: {
      orderId: id,
      from: order.status,
      to: "RUNNING",
      reason: "Manual retry requested"
    }
  });
  await prisma.order.update({ where: { id }, data: { status: "RUNNING" } });
  await eventPublisher.publish(PlatformEvents.orderExecutionResumed, {
    orderId: id,
    fromStatus: order.status,
    toStatus: "RUNNING",
    resumeFrom: { node: order.currentNodeOrder, step: order.currentStepIndex },
    correlationId: order.correlationId
  });

  const version = await prisma.workflowVersion.findUnique({ where: { id: order.workflowVersionId } });
  if (!version) {
    return reply.code(404).send({ error: "WORKFLOW_VERSION_NOT_FOUND" });
  }
  const nodes = JSON.parse(JSON.stringify(version.nodesJson ?? [])) as unknown as WorkflowNode[];
  const integrationIds = extractNodeIntegrationIds(nodes);
  const integrations =
    integrationIds.length > 0
      ? await prisma.integrationProfile.findMany({
          where: { id: { in: integrationIds }, isActive: true },
          select: { id: true, executionType: true, authType: true, baseConfigJson: true, credentialJson: true }
        })
      : [];
  const nodeEnvironmentIds = extractNodeEnvironmentIds(nodes);
  const nodeEnvironments =
    nodeEnvironmentIds.length > 0
      ? await prisma.userEnvironment.findMany({
          where: { id: { in: nodeEnvironmentIds } },
          select: { id: true, variablesJson: true }
        })
      : [];
  const integrationProfilesByNode = buildIntegrationMapByNode(nodes, integrations);
  const nodeEnvironmentsByNode = buildNodeEnvironmentMap(nodes, nodeEnvironments);

  try {
    const result = await runExecutionForOrder(
      {
        id: order.id,
        workflowVersionId: order.workflowVersionId,
        environmentId: order.environmentId,
        status: "RUNNING",
        currentNodeOrder: order.currentNodeOrder,
        currentStepIndex: order.currentStepIndex,
        failurePolicy: order.failurePolicy,
        correlationId: order.correlationId,
        inputJson: order.inputJson,
        envSnapshotJson: order.envSnapshotJson
      },
      nodes,
      integrationProfilesByNode,
      nodeEnvironmentsByNode
    );
    return { status: "RETRY_COMPLETED", resumeFrom: { node: order.currentNodeOrder, step: order.currentStepIndex }, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Execution failed";
    await prisma.order.update({
      where: { id },
      data: { status: "FAILED", lastError: message }
    });
    await prisma.statusTransition.create({
      data: {
        orderId: id,
        from: "RUNNING",
        to: "FAILED",
        reason: `Execution engine unavailable during retry: ${message}`
      }
    });
    return reply.code(502).send({ error: "EXECUTION_ENGINE_UNAVAILABLE", details: message, orderId: id });
  }
});

app.post("/orders/:id/rollback", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const headers = request.headers as Record<string, unknown>;
  const requester = requesterUserId(headers);
  const admin = isAdmin(headers);
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) {
    return reply.code(404).send({ error: "ORDER_NOT_FOUND" });
  }
  if (!admin && order.initiatedBy !== requester) {
    return reply.code(403).send({ error: "FORBIDDEN_ORDER_ACCESS" });
  }
  await prisma.statusTransition.create({
    data: {
      orderId: id,
      from: order.status,
      to: "ROLLING_BACK",
      reason: "Manual rollback requested"
    }
  });
  await eventPublisher.publish(PlatformEvents.executionRollbackStarted, {
    orderId: id,
    fromStatus: order.status,
    toStatus: "ROLLING_BACK",
    correlationId: order.correlationId
  });

  const version = await prisma.workflowVersion.findUnique({ where: { id: order.workflowVersionId } });
  if (!version) {
    return reply.code(404).send({ error: "WORKFLOW_VERSION_NOT_FOUND" });
  }
  const nodes = JSON.parse(JSON.stringify(version.nodesJson ?? [])) as unknown as WorkflowNode[];

  try {
    const rollback = await runRollbackForOrder(
      {
        id: order.id,
        workflowVersionId: order.workflowVersionId,
        status: "ROLLING_BACK",
        currentNodeOrder: order.currentNodeOrder,
        currentStepIndex: order.currentStepIndex,
        failurePolicy: order.failurePolicy,
        correlationId: order.correlationId,
        inputJson: order.inputJson
      },
      nodes
    );

    await prisma.order.update({
      where: { id },
      data: {
        status: rollback.status,
        lastError: rollback.failedActions.length > 0 ? rollback.failedActions.join(" | ") : null
      }
    });
    await prisma.statusTransition.create({
      data: {
        orderId: id,
        from: "ROLLING_BACK",
        to: rollback.status,
        reason: rollback.failedActions.length > 0 ? `Rollback partial: ${rollback.failedActions.join("; ")}` : "Rollback completed"
      }
    });
    await eventPublisher.publish(PlatformEvents.executionRollbackCompleted, {
      orderId: id,
      fromStatus: "ROLLING_BACK",
      toStatus: rollback.status,
      failedActions: rollback.failedActions,
      correlationId: order.correlationId
    });
    return { status: rollback.status, failedActions: rollback.failedActions };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rollback execution failed";
    await prisma.order.update({
      where: { id },
      data: { status: "PARTIAL", lastError: message }
    });
    await prisma.statusTransition.create({
      data: {
        orderId: id,
        from: "ROLLING_BACK",
        to: "PARTIAL",
        reason: `Rollback failed: ${message}`
      }
    });
    return reply.code(502).send({ error: "ROLLBACK_EXECUTION_FAILED", details: message, orderId: id });
  }
});

app.addHook("onClose", async () => {
  await tlsRuntime.close();
  await eventPublisher.close();
});

async function start(): Promise<void> {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  tlsRuntime.onReload((error) => {
    if (error) return;
    tlsRuntime.applyServerSecureContext(app.server);
  });
  tlsRuntime.startWatching();
}

start().catch((error) => {
  process.stderr.write(`[order-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
