import { loadConfig } from "@platform/config";
import { prisma } from "@platform/db";
import { connectAmqp, createTlsRuntime } from "@platform/tls-runtime";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import amqp from "amqplib";
import Fastify from "fastify";

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

// ─── OpenSearch client (direct HTTP, no extra SDK needed) ─────────────────────
// Uses the OPENSEARCH_URL from config which includes credentials.
// Falls back gracefully — if OpenSearch is unavailable logs still go to Postgres.

function todayIndex(): string {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `platform-logs-${y}.${m}.${day}`;
}

/**
 * Ships a log document to OpenSearch.
 * Index pattern: platform-logs-YYYY.MM.DD
 * Silently ignored on error — OpenSearch availability is not required for platform ops.
 */
async function shipToOpenSearch(doc: Record<string, unknown>): Promise<void> {
  const baseUrl = config.opensearchUrl.replace(/\/+$/, "");
  const index = todayIndex();
  try {
    const parsed = new URL(baseUrl);
    const username = parsed.username;
    const password = parsed.password;
    parsed.username = "";
    parsed.password = "";
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (username || password) {
      headers.authorization = `Basic ${Buffer.from(`${decodeURIComponent(username)}:${decodeURIComponent(password)}`).toString("base64")}`;
    }
    const response = await fetch(`${parsed.toString().replace(/\/+$/, "")}/${index}/_doc`, {
      method: "POST",
      headers,
      body: JSON.stringify(doc)
    });
    // 201 = created, 200 = ok. Non-2xx is silently swallowed.
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn(`[logging-service] OpenSearch ingest ${response.status}: ${text.slice(0, 200)}`);
    }
  } catch (error) {
    // OpenSearch unavailable — continue without interrupting platform logs
    console.warn("[logging-service] OpenSearch unavailable:", error instanceof Error ? error.message : String(error));
  }
}

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

async function storeEventBusLog(parsed: {
  event: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const payload = parsed.payload ?? {};
  const source = typeof payload.service === "string" ? payload.service : "event-bus";
  const createdAt = parsed.timestamp ? new Date(parsed.timestamp) : new Date();

  // Dual-write: Postgres (existing) + OpenSearch (new)
  await Promise.all([
    prisma.platformLog.create({
      data: {
        severity: eventSeverity(parsed.event),
        source,
        message: `Event received: ${parsed.event}`,
        maskedPayload: mask(payload) as object,
        createdAt
      }
    }),
    shipToOpenSearch({
      "@timestamp": createdAt.toISOString(),
      severity: eventSeverity(parsed.event),
      source,
      message: `Event received: ${parsed.event}`,
      payload: mask(payload),
      event: parsed.event
    })
  ]).catch((error) => {
    console.warn("[logging-service] storeEventBusLog error:", error instanceof Error ? error.message : String(error));
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

/**
 * Ingest a single log entry.
 * Dual-writes to Postgres (for platform log explorer) and OpenSearch (for RAG sync log queries).
 * Accepts optional fields: syncJobId, stepName — used to tag RAG sync workflow logs.
 */
app.post("/logs/ingest", async (request, reply) => {
  const body = request.body as {
    severity: string;
    source: string;
    payload?: Record<string, unknown>;
    message: string;
    correlationId?: string;
    durationMs?: number;
    // RAG sync specific — tag logs for filtered retrieval
    syncJobId?: string;
    stepName?: string;
  };

  const now = new Date();
  const maskedPayload = {
    ...(mask(body.payload) as Record<string, unknown> | null ?? {}),
    ...(body.syncJobId ? { syncJobId: body.syncJobId } : {}),
    ...(body.stepName ? { stepName: body.stepName } : {})
  };

  // Build the OpenSearch document with all available tags
  const osDoc: Record<string, unknown> = {
    "@timestamp": now.toISOString(),
    severity: body.severity,
    source: body.source,
    message: body.message,
    correlationId: body.correlationId ?? null,
    durationMs: body.durationMs ?? null,
    payload: mask(body.payload) ?? null,
    // RAG sync tags
    syncJobId: body.syncJobId ?? null,
    stepName: body.stepName ?? null
  };

  // Postgres log entry (existing schema)
  const log = await prisma.platformLog.create({
    data: {
      severity: body.severity,
      source: body.source,
      maskedPayload,
      message: body.message,
      correlationId: body.correlationId ?? body.syncJobId,
      durationMs: body.durationMs
    }
  });

  // Ship to OpenSearch (non-blocking — failure doesn't fail the ingest)
  void shipToOpenSearch(osDoc);

  return reply.code(201).send(log);
});

app.get("/logs", async (request) => {
  const query = request.query as {
    severity?: string;
    source?: string;
    correlationId?: string;
    messageContains?: string;
    from?: string;
    to?: string;
    limit?: string;
  };
  const limit = Math.min(Math.max(Number(query.limit ?? "200"), 1), 500);

  const where = {
    severity: query.severity,
    source: query.source,
    correlationId: query.correlationId,
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

  return prisma.platformLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: limit
  });
});

app.get("/logs/timeline", async (request) => {
  const query = request.query as { correlationId?: string; from?: string; to?: string; limit?: string };
  const limit = Math.min(Math.max(Number(query.limit ?? "200"), 1), 500);

  const logs = await prisma.platformLog.findMany({
    where: {
      correlationId: query.correlationId,
      ...((query.from || query.to)
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {})
            }
          }
        : {})
    },
    orderBy: { createdAt: "asc" },
    take: limit
  });

  const events = logs.map((item) => ({
    type: "PLATFORM_LOG" as const,
    timestamp: item.createdAt,
    data: {
      severity: item.severity,
      source: item.source,
      message: item.message,
      durationMs: item.durationMs,
      correlationId: item.correlationId,
      payload: item.maskedPayload
    }
  }));

  return { events };
});

