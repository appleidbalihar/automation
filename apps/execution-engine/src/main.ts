import Fastify from "fastify";
import { loadConfig } from "@platform/config";
import type { WorkflowNode, WorkflowStep } from "@platform/contracts";
import { runWorkflowFromCheckpoint } from "@platform/engine-core";
import { createTlsRuntime, tlsFetch } from "@platform/tls-runtime";
import { validateWorkflowNodes } from "./validation.js";

const config = loadConfig("execution-engine", 4003);
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

interface EngineValidateRequest {
  workflowNodes: WorkflowNode[];
}

interface EngineRunRequest {
  order: {
    id: string;
    currentNodeOrder: number;
    currentStepIndex: number;
    failurePolicy: "RETRY" | "CONTINUE" | "ROLLBACK";
  };
  workflowNodes: WorkflowNode[];
  input?: Record<string, unknown>;
  environmentVariables?: Record<string, unknown>;
  integrationProfilesByNode?: Record<
    string,
    {
      id: string;
      executionType?: "REST" | "SSH" | "NETCONF" | "SCRIPT";
      authType?: "NO_AUTH" | "OAUTH2" | "BASIC" | "MTLS" | "API_KEY" | "OIDC" | "JWT";
      baseConfig?: Record<string, unknown>;
      credentials?: Record<string, unknown>;
    }
  >;
  nodeEnvironmentsByNode?: Record<string, Record<string, unknown>>;
  approvedNodeOrders?: number[];
}

app.get("/health", async () => ({ ok: true, service: config.serviceName }));

app.get("/security/tls", async (request, reply) => {
  const token = String(request.headers["x-security-token"] ?? "");
  if (tlsRuntime.diagnosticsToken && token !== tlsRuntime.diagnosticsToken) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
  return tlsRuntime.getStatus();
});

app.get("/engine/capabilities", async () => ({
  checkpointResume: true,
  retryPolicy: true,
  rollbackPolicy: true,
  approvalState: true,
  adapters: ["REST", "SSH", "NETCONF", "SCRIPT"],
  endpoints: ["/engine/validate-workflow", "/engine/run"]
}));

app.post("/engine/validate-workflow", async (request, reply) => {
  const body = request.body as EngineValidateRequest;
  const errors = validateWorkflowNodes(body.workflowNodes ?? []);
  if (errors.length > 0) {
    return reply.code(400).send({
      valid: false,
      errors
    });
  }
  return { valid: true, errors: [] };
});

app.post("/engine/run", async (request, reply) => {
  const body = request.body as EngineRunRequest;
  const workflowNodes = body.workflowNodes ?? [];
  const validationErrors = validateWorkflowNodes(workflowNodes);
  if (validationErrors.length > 0) {
    return reply.code(400).send({ error: "INVALID_WORKFLOW", validationErrors });
  }

  const checkpoints: Array<{ nodeOrder: number; stepIndex: number }> = [];
  const audits: Array<{
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
  }> = [];

  const result = await runWorkflowFromCheckpoint({
    order: body.order,
    workflowNodes,
    input: body.input ?? {},
    approvedNodeOrders: body.approvedNodeOrders,
    checkpointStore: {
      async save(_orderId, nodeOrder, stepIndex): Promise<void> {
        checkpoints.push({ nodeOrder, stepIndex });
      }
    },
    adapter: {
      async run(nodeId: string, step: WorkflowStep, input: Record<string, unknown>): Promise<{
        ok: boolean;
        error?: string;
        requestPayload?: Record<string, unknown>;
        responsePayload?: Record<string, unknown>;
      }> {
        const integrationProfile = body.integrationProfilesByNode?.[nodeId];
        const environmentVariables = body.environmentVariables ?? {};
        const nodeEnvironment = body.nodeEnvironmentsByNode?.[nodeId] ?? {};
        const effectiveEnvironment = {
          ...environmentVariables,
          ...nodeEnvironment
        };
        const mergedInput = {
          ...input,
          env: effectiveEnvironment,
          integrationConfig: {
            ...(integrationProfile?.baseConfig ?? {}),
            authType: integrationProfile?.authType
          },
          integrationCredentials: integrationProfile?.credentials ?? {},
          stepInputVariables: step.inputVariables ?? {}
        };
        const executionType = integrationProfile?.executionType ?? step.executionType;
        const requestPayload = {
          executionType,
          commandRef: step.commandRef,
          integrationProfileId: integrationProfile?.id,
          environmentKeys: Object.keys(effectiveEnvironment).length
        };
        let raw = "";
        try {
          const response = await tlsFetch(tlsRuntime, new URL("/integrations/execute", config.integrationServiceUrl), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              executionType,
              commandRef: step.commandRef,
              input: mergedInput,
              metadata: {
                orderId: body.order.id,
                nodeId,
                stepId: step.id,
                integrationProfileId: integrationProfile?.id
              }
            })
          });
          raw = await response.text();
          const parsed = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {};
          const status = String(parsed.status ?? "");
          const integrationError = typeof parsed.error === "string" ? parsed.error : undefined;
          if (!response.ok || status === "FAILED") {
            return {
              ok: false,
              error: integrationError ?? `Integration call failed for ${step.executionType}/${step.commandRef}`,
              requestPayload,
              responsePayload: parsed
            };
          }
          return {
            ok: true,
            requestPayload,
            responsePayload: parsed
          };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : "Integration execution request failed",
            requestPayload,
            responsePayload: raw ? { raw } : undefined
          };
        }
      }
    },
    auditStore: {
      async record(entry): Promise<void> {
        audits.push({
          nodeId: entry.nodeId,
          stepId: entry.stepId,
          status: entry.status,
          retryCount: entry.retryCount,
          durationMs: entry.durationMs,
          errorMessage: entry.errorMessage,
          requestPayload: entry.requestPayload,
          responsePayload: entry.responsePayload,
          startedAt: entry.startedAt,
          finishedAt: entry.finishedAt
        });
      }
    }
  });

  return reply.code(200).send({
    result,
    checkpoints,
    audits
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
  process.stderr.write(`[execution-engine] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
