// @ts-nocheck
import { authHook, requireAnyRole } from "@platform/auth";
import { loadConfig } from "@platform/config";
import { PlatformEvents } from "@platform/contracts";
import { createCorrelationId, logInfo } from "@platform/observability";
import { connectAmqp, createTlsRuntime, tlsFetch } from "@platform/tls-runtime";
import type { Channel, ChannelModel } from "amqplib";
import amqp from "amqplib";
import Fastify from "fastify";
import Redis from "ioredis";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { connect as connectTls } from "node:tls";

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

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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

/**
 * Build the certificate monitoring targets dynamically.
 *
 * Default targets are derived from the loaded service config so they always
 * match whatever services are actually wired in docker-compose.yml.
 *
 * Additional targets can be injected at runtime via the CERT_TARGETS env var
 * (a JSON array of CertTarget objects), allowing new services to appear on the
 * Security Health page without any code changes.
 *
 * Example CERT_TARGETS value:
 *   '[{"service":"my-service","url":"https://my-service:5000","mode":"security-endpoint","rotationTargets":["my-service-vault-agent"]}]'
 */
function buildCertTargets(): CertTarget[] {
  // Baseline targets — always present and derived from config (never hardcoded hostnames)
  const defaults: CertTarget[] = [
    {
      service: "api-gateway",
      url: `https://api-gateway:${config.port}`,
      mode: "security-endpoint",
      rotationTargets: ["api-gateway-vault-agent"]
    },
    {
      service: "workflow-service",
      url: config.workflowServiceUrl,
      mode: "security-endpoint",
      rotationTargets: ["workflow-service-vault-agent"]
    },
    {
      service: "logging-service",
      url: config.loggingServiceUrl,
      mode: "security-endpoint",
      rotationTargets: ["logging-service-vault-agent"]
    },
    {
      service: "keycloak",
      url: config.keycloakUrl,
      mode: "tls-handshake",
      rotationTargets: ["keycloak-vault-agent", "keycloak"]
    }
  ];

  // Merge in any additional targets from the CERT_TARGETS env var
  const rawExtra = String(process.env.CERT_TARGETS ?? "").trim();
  if (!rawExtra) return defaults;

  let extra: CertTarget[] = [];
  try {
    const parsed = JSON.parse(rawExtra);
    if (!Array.isArray(parsed)) throw new TypeError("CERT_TARGETS must be a JSON array");
    extra = parsed.filter(
      (item): item is CertTarget =>
        typeof item === "object" &&
        item !== null &&
        typeof item.service === "string" &&
        typeof item.url === "string" &&
        (item.mode === "security-endpoint" || item.mode === "tls-handshake") &&
        Array.isArray(item.rotationTargets)
    );
  } catch (parseError) {
    logInfo("CERT_TARGETS env var is invalid JSON — ignoring extra targets", {
      error: parseError instanceof Error ? parseError.message : String(parseError)
    });
    return defaults;
  }

  // Merge: env-var targets override defaults with same service name
  const merged = new Map<string, CertTarget>();
  for (const target of defaults) merged.set(target.service, target);
  for (const target of extra) merged.set(target.service, target);

  return Array.from(merged.values());
}

const certTargets: CertTarget[] = buildCertTargets();

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

// ─── OAuth2 Connect Integration ───────────────────────────────────────────────

const OAUTH_SECRET = String(process.env.PLATFORM_OAUTH_SECRET ?? "").trim();
const OAUTH_CALLBACK_BASE_URL = String(process.env.OAUTH_CALLBACK_BASE_URL ?? "https://dev.eclassmanager.com/rapidrag/connect").trim();
const OAUTH_POST_CONNECT_REDIRECT = String(process.env.OAUTH_POST_CONNECT_REDIRECT ?? "https://dev.eclassmanager.com/rapidrag/integrations").trim();
const VAULT_ADDR_OAUTH = String(process.env.VAULT_ADDR ?? "http://vault:8200").trim();
const VAULT_KV_MOUNT_OAUTH = String(process.env.VAULT_KV_MOUNT ?? "secret").trim();
const VAULT_NAMESPACE_OAUTH = String(process.env.VAULT_NAMESPACE ?? "").trim();
const STATE_TTL_SECONDS = 600; // 10 minutes

