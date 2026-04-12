// @ts-nocheck
import Fastify from "fastify";
import { appendFile, mkdir } from "node:fs/promises";
import { connect as connectTls } from "node:tls";
import amqp from "amqplib";
import type { Channel, ChannelModel } from "amqplib";
import { authHook, requireAnyRole } from "@platform/auth";
import { loadConfig } from "@platform/config";
import { PlatformEvents } from "@platform/contracts";
import { createCorrelationId, logInfo } from "@platform/observability";
import { connectAmqp, createTlsRuntime, tlsFetch } from "@platform/tls-runtime";

const config = loadConfig("api-gateway", 4000);
const tlsRuntime = createTlsRuntime({
  serviceName: config.serviceName,
  enabled: config.mtlsRequired,
  certPath: config.tlsCertPath,
  keyPath: config.tlsKeyPath,
  caPath: config.tlsCaPath,
  requestCert: false,
  rejectUnauthorized: false,
  verifyPeer: config.tlsVerifyPeer,
  serverName: config.tlsServerName,
  reloadDebounceMs: config.tlsReloadDebounceMs,
  diagnosticsToken: config.securityDiagnosticsToken
});
const app: any = Fastify({
  logger: false,
  https: tlsRuntime.getServerOptions()
});

type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
type CertSeverity = "OK" | "WARNING" | "CRITICAL";

const CERT_CONTROL_ORDER_ID = "cert-control-global";
const CERT_SCAN_INTERVAL_MS = Math.max(30000, Number(process.env.CERT_SCAN_INTERVAL_MS ?? "300000"));
const CERT_WARNING_DAYS = Math.max(1, Number(process.env.CERT_WARNING_DAYS ?? "7"));
const CERT_CRITICAL_DAYS = Math.max(1, Number(process.env.CERT_CRITICAL_DAYS ?? "3"));
const CERT_ALERT_WEBHOOK_URL = String(process.env.CERT_ALERT_WEBHOOK_URL ?? "").trim();
const ROTATION_CONTROL_DIR = String(process.env.ROTATION_CONTROL_DIR ?? "/rotation-control").trim() || "/rotation-control";
const ROTATION_QUEUE_FILE = `${ROTATION_CONTROL_DIR}/requests.jsonl`;
const SYSTEM_SERVICE_USER = "system/cert-monitor";
const alertHistory: Array<Record<string, unknown>> = [];
const pendingRotationByService = new Map<string, { requestId: string; queuedAt: string; trigger: string }>();

interface CertTarget {
  service: string;
  url: string;
  mode: "security-endpoint" | "tls-handshake";
  rotationTargets: string[];
}

const certTargets: CertTarget[] = [
  { service: "api-gateway", url: "https://api-gateway:4000", mode: "security-endpoint", rotationTargets: ["api-gateway-vault-agent"] },
  { service: "workflow-service", url: config.workflowServiceUrl, mode: "security-endpoint", rotationTargets: ["workflow-service-vault-agent"] },
  { service: "order-service", url: config.orderServiceUrl, mode: "security-endpoint", rotationTargets: ["order-service-vault-agent"] },
  { service: "execution-engine", url: config.executionEngineServiceUrl, mode: "security-endpoint", rotationTargets: ["execution-engine-vault-agent"] },
  { service: "integration-service", url: config.integrationServiceUrl, mode: "security-endpoint", rotationTargets: ["integration-service-vault-agent"] },
  { service: "logging-service", url: config.loggingServiceUrl, mode: "security-endpoint", rotationTargets: ["logging-service-vault-agent"] },
  { service: "rag-service", url: config.ragServiceUrl, mode: "security-endpoint", rotationTargets: ["rag-service-vault-agent"] },
  { service: "chat-service", url: config.chatServiceUrl, mode: "security-endpoint", rotationTargets: ["chat-service-vault-agent"] },
  { service: "keycloak", url: config.keycloakUrl, mode: "tls-handshake", rotationTargets: ["keycloak-vault-agent", "keycloak"] }
];

const certStatusByService = new Map<string, Record<string, unknown>>();
let certScanTimer: NodeJS.Timeout | undefined;
const certScanKickTimers = new Set<NodeJS.Timeout>();
let certScanInFlight = false;

class EventPublisher {
  private connection?: ChannelModel;
  private channel?: Channel;
  private connecting?: Promise<void>;

