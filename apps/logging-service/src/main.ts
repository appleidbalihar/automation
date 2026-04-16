import Fastify from "fastify";
import amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { loadConfig } from "@platform/config";
import { prisma } from "@platform/db";
import { connectAmqp, createTlsRuntime } from "@platform/tls-runtime";

const config = loadConfig("logging-service", 4005);
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
const LOGGING_EVENTS_QUEUE = "logging-service.events.v1";

const SENSITIVE_KEYWORDS = ["password", "token", "secret", "key", "credential"];

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYWORDS.some((keyword) => lower.includes(keyword));
}

function mask(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) {
    return payload.map((item) => mask(item));
  }
  if (typeof payload !== "object") return payload;

  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      copy[key] = "***";
      continue;
    }
    copy[key] = mask(value);
  }
  return copy;
}

async function resolveOrderIdFromCorrelationId(correlationId?: string): Promise<string | undefined> {
  if (!correlationId) return undefined;
  const order = await prisma.order.findUnique({
    where: { correlationId },
    select: { id: true }
  });
  return order?.id;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function eventSeverity(event: string): string {
  return event.toLowerCase().includes("failed") ? "ERROR" : "INFO";
}

function getOrderIdFromPayload(payload: Record<string, unknown>): string | undefined {
  const directOrderId = payload.orderId;
  if (typeof directOrderId === "string") {
    return directOrderId;
  }
  const nestedOrder = payload.order;
  if (nestedOrder && typeof nestedOrder === "object") {
    const nestedOrderId = (nestedOrder as Record<string, unknown>).id;
    if (typeof nestedOrderId === "string") {
      return nestedOrderId;
    }
  }
  return undefined;
}

async function storeEventBusLog(parsed: {
  event: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const payload = parsed.payload ?? {};
  const orderId = getOrderIdFromPayload(payload);
  if (!orderId) {
    return;
  }
  const nodeId = typeof payload.nodeId === "string" ? payload.nodeId : undefined;
  const stepId = typeof payload.stepId === "string" ? payload.stepId : undefined;
  const executionId = typeof payload.correlationId === "string" ? payload.correlationId : undefined;
  const workflowId = typeof payload.workflowId === "string" ? payload.workflowId : undefined;
  const workflowVersionId = typeof payload.workflowVersionId === "string" ? payload.workflowVersionId : undefined;
  const taskId =
    typeof payload.taskId === "string" ? payload.taskId : typeof payload.stepId === "string" ? payload.stepId : undefined;
  const initiatedBy = typeof payload.initiatedBy === "string" ? payload.initiatedBy : undefined;
  const durationMs = typeof payload.durationMs === "number" ? payload.durationMs : undefined;
  await prisma.executionLog.create({
    data: {
      orderId,
      executionId,
      workflowId,
      workflowVersionId,
      nodeId,
      stepId,
      taskId,
      initiatedBy,
      severity: eventSeverity(parsed.event),
      source: "event-bus",
      maskedPayload: mask(payload) as object,
      message: `Event received: ${parsed.event}`,
      durationMs,
      createdAt: parsed.timestamp ? new Date(parsed.timestamp) : undefined
    }
  });
}

async function startEventConsumer(): Promise<{ connection: ChannelModel; channel: Channel } | undefined> {
  try {
    const connection = (await connectAmqp(tlsRuntime, amqp.connect, config.rabbitmqUrl)) as ChannelModel;
    const channel = await connection.createChannel();
    await channel.assertExchange(PLATFORM_EVENTS_EXCHANGE, "topic", { durable: true });
    await channel.assertQueue(LOGGING_EVENTS_QUEUE, { durable: true });
    await channel.bindQueue(LOGGING_EVENTS_QUEUE, PLATFORM_EVENTS_EXCHANGE, "#");
    await channel.consume(
      LOGGING_EVENTS_QUEUE,
      async (message: ConsumeMessage | null) => {
        if (!message) return;
        try {
          const raw = message.content.toString("utf8");
          const decoded = tryParseJson(raw) as { event?: string; timestamp?: string; payload?: Record<string, unknown> } | undefined;
          if (!decoded?.event || typeof decoded.event !== "string") {
            channel.ack(message);
            return;
          }
          await storeEventBusLog({
            event: decoded.event,
            timestamp: decoded.timestamp,
            payload: decoded.payload
          });
          channel.ack(message);
        } catch {
          channel.nack(message, false, true);
        }
      },
      { noAck: false }
    );
    return { connection, channel };
  } catch (error) {
    console.warn("[logging-service] event consumer disabled", error instanceof Error ? error.message : String(error));
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

app.post("/logs/ingest", async (request, reply) => {
  const body = request.body as {
    orderId: string;
    executionId?: string;
    workflowId?: string;
    workflowVersionId?: string;
    nodeId?: string;
    stepId?: string;
    taskId?: string;
    initiatedBy?: string;
    severity: string;
    source: string;
    payload?: Record<string, unknown>;
    message: string;
    correlationId?: string;
    durationMs?: number;
  };

  const resolvedOrderId = body.orderId || (await resolveOrderIdFromCorrelationId(body.correlationId));
  if (!resolvedOrderId) {
    return reply.code(400).send({
      error: "ORDER_REFERENCE_REQUIRED",
      message: "Provide orderId or a valid correlationId"
    });
  }

  const log = await prisma.executionLog.create({
    data: {
      orderId: resolvedOrderId,
      executionId: body.executionId ?? body.correlationId,
      workflowId: body.workflowId,
      workflowVersionId: body.workflowVersionId,
      nodeId: body.nodeId,
      stepId: body.stepId,
      taskId: body.taskId ?? body.stepId,
      initiatedBy: body.initiatedBy,
      severity: body.severity,
      source: body.source,
      maskedPayload: mask(body.payload) as object,
      message: body.message,
      durationMs: body.durationMs
    }
  });
  return reply.code(201).send(log);
});

app.get("/logs", async (request) => {
  const query = request.query as {
    orderId?: string;
    correlationId?: string;
    severity?: string;
    source?: string;
    nodeId?: string;
    stepId?: string;
    messageContains?: string;
    from?: string;
    to?: string;
    limit?: string;
  };
  const orderId = query.orderId || (await resolveOrderIdFromCorrelationId(query.correlationId));
  if (query.correlationId && !orderId) {
    return [];
  }
  const limit = Math.min(Math.max(Number(query.limit ?? "200"), 1), 500);

  const where = {
    orderId,
    severity: query.severity,
    source: query.source,
    nodeId: query.nodeId,
    stepId: query.stepId,
    ...(query.messageContains ? { message: { contains: query.messageContains, mode: "insensitive" as const } } : {}),
    ...((query.from || query.to)
      ? {
          createdAt: {
            ...(query.from ? { gte: new Date(query.from) } : {}),
            ...(query.to ? { lte: new Date(query.to) } : {})
          }
        }
      : {})
  };

  return prisma.executionLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit
  });
});

app.get("/logs/timeline", async (request, reply) => {
  const query = request.query as { orderId?: string; correlationId?: string };
  const orderId = query.orderId || (await resolveOrderIdFromCorrelationId(query.correlationId));
  if (!orderId) {
    return reply.code(400).send({
      error: "ORDER_REFERENCE_REQUIRED",
      message: "Provide orderId or a valid correlationId"
    });
  }

  const [transitions, stepExecutions, logs] = await Promise.all([
    prisma.statusTransition.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" }
    }),
    prisma.stepExecution.findMany({
      where: { orderId },
      orderBy: { startedAt: "asc" }
    }),
    prisma.executionLog.findMany({
      where: { orderId },
      orderBy: { createdAt: "asc" }
    })
  ]);

  const events = [
    ...transitions.map((item) => ({
      type: "STATUS_TRANSITION" as const,
      timestamp: item.createdAt,
      data: {
        from: item.from,
        to: item.to,
        reason: item.reason
      }
    })),
    ...stepExecutions.map((item) => ({
      type: "STEP_EXECUTION" as const,
      timestamp: item.startedAt,
      data: {
        nodeId: item.nodeId,
        stepId: item.stepId,
        status: item.status,
        retryCount: item.retryCount,
        durationMs: item.durationMs,
        errorSource: item.errorSource,
        errorMessage: item.errorMessage
      }
    })),
    ...logs.map((item) => ({
      type: "EXECUTION_LOG" as const,
      timestamp: item.createdAt,
      data: {
        severity: item.severity,
        source: item.source,
        nodeId: item.nodeId,
        stepId: item.stepId,
        message: item.message,
        durationMs: item.durationMs,
        payload: item.maskedPayload
      }
    }))
  ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  return {
    orderId,
    events
  };
});

let eventConsumer: { connection: ChannelModel; channel: Channel } | undefined;

app.addHook("onClose", async () => {
  await tlsRuntime.close();
  if (!eventConsumer) return;
  await eventConsumer.channel.close().catch(() => undefined);
  await eventConsumer.connection.close().catch(() => undefined);
});

async function start(): Promise<void> {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  tlsRuntime.onReload((error) => {
    if (error) return;
    tlsRuntime.applyServerSecureContext(app.server);
  });
  tlsRuntime.startWatching();
  eventConsumer = await startEventConsumer();
}

start().catch((error) => {
  process.stderr.write(`[logging-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