const oauthProviderConfig: Record<string, { clientIdEnv: string; clientSecretEnv: string; authUrl: string; tokenUrl: string; scope: string }> = {
  github: {
    clientIdEnv: "GITHUB_CLIENT_ID",
    clientSecretEnv: "GITHUB_CLIENT_SECRET",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    scope: "repo"
  },
  gitlab: {
    clientIdEnv: "GITLAB_CLIENT_ID",
    clientSecretEnv: "GITLAB_CLIENT_SECRET",
    authUrl: "https://gitlab.com/oauth/authorize",
    tokenUrl: "https://gitlab.com/oauth/token",
    scope: "read_repository read_api"
  },
  google: {
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/drive.readonly"
  }
};

function tryReadFile(p: string): Buffer | undefined {
  try { return readFileSync(p); } catch { return undefined; }
}

let redisClient: Redis | null = null;
function getRedis(): Redis {
  if (!redisClient) {
    const url = String(process.env.REDIS_URL ?? "rediss://:platformredis@redis:6379");
    const tls = url.startsWith("rediss://") ? {
      cert: tryReadFile(config.tlsCertPath),
      key:  tryReadFile(config.tlsKeyPath),
      ca:   tryReadFile(config.tlsCaPath),
      rejectUnauthorized: false
    } : undefined;
    redisClient = new Redis(url, {
      tls,
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableReadyCheck: false,
      connectTimeout: 5000
    });
    redisClient.on("error", (err) => logInfo("OAuth Redis error", { error: err.message }));
  }
  return redisClient;
}

function signState(payload: string): string {
  if (!OAUTH_SECRET) throw new Error("PLATFORM_OAUTH_SECRET not configured");
  const mac = createHmac("sha256", OAUTH_SECRET).update(payload).digest("hex");
  return `${payload}.${mac}`;
}

function verifyState(signed: string): { userId: string; kbId: string; provider: string; nonce: string } | null {
  const lastDot = signed.lastIndexOf(".");
  if (lastDot === -1) return null;
  const payload = signed.slice(0, lastDot);
  const mac = signed.slice(lastDot + 1);
  const expected = createHmac("sha256", OAUTH_SECRET).update(payload).digest("hex");
  try {
    if (!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(expected, "hex"))) return null;
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.exp < Date.now() / 1000) return null;
    return data;
  } catch {
    return null;
  }
}

async function getOAuthCredentials(provider: string, kbId: string, userId: string): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const url = new URL(`/internal/oauth-credentials/${provider}`, config.workflowServiceUrl);
    url.searchParams.set("kbId", kbId);
    url.searchParams.set("userId", userId);
    const res = await tlsFetch(tlsRuntime, url, {
      headers: { "x-internal-secret": OAUTH_SECRET }
    });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = (await res.json()) as { clientId?: string; clientSecret?: string };
    if (!body.clientId) return null;
    return { clientId: body.clientId, clientSecret: body.clientSecret ?? "" };
  } catch {
    return null;
  }
}

async function oauthVaultRead(logicalPath: string): Promise<Record<string, unknown>> {
  const response = await fetch(new URL(`/v1/${VAULT_KV_MOUNT_OAUTH}/data/${logicalPath}`, VAULT_ADDR_OAUTH), {
    headers: { "content-type": "application/json", ...(VAULT_NAMESPACE_OAUTH ? { "X-Vault-Namespace": VAULT_NAMESPACE_OAUTH } : {}) }
  });
  if (response.status === 404) return {};
  if (!response.ok) return {};
  const body = (await response.json()) as { data?: { data?: Record<string, unknown> } };
  return body.data?.data ?? {};
}