  constructor(
    private readonly rabbitmqUrl: string,
    private readonly exchange: string = "platform.events"
  ) {}

  private async connect(): Promise<void> {
    if (this.channel) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }
    this.connecting = (async () => {
      this.connection = (await connectAmqp(tlsRuntime, amqp.connect, this.rabbitmqUrl)) as ChannelModel;
      const channel = await this.connection.createChannel();
      await channel.assertExchange(this.exchange, "topic", { durable: true });
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
      const envelope = {
        event,
        timestamp: new Date().toISOString(),
        payload
      };
      this.channel.publish(this.exchange, event, Buffer.from(JSON.stringify(envelope)), {
        contentType: "application/json",
        persistent: true
      });
    } catch (error) {
      logInfo("cert-event publish failed", {
        event,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  async close(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}

const eventPublisher = new EventPublisher(config.rabbitmqUrl);

async function proxy(
  request: any,
  reply: any,
  method: HttpMethod,
  baseUrl: string,
  path: string
): Promise<void> {
  const query = request.query as Record<string, string | number | boolean | undefined>;
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers: Record<string, string> = {
    "x-correlation-id": String(request.headers["x-correlation-id"] ?? "")
  };
  if (request.auth?.userId) {
    headers["x-user-id"] = request.auth.userId;
  }
  if (request.auth?.roles?.length) {
    headers["x-user-roles"] = request.auth.roles.join(",");
  }
  if (request.headers.authorization) {
    headers.authorization = request.headers.authorization;
  }

  const init: RequestInit = {
    method,
    headers
  };
  if (method !== "GET" && request.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(request.body);
  }

  try {
    const response = await tlsFetch(tlsRuntime, url, init);
    const raw = await response.text();
    const payload = raw.length > 0 ? JSON.parse(raw) : {};
    reply.code(response.status).send(payload);
  } catch (error) {
    reply.code(502).send({
      error: "UPSTREAM_UNAVAILABLE",
      target: url.toString(),
      details: error instanceof Error ? error.message : "Unknown upstream error"
    });
  }
}

async function dependencyHealth(name: string, baseUrl: string): Promise<{ service: string; ok: boolean; status: number | null; details?: unknown }> {
  const healthUrl = new URL("/health", baseUrl);
  try {
    const response = await tlsFetch(tlsRuntime, healthUrl);
    const raw = await response.text();
    const payload = raw.length > 0 ? JSON.parse(raw) : {};
    return {
      service: name,
      ok: response.ok,
      status: response.status,
      details: payload
    };
  } catch (error) {
    return {
      service: name,
      ok: false,
      status: null,
      details: error instanceof Error ? error.message : "Unknown error"
    };
  }
}

function pushAlertHistory(entry: Record<string, unknown>): void {
  alertHistory.unshift(entry);
  if (alertHistory.length > 500) {
    alertHistory.length = 500;
  }
}

function scheduleCertificateScan(delayMs: number = 4000): void {
  const timer = setTimeout(() => {
    certScanKickTimers.delete(timer);
    runCertificateScan().catch((error) =>
      logInfo("Certificate scan after rotation failed", {
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }, Math.max(500, delayMs));
  certScanKickTimers.add(timer);
}

function isPendingRotationComplete(
  pending: { requestId: string; queuedAt: string; trigger: string },
  previous: Record<string, unknown> | undefined,
  current: Record<string, unknown>
): boolean {
  const queuedAtEpoch = Date.parse(pending.queuedAt);
  const lastReloadAt = typeof current.lastReloadAt === "string" ? current.lastReloadAt : "";
  const lastReloadEpoch = Date.parse(lastReloadAt);
  if (!Number.isNaN(lastReloadEpoch) && (Number.isNaN(queuedAtEpoch) || lastReloadEpoch >= queuedAtEpoch)) {
    return true;
  }

  const previousFingerprint = typeof previous?.fingerprint === "string" ? previous.fingerprint : "";
  const currentFingerprint = typeof current.fingerprint === "string" ? current.fingerprint : "";
  if (previousFingerprint.length > 0 && currentFingerprint.length > 0 && previousFingerprint !== currentFingerprint) {
    return true;
  }

  return false;
}

function toDaysRemaining(validTo?: string): number | null {
  if (!validTo) return null;
  const expiresAt = Date.parse(validTo);
  if (Number.isNaN(expiresAt)) return null;
  return Math.floor((expiresAt - Date.now()) / (1000 * 60 * 60 * 24));
}

function classifySeverity(input: {
  daysRemaining: number | null;
  reloadFailures: number;
  healthOk: boolean;
  error?: string;
}): CertSeverity {
  if (!input.healthOk || input.reloadFailures > 0 || input.error) return "CRITICAL";
  if (input.daysRemaining === null) return "WARNING";
  if (input.daysRemaining <= CERT_CRITICAL_DAYS) return "CRITICAL";
  if (input.daysRemaining <= CERT_WARNING_DAYS) return "WARNING";
  return "OK";
}

function parseUrlParts(endpoint: string): { host: string; port: number; servername: string } {
  const url = new URL(endpoint);
  const protocol = url.protocol.toLowerCase();
  const defaultPort = protocol === "https:" ? 443 : 80;
  return {
    host: url.hostname,
    port: Number(url.port || defaultPort),
    servername: url.hostname
  };
}

async function inspectPeerCertificate(endpoint: string): Promise<{
  validFrom?: string;
  validTo?: string;
  fingerprint?: string;
  subjectAltName?: string;
  authorized: boolean;
  authorizationError?: string;
}> {
  const { host, port, servername } = parseUrlParts(endpoint);
  return new Promise((resolve, reject) => {
    const socket = connectTls(
      {
        host,
        port,
        servername,
        ca: tlsRuntime.getServerOptions()?.ca,
        cert: tlsRuntime.getServerOptions()?.cert,
        key: tlsRuntime.getServerOptions()?.key,
        rejectUnauthorized: config.tlsVerifyPeer
      },
      () => {
        const cert = socket.getPeerCertificate();
        resolve({
          validFrom: cert?.valid_from,
          validTo: cert?.valid_to,
          fingerprint: cert?.fingerprint256,
          subjectAltName: cert?.subjectaltname,
          authorized: socket.authorized,
          authorizationError: socket.authorizationError || undefined
        });
        socket.end();
      }
    );
    socket.once("error", reject);
  });
}

async function logCertEvent(entry: {
  service: string;
  event: string;
  severity: string;
  message: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const correlationId = createCorrelationId();
  await tlsFetch(tlsRuntime, new URL("/logs/ingest", config.loggingServiceUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-correlation-id": correlationId,
      "x-user-id": SYSTEM_SERVICE_USER,
      "x-user-roles": "admin"
    },
    body: JSON.stringify({
      orderId: CERT_CONTROL_ORDER_ID,
      severity: entry.severity,
      source: "cert-control",
      message: entry.message,
      payload: {
        event: entry.event,
        service: entry.service,
        ...entry.payload
      },
      correlationId
    })
  }).catch(() => undefined);
}

async function sendWebhookAlert(payload: Record<string, unknown>): Promise<void> {
  if (!CERT_ALERT_WEBHOOK_URL) return;
  const response = await fetch(CERT_ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error(`Webhook HTTP_${response.status}`);
  }
}

async function enqueueRotationRequest(input: {
  service: string;
  trigger: "manual" | "policy";
  requestedBy: string;
  reason?: string;
  rotationTargets: string[];
}): Promise<{ requestId: string; queuedAt: string }> {
  const existing = pendingRotationByService.get(input.service);
  if (existing) {
    return { requestId: existing.requestId, queuedAt: existing.queuedAt };
  }

  const requestId = `rot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const queuedAt = new Date().toISOString();
  const entry = {
    requestId,
    service: input.service,
    trigger: input.trigger,
    requestedBy: input.requestedBy,
    reason: input.reason ?? "",
    rotationTargets: input.rotationTargets,
    queuedAt
  };
  await mkdir(ROTATION_CONTROL_DIR, { recursive: true });
  const line = [
    entry.requestId,
    entry.service,
    entry.trigger,
    entry.requestedBy.replace(/\|/g, "_"),
    entry.queuedAt,
    entry.rotationTargets.join(",")
  ].join("|");
  await appendFile(ROTATION_QUEUE_FILE, `${line}\n`, "utf8");
  pendingRotationByService.set(input.service, { requestId, queuedAt, trigger: input.trigger });
  return { requestId, queuedAt };
}

async function publishCertificateAlert(entry: {
  service: string;
  severity: CertSeverity;
  event: string;
  payload: Record<string, unknown>;
  message: string;
}): Promise<void> {
  const alert = {
    eventType: entry.event,
    severity: entry.severity,
    service: entry.service,
    timestamp: new Date().toISOString(),
    ...entry.payload
  };
  pushAlertHistory(alert);
  await eventPublisher.publish(entry.event, alert);
  await logCertEvent({
    service: entry.service,
    event: entry.event,
    severity: entry.severity === "CRITICAL" ? "ERROR" : "INFO",
    message: entry.message,
    payload: entry.payload
  });
  try {
    await sendWebhookAlert(alert);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await eventPublisher.publish(PlatformEvents.certWebhookDeliveryFailed, {
      ...alert,
      error: message
    });
    await logCertEvent({
      service: entry.service,
      event: PlatformEvents.certWebhookDeliveryFailed,
      severity: "ERROR",
      message: `Certificate webhook delivery failed: ${message}`,
      payload: { ...entry.payload, error: message }
    });
  }
}

async function collectCertificateStatus(target: CertTarget): Promise<Record<string, unknown>> {
  const nowIso = new Date().toISOString();
  try {
    if (target.mode === "security-endpoint") {
      const tlsUrl = new URL("/security/tls", target.url);
      const healthUrl = new URL("/health", target.url);
      const headers: Record<string, string> = {};
      if (config.securityDiagnosticsToken) {
        headers["x-security-token"] = config.securityDiagnosticsToken;
      }
      const [tlsResponse, healthResponse] = await Promise.all([tlsFetch(tlsRuntime, tlsUrl, { headers }), tlsFetch(tlsRuntime, healthUrl)]);
      const tlsPayload = tlsResponse.ok ? ((await tlsResponse.json()) as Record<string, unknown>) : {};
      const healthOk = healthResponse.ok;
      const validTo = typeof tlsPayload.validTo === "string" ? tlsPayload.validTo : undefined;
      const reloadFailures = Number(tlsPayload.reloadFailures ?? 0);
      const daysRemaining = toDaysRemaining(validTo);
      const severity = classifySeverity({ daysRemaining, reloadFailures, healthOk });
      return {
        service: target.service,
        endpoint: target.url,
        mode: target.mode,
        healthOk,
        validFrom: typeof tlsPayload.validFrom === "string" ? tlsPayload.validFrom : undefined,
        validTo,
        daysRemaining,
        fingerprint: typeof tlsPayload.fingerprint === "string" ? tlsPayload.fingerprint : undefined,
        subjectAltName: typeof tlsPayload.subjectAltName === "string" ? tlsPayload.subjectAltName : undefined,
        reloadFailures,
        lastReloadAt: typeof tlsPayload.lastReloadAt === "string" ? tlsPayload.lastReloadAt : undefined,
        severity,
        checkedAt: nowIso
      };
    }

    const cert = await inspectPeerCertificate(target.url);
    const daysRemaining = toDaysRemaining(cert.validTo);
    const severity = classifySeverity({
      daysRemaining,
      reloadFailures: 0,
      healthOk: cert.authorized,
      error: cert.authorizationError
    });
    return {
      service: target.service,
      endpoint: target.url,
      mode: target.mode,
      healthOk: cert.authorized,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
      daysRemaining,
      fingerprint: cert.fingerprint,
      subjectAltName: cert.subjectAltName,
      reloadFailures: 0,
      lastReloadAt: undefined,
      severity,
      checkedAt: nowIso,
      error: cert.authorizationError
    };
  } catch (error) {
    return {
      service: target.service,
      endpoint: target.url,
      mode: target.mode,
      healthOk: false,
      validFrom: undefined,
      validTo: undefined,
      daysRemaining: null,
      fingerprint: undefined,
      subjectAltName: undefined,
      reloadFailures: 0,
      lastReloadAt: undefined,
      severity: "CRITICAL",
      checkedAt: nowIso,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runCertificateScan(): Promise<void> {
  if (certScanInFlight) return;
  certScanInFlight = true;
  try {
    const rows = await Promise.all(certTargets.map((target) => collectCertificateStatus(target)));
    for (const row of rows) {
      const service = String(row.service);
      const previous = certStatusByService.get(service);
      certStatusByService.set(service, row);
      const severity = String(row.severity ?? "OK") as CertSeverity;
      const previousSeverity = previous ? (String(previous.severity ?? "OK") as CertSeverity) : undefined;

      const basePayload = {
        endpoint: row.endpoint,
        validTo: row.validTo,
        daysRemaining: row.daysRemaining,
        fingerprint: row.fingerprint,
        reloadFailures: row.reloadFailures,
        error: row.error
      };

      if (severity === "WARNING" && previousSeverity !== undefined && previousSeverity !== "WARNING") {
        await publishCertificateAlert({
          service,
          severity,
          event: PlatformEvents.certExpiryWarning,
          payload: basePayload,
          message: `Certificate warning for ${service}: expires in ${String(row.daysRemaining ?? "unknown")} day(s)`
        });
      }

      if (severity === "CRITICAL" && previousSeverity !== undefined && previousSeverity !== "CRITICAL") {
        const criticalEvent =
          Number(row.reloadFailures ?? 0) > 0 ? PlatformEvents.certReloadFailed : PlatformEvents.certExpiryCritical;
        await publishCertificateAlert({
          service,
          severity,
          event: criticalEvent,
          payload: basePayload,
          message: `Certificate critical condition for ${service}`
        });

        const target = certTargets.find((entry) => entry.service === service);
        if (target) {
          const op = await enqueueRotationRequest({
            service,
            trigger: "policy",
            requestedBy: SYSTEM_SERVICE_USER,
            reason: `Auto remediation due to ${criticalEvent}`,
            rotationTargets: target.rotationTargets
          }).catch(() => undefined);

          if (op) {
            pushAlertHistory({
              eventType: PlatformEvents.certRotationTriggered,
              severity: "INFO",
              service,
              timestamp: new Date().toISOString(),
              requestId: op.requestId,
              trigger: "policy"
            });
            await eventPublisher.publish(PlatformEvents.certRotationTriggered, {
              service,
              requestId: op.requestId,
              queuedAt: op.queuedAt,
              trigger: "policy"
            });
          }
        }
      }

      const pending = pendingRotationByService.get(service);
      if (pending && (severity === "OK" || isPendingRotationComplete(pending, previous, row))) {
        pendingRotationByService.delete(service);
        pushAlertHistory({
          eventType: PlatformEvents.certRotationCompleted,
          severity: "INFO",
          service,
          timestamp: new Date().toISOString(),
          requestId: pending.requestId
        });
        await eventPublisher.publish(PlatformEvents.certRotationCompleted, {
          service,
          requestId: pending.requestId,
          recoveredAt: new Date().toISOString()
        });
      }
    }
  } finally {
    certScanInFlight = false;
  }
}

app.addHook("onRequest", async (request: any) => {
  await authHook(request);
  request.headers["x-correlation-id"] = request.headers["x-correlation-id"] ?? createCorrelationId();
});

app.get("/health", async () => ({ ok: true, service: config.serviceName }));

app.get("/security/tls", async (request, reply) => {
  const token = String(request.headers["x-security-token"] ?? "");
  if (tlsRuntime.diagnosticsToken && token !== tlsRuntime.diagnosticsToken) {
    return reply.code(403).send({ error: "FORBIDDEN" });
  }
  return tlsRuntime.getStatus();
});

app.get("/auth/me", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request) => {
  return {
    userId: request.auth?.userId ?? "anonymous",
    roles: request.auth?.roles ?? ["viewer"]
  };
});

app.get("/health/dependencies", async (request, reply) => {
  const checks = await Promise.all([
    dependencyHealth("workflow-service", config.workflowServiceUrl),
    dependencyHealth("order-service", config.orderServiceUrl),
    dependencyHealth("logging-service", config.loggingServiceUrl),
    dependencyHealth("rag-service", config.ragServiceUrl),
    dependencyHealth("chat-service", config.chatServiceUrl)
  ]);
  const ok = checks.every((item) => item.ok);
  reply.code(ok ? 200 : 503).send({
    ok,
    service: config.serviceName,
    dependencies: checks
  });
});

app.get("/health/readiness", async (request, reply) => {
  const dependencies = await Promise.all([
    dependencyHealth("workflow-service", config.workflowServiceUrl),
    dependencyHealth("order-service", config.orderServiceUrl),
    dependencyHealth("logging-service", config.loggingServiceUrl),
    dependencyHealth("rag-service", config.ragServiceUrl),
    dependencyHealth("chat-service", config.chatServiceUrl)
  ]);
  const tls = tlsRuntime.getStatus();
  const validToEpoch = tls.validTo ? Date.parse(tls.validTo) : NaN;
  const tlsOk = !Number.isNaN(validToEpoch) && validToEpoch > Date.now() && (tls.reloadFailures ?? 0) === 0;
  const depsOk = dependencies.every((entry) => entry.ok);
  const ok = tlsOk && depsOk;
  reply.code(ok ? 200 : 503).send({
    ok,
    tlsOk,
    depsOk,
    service: config.serviceName,
    tls,
    dependencies
  });
});

app.get(
  "/admin/security/certificates",
  { preHandler: requireAnyRole(["admin"]) },
  async () => {
    await runCertificateScan();
    return {
      generatedAt: new Date().toISOString(),
      thresholds: {
        warningDays: CERT_WARNING_DAYS,
        criticalDays: CERT_CRITICAL_DAYS
      },
      services: certTargets.map((target) => {
        const status = certStatusByService.get(target.service) ?? {
          service: target.service,
          endpoint: target.url,
          severity: "CRITICAL",
          error: "NO_DATA",
          checkedAt: new Date().toISOString()
        };
        const pending = pendingRotationByService.get(target.service);
        return {
          ...status,
          pendingRotation: pending ?? null
        };
      })
    };
  }
);

app.get(
  "/admin/security/certificates/events",
  { preHandler: requireAnyRole(["admin"]) },
  async (request) => {
    const query = request.query as { limit?: string };
    const limit = Math.min(Math.max(Number(query.limit ?? "100"), 1), 500);
    return {
      events: alertHistory.slice(0, limit)
    };
  }
);

app.post(
  "/admin/security/certificates/:service/renew",
  { preHandler: requireAnyRole(["admin"]) },
  async (request, reply) => {
    const service = String((request.params as { service?: string }).service ?? "").trim();
    const reason = String((request.body as { reason?: string } | undefined)?.reason ?? "").trim();
    const target = certTargets.find((entry) => entry.service === service);
    if (!target) {
      return reply.code(404).send({
        error: "CERTIFICATE_SERVICE_NOT_FOUND"
      });
    }

    const operation = await enqueueRotationRequest({
      service,
      trigger: "manual",
      requestedBy: request.auth?.userId ?? "admin",
      reason: reason || "Manual renew requested from admin panel",
      rotationTargets: target.rotationTargets
    });

    await eventPublisher.publish(PlatformEvents.certRotationTriggered, {
      service,
      requestId: operation.requestId,
      queuedAt: operation.queuedAt,
      trigger: "manual",
      requestedBy: request.auth?.userId ?? "admin"
    });
    pushAlertHistory({
      eventType: PlatformEvents.certRotationTriggered,
      severity: "INFO",
      service,
      timestamp: new Date().toISOString(),
      requestId: operation.requestId,
      trigger: "manual",
      requestedBy: request.auth?.userId ?? "admin"
    });

    await logCertEvent({
      service,
      event: PlatformEvents.certRotationTriggered,
      severity: "INFO",
      message: `Manual certificate rotation requested for ${service}`,
      payload: {
        requestId: operation.requestId,
        queuedAt: operation.queuedAt,
        trigger: "manual",
        requestedBy: request.auth?.userId ?? "admin"
      }
    });

    scheduleCertificateScan(5000);
    scheduleCertificateScan(15000);
    scheduleCertificateScan(30000);

    return reply.code(202).send({
      accepted: true,
      service,
      requestId: operation.requestId,
      queuedAt: operation.queuedAt
    });
  }
);

app.get("/admin/secrets", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/admin/secrets");
});

app.post("/admin/secrets", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/admin/secrets");
});

app.patch("/admin/secrets", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "PATCH", config.workflowServiceUrl, "/admin/secrets");
});

app.delete("/admin/secrets", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, "/admin/secrets");
});

app.get("/admin/secrets/usage", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/admin/secrets/usage");
});

app.post("/admin/secrets/migrate", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/admin/secrets/migrate");
});

app.get("/admin/secrets/catalog", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/admin/secrets/catalog");
});

app.post("/admin/secrets/by-path", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/admin/secrets/by-path");
});

app.patch("/admin/secrets/by-path", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "PATCH", config.workflowServiceUrl, "/admin/secrets/by-path");
});

app.delete("/admin/secrets/by-path", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, "/admin/secrets/by-path");
});

app.post("/workflows", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/workflows");
});

app.get("/workflows", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/workflows");
});

app.get("/workflows/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/workflows/${id}`);
});

app.post("/workflows/:id/publish", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/workflows/${id}/publish`);
});

app.get("/workflows/:id/publish-audits", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/workflows/${id}/publish-audits`);
});

app.post("/integrations", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/integrations");
});

app.get("/integrations", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/integrations");
});

app.get("/integrations/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/integrations/${id}`);
});

app.patch("/integrations/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "PATCH", config.workflowServiceUrl, `/integrations/${id}`);
});

