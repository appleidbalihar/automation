import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// ─── H2: Distributed Tracing via AsyncLocalStorage ───────────────────────────
// Provides a lightweight trace context that flows through every async call chain
// without requiring the full OpenTelemetry SDK. Each incoming request gets a
// unique traceId that is automatically included in all logInfo/logError calls
// made during that request's lifecycle.
//
// Usage in a Fastify service:
//   app.addHook("onRequest", (request, reply, done) => {
//     const traceId = request.headers["x-trace-id"] as string || generateTraceId();
//     reply.header("x-trace-id", traceId);
//     runWithTrace({ traceId, spanId: generateSpanId(), startMs: Date.now() }, done);
//   });
// ─────────────────────────────────────────────────────────────────────────────

export interface TraceContext {
  traceId: string;
  spanId: string;
  startMs: number;
  route?: string;
  service?: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

/** Generate a W3C-compatible 128-bit trace ID (32 hex chars) */
export function generateTraceId(): string {
  return randomBytes(16).toString("hex");
}

/** Generate a 64-bit span ID (16 hex chars) */
export function generateSpanId(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Run a callback within a trace context. All logInfo/logError calls made
 * inside the callback (and any async operations it spawns) will automatically
 * include the traceId and spanId.
 *
 * Compatible with Fastify's done() callback pattern:
 *   runWithTrace({ traceId, spanId, startMs }, done);
 */
export function runWithTrace<T>(ctx: TraceContext, fn: (() => T) | (() => Promise<T>) | (() => void)): T | void {
  return traceStorage.run(ctx, fn as () => T);
}

/** Get the active trace context for the current async scope (or undefined if none) */
export function getActiveTrace(): TraceContext | undefined {
  return traceStorage.getStore();
}

export interface LogContext {
  service: string;
  correlationId?: string;
  [key: string]: unknown;
}

export function logInfo(message: string, context: LogContext): void {
  const trace = traceStorage.getStore();
  const traceFields = trace
    ? { traceId: trace.traceId, spanId: trace.spanId }
    : {};
  process.stdout.write(`${JSON.stringify({ level: "INFO", message, ...traceFields, ...context })}\n`);
}

export function logError(message: string, context: LogContext): void {
  const trace = traceStorage.getStore();
  const traceFields = trace
    ? { traceId: trace.traceId, spanId: trace.spanId }
    : {};
  process.stderr.write(`${JSON.stringify({ level: "ERROR", message, ...traceFields, ...context })}\n`);
}

export function createCorrelationId(prefix = "corr"): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Fastify onRequest hook factory — wire this into any Fastify app to get
 * automatic traceId propagation across all log calls for each request.
 *
 * Usage:
 *   app.addHook("onRequest", createTraceHook("my-service"));
 */
export function createTraceHook(serviceName: string) {
  return function onRequestTraceHook(
    request: { headers: Record<string, string | string[] | undefined> },
    reply: { header: (name: string, value: string) => void },
    done: () => void
  ): void {
    const incomingTraceId = String(request.headers["x-trace-id"] ?? "").trim();
    const traceId = incomingTraceId || generateTraceId();
    const spanId = generateSpanId();
    reply.header("x-trace-id", traceId);
    runWithTrace({ traceId, spanId, startMs: Date.now(), service: serviceName }, done);
  };
}