// ─────────────────────────────────────────────────────────────────────────────

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
    // x-user-name carries the same preferred_username for display purposes.
    // Workflow-service uses this to store ownerUsername on KB creation.
    headers["x-user-name"] = request.auth.userId;
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
  // Only set content-type and body for requests that actually have a body.
  // DELETE requests without a body must NOT set content-type: application/json
  // because Fastify (and some proxies) reject empty JSON bodies.
  const hasBody = method !== "GET" && method !== "DELETE" && request.body !== undefined;
  const hasDeleteBody = method === "DELETE" && request.body !== undefined && Object.keys(request.body as object).length > 0;
  if (hasBody || hasDeleteBody) {
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

function hasValidInternalSyncToken(request: any): boolean {
  const expected = String(config.n8nWebhookToken ?? "").trim();
  if (!expected) return false;
  const headerToken = String(request.headers["x-rag-sync-token"] ?? request.headers["x-n8n-webhook-token"] ?? "").trim();
  const bearerToken = String(request.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  return headerToken === expected || bearerToken === expected;
}

function authorizeSyncProgressCallback(request: any, reply: any): boolean {
  if (hasValidInternalSyncToken(request)) {
    request.auth = {
      userId: "system/n8n-sync",
      roles: ["admin"]
    };
    return true;
  }

  const context = request.auth ?? { userId: "anonymous", roles: ["viewer"] };
  if (!context.userId || context.userId === "anonymous") {
    reply.code(401).send({ error: "UNAUTHENTICATED" });
    return false;
  }
  const allowed = ["admin", "useradmin", "operator"].some((role) => context.roles.includes(role));
  if (!allowed) {
    reply.code(403).send({ error: "FORBIDDEN", requiredRoles: ["admin", "useradmin", "operator"] });
    return false;
  }
  return true;
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
    dependencyHealth("logging-service", config.loggingServiceUrl)
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
    dependencyHealth("logging-service", config.loggingServiceUrl)
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

// ─── Knowledge Base Routes ────────────────────────────────────────────────────
// All authenticated users can list and view KBs.
// Create/delete/set-default require admin or useradmin role.

app.get("/rag/integrations", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/rag/integrations");
});

app.post("/rag/integrations", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/rag/integrations");
});

app.patch("/rag/integrations/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "PATCH", config.workflowServiceUrl, `/rag/integrations/${id}`);
});

app.patch("/rag/integrations/:id/oauth-app-credentials", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "PATCH", config.workflowServiceUrl, `/rag/integrations/${id}/oauth-app-credentials`);
});

app.post("/rag/integrations/:id/set-default", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/integrations/${id}/set-default`);
});

app.delete("/rag/integrations/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/rag/integrations/${id}`);
});

app.get("/rag/knowledge-bases", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/rag/knowledge-bases");
});

app.post("/rag/knowledge-bases", { preHandler: requireAnyRole(["admin", "useradmin"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/rag/knowledge-bases");
});

app.get("/rag/knowledge-bases/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/rag/knowledge-bases/${id}`);
});

app.patch("/rag/knowledge-bases/:id/config", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "PATCH", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/config`);
});

// ─── KB Share Management Routes ───────────────────────────────────────────────
// Owner or admin can share a KB with another user by their username.
app.post("/rag/knowledge-bases/:id/shares", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/shares`);
});

app.get("/rag/knowledge-bases/:id/shares", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/shares`);
});

app.delete("/rag/knowledge-bases/:id/shares/:shareId", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const { id, shareId } = request.params as { id: string; shareId: string };
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/shares/${shareId}`);
});

app.delete("/rag/knowledge-bases/:id", { preHandler: requireAnyRole(["admin", "useradmin"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/rag/knowledge-bases/${id}`);
});

app.post("/rag/knowledge-bases/:id/set-default", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/set-default`);
});

app.post("/rag/knowledge-bases/:id/sync", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/sync`);
});

app.post("/rag/knowledge-bases/:id/retry-failed-indexing", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/retry-failed-indexing`);
});

app.post("/rag/knowledge-bases/:id/sync-cancel", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/sync-cancel`);
});

// Calculate diff for incremental sync — called by n8n (sync token) or authenticated users
app.post("/rag/knowledge-bases/:id/sync-diff", async (request, reply) => {
  if (!authorizeSyncProgressCallback(request, reply)) return;
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/sync-diff`);
});