app.get("/integrations/:id/shares", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/integrations/${id}/shares`);
});

app.post("/integrations/:id/share", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/integrations/${id}/share`);
});

app.delete("/integrations/:id/share/:username", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const params = request.params as { id: string; username: string };
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/integrations/${params.id}/share/${params.username}`);
});

app.post("/integrations/:id/duplicate", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/integrations/${id}/duplicate`);
});

app.get("/integrations/:id/usage", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/integrations/${id}/usage`);
});

app.post("/integrations/:id/test", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/integrations/${id}/test`);
});

app.post("/integrations/:id/activate", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/integrations/${id}/activate`);
});

app.post("/integrations/:id/deactivate", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/integrations/${id}/deactivate`);
});

app.delete("/integrations/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/integrations/${id}`);
});

app.post("/environments", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/environments");
});

app.get("/environments", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/environments");
});

app.get("/environments/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/environments/${id}`);
});

app.patch("/environments/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "PATCH", config.workflowServiceUrl, `/environments/${id}`);
});

app.get("/environments/:id/shares", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/environments/${id}/shares`);
});

app.post("/environments/:id/share", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/environments/${id}/share`);
});

app.delete("/environments/:id/share/:username", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const params = request.params as { id: string; username: string };
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/environments/${params.id}/share/${params.username}`);
});

app.post("/environments/:id/duplicate", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/environments/${id}/duplicate`);
});

