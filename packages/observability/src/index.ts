export interface LogContext {
  service: string;
  correlationId?: string;
  [key: string]: unknown;
}

export function logInfo(message: string, context: LogContext): void {
  process.stdout.write(`${JSON.stringify({ level: "INFO", message, ...context })}\n`);
}

export function logError(message: string, context: LogContext): void {
  process.stderr.write(`${JSON.stringify({ level: "ERROR", message, ...context })}\n`);
}

export function createCorrelationId(prefix = "corr"): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