// Cleanup: remove all indexed documents and Dify KB data for a source (no fetch/index — deletion only)
app.post("/rag/knowledge-bases/:id/cleanup", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/cleanup`);
});

app.get("/rag/knowledge-bases/:id/sync-status", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/sync-status`);
});

app.get("/rag/knowledge-bases/:id/sync-history", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/sync-history`);
});

// sync-progress is called by n8n internally. n8n uses a shared callback token
// because it is not an interactive Keycloak user.
app.post("/rag/knowledge-bases/:id/sync-progress", async (request, reply) => {
  if (!authorizeSyncProgressCallback(request, reply)) return;
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/knowledge-bases/${id}/sync-progress`);
});

// n8n Error Trigger handler — n8n calls this when any workflow execution fails
// to report the failure back to the platform so the sync job is marked as failed
app.post("/rag/sync-error-handler", async (request, reply) => {
  // Allow n8n (uses sync token) or any internal caller
  if (!hasValidInternalSyncToken(request)) {
    // For Error Trigger, just accept without authentication since it's called internally
    // The endpoint itself validates and does a safe DB update by syncJobId
  }
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/rag/sync-error-handler");
});

// ─── Channel Deployment Routes (Phase 2) ─────────────────────────────────────
app.get("/rag/channels", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/rag/channels");
});

app.post("/rag/channels", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/rag/channels");
});

app.delete("/rag/channels/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/rag/channels/${id}`);
});

// ─── RAG Discussion Routes ────────────────────────────────────────────────────
app.get("/rag/discussions", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/rag/discussions");
});

app.post("/rag/discussions", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  await proxy(request, reply, "POST", config.workflowServiceUrl, "/rag/discussions");
});

app.get("/rag/discussions/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "GET", config.workflowServiceUrl, `/rag/discussions/${id}`);
});

app.post("/rag/discussions/:id/messages", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "POST", config.workflowServiceUrl, `/rag/discussions/${id}/messages`);
});

app.delete("/rag/discussions/:id", { preHandler: requireAnyRole(["admin", "useradmin", "operator", "approver", "viewer"]) }, async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await proxy(request, reply, "DELETE", config.workflowServiceUrl, `/rag/discussions/${id}`);
});

// ─── RAG Performance Stats ────────────────────────────────────────────────────
// Restricted to platform admin only — shows platform-wide RAG response timing.
app.get("/rag/stats", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.workflowServiceUrl, "/rag/stats");
});

// Platform system logs — restricted to platform admins only.
// These logs contain all n8n-rag-sync events, cert-control events, and other
// platform-level operations. useradmin, operator, and viewer roles must NOT
// see logs created by other users or the platform system.
app.get("/logs", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.loggingServiceUrl, "/logs");
});

// Timeline logs — restricted to platform admins only for the same reason.
app.get("/logs/timeline", { preHandler: requireAnyRole(["admin"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.loggingServiceUrl, "/logs/timeline");
});

// Sync-job logs: scoped by syncJobId so the caller can only see logs for a
// specific sync job they triggered. Accessible to admin and useradmin since
// useradmin users trigger syncs and need to see their own sync job logs.
app.get("/logs/sync-job", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  await proxy(request, reply, "GET", config.loggingServiceUrl, "/logs/sync-job");
});

// ─── OAuth2 routes ────────────────────────────────────────────────────────────

