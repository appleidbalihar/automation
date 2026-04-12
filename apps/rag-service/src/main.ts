import Fastify from "fastify";
import amqp from "amqplib";
import type { Channel, ChannelModel, ConsumeMessage } from "amqplib";
import { loadConfig } from "@platform/config";
import { PlatformEvents } from "@platform/contracts";
import { prisma } from "@platform/db";
import { createCorrelationId } from "@platform/observability";
import { connectAmqp, createTlsRuntime } from "@platform/tls-runtime";
import { EventPublisher } from "./events.js";
import { buildSourceDocuments } from "./indexing.js";

const config = loadConfig("rag-service", 4006);
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
const RAG_INDEX_WORKER_QUEUE = "rag-service.index-worker.v1";

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function startRagIndexWorker(): Promise<{ connection: ChannelModel; channel: Channel } | undefined> {
  try {
    const connection = (await connectAmqp(tlsRuntime, amqp.connect, config.rabbitmqUrl)) as ChannelModel;
    const channel = await connection.createChannel();
    await channel.assertExchange("platform.events", "topic", { durable: true });
    await channel.assertQueue(RAG_INDEX_WORKER_QUEUE, { durable: true });
    await channel.bindQueue(RAG_INDEX_WORKER_QUEUE, "platform.events", PlatformEvents.ragIndexRequested);
    await channel.consume(
      RAG_INDEX_WORKER_QUEUE,
      async (message: ConsumeMessage | null) => {
        if (!message) return;
        let jobId: string | undefined;
        try {
          const decoded = tryParseJson(message.content.toString("utf8")) as
            | {
                timestamp?: string;
                payload?: { source?: string; documents?: number; correlationId?: string };
              }
            | undefined;

          const source = decoded?.payload?.source ?? "manual";
          const requestedDocuments =
            typeof decoded?.payload?.documents === "number" ? Math.max(0, decoded.payload.documents) : undefined;
          const correlationId = decoded?.payload?.correlationId;
          const docs = buildSourceDocuments(source, requestedDocuments);

          const job = await prisma.ragIndexJob.create({
            data: {
              source,
              requestedDocuments,
              correlationId,
              status: "RUNNING"
            }
          });
          jobId = job.id;

          for (const doc of docs) {
            await prisma.ragDocument.upsert({
              where: {
                source_externalId: {
                  source,
                  externalId: doc.externalId
                }
              },
              create: {
                source,
                externalId: doc.externalId,
                title: doc.title,
                text: doc.text
              },
              update: {
                title: doc.title,
                text: doc.text
              }
            });
          }

          await prisma.ragIndexJob.update({
            where: { id: job.id },
            data: {
              status: "COMPLETED",
              requestedDocuments: docs.length,
              processedAt: decoded?.timestamp ? new Date(decoded.timestamp) : new Date()
            }
          });
          channel.ack(message);
        } catch (error) {
          if (jobId) {
            await prisma.ragIndexJob.update({
              where: { id: jobId },
              data: {
                status: "FAILED",
                errorMessage: error instanceof Error ? error.message : String(error),
                processedAt: new Date()
              }
            });
          }
          console.warn("[rag-service] index worker failed", error instanceof Error ? error.message : String(error));
          channel.nack(message, false, true);
        }
      },
      { noAck: false }
    );
    return { connection, channel };
  } catch (error) {
    console.warn("[rag-service] index worker disabled", error instanceof Error ? error.message : String(error));
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

app.post("/rag/search", async (request) => {
  const body = request.body as { query: string; source?: string; limit?: number };
  const query = body.query.trim();
  const limit = Math.min(Math.max(body.limit ?? 5, 1), 20);
  const results = await prisma.ragDocument.findMany({
    where: {
      ...(body.source ? { source: body.source } : {}),
      OR: [
        { title: { contains: query, mode: "insensitive" } },
        { text: { contains: query, mode: "insensitive" } }
      ]
    },
    orderBy: { updatedAt: "desc" },
    take: limit
  });
  return { results };
});

app.post("/rag/index", async (request) => {
  const body = request.body as { source?: string; documents?: number } | undefined;
  const correlationId = String(request.headers["x-correlation-id"] ?? createCorrelationId("rag-index"));
  await eventPublisher.publish(PlatformEvents.ragIndexRequested, {
    source: body?.source ?? "manual",
    documents: body?.documents,
    correlationId
  });
  return { queued: true, event: PlatformEvents.ragIndexRequested, correlationId };
});

app.get("/rag/jobs", async () => {
  return prisma.ragIndexJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 200
  });
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
  worker = await startRagIndexWorker();
}

start().catch((error) => {
  process.stderr.write(`[rag-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
