import Fastify from "fastify";
import { loadConfig } from "@platform/config";
import { prisma } from "@platform/db";
import type { ChatQuery, ChatResponse } from "@platform/contracts";
import { createTlsRuntime } from "@platform/tls-runtime";
import { buildOperationalAnswer } from "./answers.js";

const config = loadConfig("chat-service", 4007);
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

async function createOperationalAnswer(payload: ChatQuery): Promise<ChatResponse> {
  let orderContext:
    | {
        id: string;
        status: string;
        currentNodeOrder: number;
        currentStepIndex: number;
        lastError?: string | null;
        checkpoints: Array<{ nodeOrder: number; stepIndex: number }>;
      }
    | undefined;
  let workflowContext:
    | {
        id: string;
        name: string;
        latestVersion?: { version: number; status: string };
      }
    | undefined;

  if (payload.orderId) {
    const order = await prisma.order.findUnique({
      where: { id: payload.orderId },
      include: {
        checkpoints: { orderBy: { createdAt: "desc" }, take: 1 }
      }
    });
    if (order) {
      orderContext = {
        id: order.id,
        status: order.status,
        currentNodeOrder: order.currentNodeOrder,
        currentStepIndex: order.currentStepIndex,
        lastError: order.lastError,
        checkpoints: order.checkpoints.map((checkpoint) => ({
          nodeOrder: checkpoint.nodeOrder,
          stepIndex: checkpoint.stepIndex
        }))
      };
    }
  }

  if (payload.workflowId) {
    const workflow = await prisma.workflow.findUnique({
      where: { id: payload.workflowId },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1
        }
      }
    });
    if (workflow) {
      const latestVersion = workflow.versions[0]
        ? {
            version: workflow.versions[0].version,
            status: workflow.versions[0].status
          }
        : undefined;
      workflowContext = {
        id: workflow.id,
        name: workflow.name,
        latestVersion
      };
    }
  }

  return buildOperationalAnswer(payload, { order: orderContext, workflow: workflowContext });
}

app.get("/health", async () => ({ ok: true, service: config.serviceName }));

app.get("/security/tls", async (request, reply) => {
  const token = String(request.headers["x-security-token"] ?? "");
  if (tlsRuntime.diagnosticsToken && token !== tlsRuntime.diagnosticsToken) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
  return tlsRuntime.getStatus();
});

app.post("/chat/query", async (request, reply) => {
  const body = request.body as ChatQuery;
  const response = await createOperationalAnswer(body);
  await prisma.chatHistory.create({
    data: {
      userId: body.userId,
      query: body.query,
      answer: response.answer,
      workflowId: body.workflowId,
      orderId: body.orderId
    }
  });
  return reply.code(200).send(response);
});

app.get("/chat/history/:userId", async (request) => {
  const { userId } = request.params as { userId: string };
  return prisma.chatHistory.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 50
  });
});

app.addHook("onClose", async () => {
  await tlsRuntime.close();
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
  process.stderr.write(`[chat-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