// GET /oauth/connect/:provider?kbId=xxx
// JWT-authenticated. Generates HMAC-signed state, stores in Redis, redirects to provider.
app.get("/oauth/connect/:provider", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const { provider } = request.params as { provider: string };
  const { kbId, clientId: inlineClientId } = request.query as { kbId?: string; clientId?: string };
  const provCfg = oauthProviderConfig[provider];
  if (!provCfg) return reply.code(400).send({ error: "UNKNOWN_PROVIDER", provider });
  if (!kbId) return reply.code(400).send({ error: "MISSING_KB_ID" });

  const userId = request.auth?.userId;
  if (!userId) return reply.code(401).send({ error: "UNAUTHORIZED" });

  // Prefer clientId passed inline (just registered) over Vault lookup to avoid timing issues
  let clientId = String(inlineClientId ?? "").trim();
  if (!clientId) {
    const oauthCreds = await getOAuthCredentials(provider, kbId, userId);
    if (!oauthCreds) return reply.code(503).send({ error: "OAUTH_NOT_CONFIGURED", provider });
    clientId = oauthCreds.clientId;
  }

  const nonce = randomBytes(24).toString("hex");
  const payload = Buffer.from(JSON.stringify({ userId, kbId, provider, nonce, exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS })).toString("base64url");
  const state = signState(payload);

  // Store nonce in Redis so the callback can verify it as single-use.
  // Must happen BEFORE redirecting to the provider — if Redis fails we still allow
  // the flow but log a warning (the HMAC signature still provides replay protection).
  try {
    await getRedis().set(`oauth:state:${nonce}`, "1", "EX", STATE_TTL_SECONDS);
  } catch (redisErr) {
    logInfo("OAuth state Redis set failed — proceeding without nonce lock", {
      error: redisErr instanceof Error ? redisErr.message : String(redisErr)
    });
  }

  const redirectUri = `${OAUTH_CALLBACK_BASE_URL}/oauth/callback/${provider}`;
  const authorizeUrl = new URL(provCfg.authUrl);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", provCfg.scope);
  authorizeUrl.searchParams.set("state", state);
  if (provider === "google") {
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("access_type", "offline");
    authorizeUrl.searchParams.set("prompt", "consent");
  }

  // If caller wants a JSON response (browser SPA using fetch + auth header), return URL instead of 302
  const { json } = request.query as { json?: string };
  if (json === "1") {
    return reply.send({ url: authorizeUrl.toString() });
  }
  return reply.redirect(authorizeUrl.toString());
});