/**
 * Query OpenSearch for RAG sync workflow logs filtered by syncJobId.
 * Returns logs tagged with a specific sync job, optionally filtered by step name.
 * Used by the frontend Sync Process Monitor log drawer.
 */
app.get("/logs/sync-job", async (request, reply) => {
  const query = request.query as {
    syncJobId?: string;
    stepName?: string;
    limit?: string;
  };
  const syncJobId = String(query.syncJobId ?? "").trim();
  if (!syncJobId) {
    return reply.code(400).send({ error: "SYNC_JOB_ID_REQUIRED" });
  }
  const limit = Math.min(Math.max(Number(query.limit ?? "100"), 1), 500);

  // Query OpenSearch
  const baseUrl = config.opensearchUrl.replace(/\/+$/, "");
  const mustClauses: Record<string, unknown>[] = [
    { term: { syncJobId } }
  ];
  if (query.stepName) {
    mustClauses.push({ term: { stepName: query.stepName } });
  }

  const osQuery = {
    size: limit,
    sort: [{ "@timestamp": { order: "asc" } }],
    query: {
      bool: { must: mustClauses }
    }
  };

  try {
    const response = await fetch(`${baseUrl}/platform-logs-*/_search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(osQuery)
    });

    if (!response.ok) {
      // Fall back to Postgres query on OpenSearch failure
      const pgLogs = await prisma.platformLog.findMany({
        where: { correlationId: syncJobId },
        orderBy: { createdAt: "asc" },
        take: limit
      });
      const filtered = query.stepName
        ? pgLogs.filter((log) => {
            const payload = (log.maskedPayload ?? {}) as Record<string, unknown>;
            return String(payload.stepName ?? "") === query.stepName;
          })
        : pgLogs;
      return { source: "postgres", logs: filtered };
    }

    const result = await response.json() as { hits?: { hits?: Array<{ _source: Record<string, unknown> }> } };
    const hits = result.hits?.hits ?? [];
    return {
      source: "opensearch",
      logs: hits.map((hit) => hit._source)
    };
  } catch (error) {
    // OpenSearch unavailable — fall back to Postgres
    const pgLogs = await prisma.platformLog.findMany({
      where: { correlationId: syncJobId },
      orderBy: { createdAt: "asc" },
      take: limit
    });
    const filtered = query.stepName
      ? pgLogs.filter((log) => {
          const payload = (log.maskedPayload ?? {}) as Record<string, unknown>;
          return String(payload.stepName ?? "") === query.stepName;
        })
      : pgLogs;
    return { source: "postgres", logs: filtered };
  }
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
