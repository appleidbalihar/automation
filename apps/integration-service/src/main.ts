import Fastify from "fastify";
import { loadConfig } from "@platform/config";
import type { ExecutionType } from "@platform/contracts";
import { createTlsRuntime, tlsFetch } from "@platform/tls-runtime";
import { executeIntegration } from "./adapters.js";

const config = loadConfig("integration-service", 4004);
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

app.get("/health", async () => ({ ok: true, service: config.serviceName }));

app.get("/security/tls", async (request, reply) => {
  const token = String(request.headers["x-security-token"] ?? "");
  if (tlsRuntime.diagnosticsToken && token !== tlsRuntime.diagnosticsToken) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
  return tlsRuntime.getStatus();
});

async function emitIntegrationAudit(entry: {
  orderId?: string;
  nodeId?: string;
  stepId?: string;
  executionType: ExecutionType;
  commandRef: string;
  status: "SUCCESS" | "FAILED";
  durationMs: number;
  payload?: Record<string, unknown>;
  error?: string;
  policy?: {
    allowed: boolean;
    rule: string;
    reason?: string;
  };
}): Promise<void> {
  if (!entry.orderId) return;
  await tlsFetch(tlsRuntime, new URL("/logs/ingest", config.loggingServiceUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      orderId: entry.orderId,
      nodeId: entry.nodeId,
      stepId: entry.stepId,
      severity: entry.status === "SUCCESS" ? "INFO" : "ERROR",
      source: "integration-service",
      payload: {
        executionType: entry.executionType,
        commandRef: entry.commandRef,
        policy: entry.policy,
        ...entry.payload
      },
      message: entry.error ?? `Integration ${entry.status.toLowerCase()} for ${entry.executionType}`,
      durationMs: entry.durationMs
    })
  });
}

app.post("/integrations/execute", async (request, reply) => {
  const body = request.body as {
    executionType: ExecutionType;
    commandRef: string;
    input?: Record<string, unknown>;
    timeoutMs?: number;
    metadata?: {
      orderId?: string;
      nodeId?: string;
      stepId?: string;
    };
  };
  const result = await executeIntegration({
    executionType: body.executionType,
    commandRef: body.commandRef,
    input: body.input,
    timeoutMs: body.timeoutMs
  });
  emitIntegrationAudit({
    orderId: body.metadata?.orderId,
    nodeId: body.metadata?.nodeId,
    stepId: body.metadata?.stepId,
    executionType: body.executionType,
    commandRef: body.commandRef,
    status: result.status,
    durationMs: result.durationMs,
    payload: (result.output as Record<string, unknown> | undefined) ?? {},
    error: result.error,
    policy: result.policy
  }).catch(() => {
    return;
  });
  reply.code(result.status === "SUCCESS" ? 200 : 500).send(result);
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
  process.stderr.write(`[integration-service] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