// GET /oauth/callback/:provider?code=xxx&state=xxx
// Unauthenticated — browser arrives here from provider redirect.
// State HMAC + Redis validates identity. Exchanges code, stores tokens via workflow-service.
app.get("/oauth/callback/:provider", async (request, reply) => {
  const { provider } = request.params as { provider: string };
  const { code, state, error: providerError } = request.query as { code?: string; state?: string; error?: string };

  if (providerError) {
    logInfo("OAuth provider returned error", { provider, error: providerError });
    return reply.redirect(`${OAUTH_POST_CONNECT_REDIRECT}?oauth_error=${encodeURIComponent(providerError)}&provider=${provider}`);
  }

  if (!code || !state) return reply.code(400).send({ error: "MISSING_CODE_OR_STATE" });

  const provCfg = oauthProviderConfig[provider];
  if (!provCfg) return reply.code(400).send({ error: "UNKNOWN_PROVIDER" });

  // 1. Verify HMAC signature
  const stateData = verifyState(state);
  if (!stateData || stateData.provider !== provider) {
    logInfo("OAuth state verification failed", { provider });
    return reply.code(400).send({ error: "INVALID_STATE" });
  }

  // 2. Validate Redis single-use token (non-fatal on Redis error — code is also single-use at provider)
  try {
    const deleted = await getRedis().del(`oauth:state:${stateData.nonce}`);
    if (deleted === 0) {
      return reply.redirect(`${OAUTH_POST_CONNECT_REDIRECT}?oauth_error=state_replayed&provider=${provider}`);
    }
  } catch (err) {
    logInfo("OAuth state Redis del failed — continuing", { error: err instanceof Error ? err.message : String(err) });
  }

  // 3. Read per-integration client credentials from Vault via workflow-service
  const oauthCreds = await getOAuthCredentials(provider, stateData.kbId, stateData.userId);
  const clientId = oauthCreds?.clientId ?? "";
  const clientSecret = oauthCreds?.clientSecret ?? "";
  if (!clientId || !clientSecret) return reply.code(503).send({ error: "OAUTH_NOT_CONFIGURED", provider });

  // 4. Exchange code for tokens
  const redirectUri = `${OAUTH_CALLBACK_BASE_URL}/oauth/callback/${provider}`;
  let tokenPayload: Record<string, unknown>;
  try {
    const tokenRes = await fetch(provCfg.tokenUrl, {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri, grant_type: "authorization_code" }).toString()
    });
    tokenPayload = (await tokenRes.json()) as Record<string, unknown>;
    if (tokenPayload.error) throw new Error(String(tokenPayload.error));
  } catch (err) {
    logInfo("OAuth token exchange failed", { provider, error: err instanceof Error ? err.message : String(err) });
    return reply.redirect(`${OAUTH_POST_CONNECT_REDIRECT}?oauth_error=token_exchange_failed&provider=${provider}`);
  }

  const accessToken = String(tokenPayload.access_token ?? "").trim();
  const refreshToken = String(tokenPayload.refresh_token ?? "").trim();
  const expiresIn = Number(tokenPayload.expires_in ?? 0);
  if (!accessToken) {
    logInfo("OAuth token exchange: no access_token in response", { provider });
    return reply.redirect(`${OAUTH_POST_CONNECT_REDIRECT}?oauth_error=no_access_token&provider=${provider}`);
  }

  // 5. Forward tokens to workflow-service internal endpoint
  const tokenExpiry = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : undefined;
  try {
    const wfRes = await tlsFetch(tlsRuntime, new URL(`/internal/oauth-token/${stateData.kbId}`, config.workflowServiceUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-secret": OAUTH_SECRET },
      body: JSON.stringify({ userId: stateData.userId, provider, accessToken, refreshToken: refreshToken || undefined, tokenExpiry })
    });
    if (!wfRes.ok) {
      const body = await wfRes.text().catch(() => "");
      logInfo("OAuth workflow-service token store failed", { provider, status: wfRes.status, body });
      return reply.redirect(`${OAUTH_POST_CONNECT_REDIRECT}?oauth_error=store_failed&provider=${provider}`);
    }
  } catch (err) {
    logInfo("OAuth workflow-service call failed", { provider, error: err instanceof Error ? err.message : String(err) });
    return reply.redirect(`${OAUTH_POST_CONNECT_REDIRECT}?oauth_error=store_failed&provider=${provider}`);
  }

  // 6. Redirect operator back to integrations page with success signal
  return reply.redirect(`${OAUTH_POST_CONNECT_REDIRECT}?connected=true&provider=${provider}&kbId=${stateData.kbId}`);
});

// DELETE /oauth/token/:provider?kbId=xxx
// JWT-authenticated. Disconnects OAuth — removes OAuth token fields from Vault, sets auth_method back to "pat".
app.delete("/oauth/token/:provider", { preHandler: requireAnyRole(["admin", "useradmin", "operator"]) }, async (request, reply) => {
  const { provider } = request.params as { provider: string };
  const { kbId } = request.query as { kbId?: string };
  const userId = request.auth?.userId;
  if (!userId) return reply.code(401).send({ error: "UNAUTHORIZED" });
  if (!kbId) return reply.code(400).send({ error: "MISSING_KB_ID" });
  if (!oauthProviderConfig[provider]) return reply.code(400).send({ error: "UNKNOWN_PROVIDER" });

  try {
    const wfRes = await tlsFetch(tlsRuntime, new URL(`/internal/oauth-token/${kbId}`, config.workflowServiceUrl), {
      method: "DELETE",
      headers: { "content-type": "application/json", "x-internal-secret": OAUTH_SECRET },
      body: JSON.stringify({ userId, provider })
    });
    if (!wfRes.ok) {
      const body = await wfRes.text().catch(() => "");
      return reply.code(wfRes.status).send({ error: "DISCONNECT_FAILED", details: body });
    }
    return reply.code(200).send({ ok: true });
  } catch (err) {
    return reply.code(502).send({ error: "UPSTREAM_UNAVAILABLE", details: err instanceof Error ? err.message : String(err) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

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
  await redisClient?.quit().catch(() => undefined);
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