app.delete("/environments/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/environments/${id}`);
});

app.post("/orders/execute", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.orderServiceUrl, "/orders/execute");
});

app.get("/orders", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.orderServiceUrl, "/orders");
});

app.get("/orders/approvals", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.orderServiceUrl, "/orders/approvals");
});

app.get("/orders/:id/approvals", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.orderServiceUrl, `/orders/${id}/approvals`);
});

app.get("/orders/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.orderServiceUrl, `/orders/${id}`);
});

app.post("/orders/:id/request-approval", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.orderServiceUrl, `/orders/${id}/request-approval`);
});

app.post("/orders/:id/approve", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.orderServiceUrl, `/orders/${id}/approve`);
});

app.post("/orders/:id/reject", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.orderServiceUrl, `/orders/${id}/reject`);
});

app.post("/orders/:id/retry", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.orderServiceUrl, `/orders/${id}/retry`);
});

app.post("/orders/:id/rollback", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.orderServiceUrl, `/orders/${id}/rollback`);
});

app.get("/logs", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.loggingServiceUrl, "/logs");
});

app.get("/logs/timeline", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.loggingServiceUrl, "/logs/timeline");
});

app.post("/chat/query", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.chatServiceUrl, "/chat/query");
});

app.post("/rag/search", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.ragServiceUrl, "/rag/search");
});

app.post("/rag/index", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.ragServiceUrl, "/rag/index");
});

app.get("/rag/jobs", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.ragServiceUrl, "/rag/jobs");
});

app.addHook("onClose", async () => {
  if (certScanTimer) {
    clearInterval(certScanTimer);
    certScanTimer = undefined;
  }
  for (const timer of certScanKickTimers) {
    clearTimeout(timer);
  }
  certScanKickTimers.clear();
  await eventPublisher.close();
  await tlsRuntime.close();
});

async function start(): Promise<void> {
  await app.listen({ port: config.port, host: "0.0.0.0" });
  tlsRuntime.onReload((error) => {
    if (error) return;
    tlsRuntime.applyServerSecureContext(app.server);
  });
  tlsRuntime.startWatching();
  certScanTimer = setInterval(() => {
    runCertificateScan().catch((error) =>
      logInfo("Certificate scan failed", {
        error: error instanceof Error ? error.message : String(error)
      })
    );
  }, CERT_SCAN_INTERVAL_MS);
  setTimeout(() => {
    runCertificateScan().catch(() => undefined);
  }, 10000);
  logInfo("Service started", { service: config.serviceName, port: config.port, tls: config.mtlsRequired });
}

start().catch((error) => {
  process.stderr.write(`[api-gateway] failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
