import { existsSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";

export interface AppConfig {
  serviceName: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  rabbitmqUrl: string;
  opensearchUrl: string;
  keycloakUrl: string;
  keycloakRealm: string;
  workflowServiceUrl: string;
  orderServiceUrl: string;
  executionEngineServiceUrl: string;
  integrationServiceUrl: string;
  loggingServiceUrl: string;
  mtlsRequired: boolean;
  tlsCertPath: string;
  tlsKeyPath: string;
  tlsCaPath: string;
  tlsReloadDebounceMs: number;
  tlsVerifyPeer: boolean;
  tlsServerName?: string;
  securityDiagnosticsToken?: string;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  flowisePlannerUrl: string;
  flowiseOperationsChatUrl: string;
  flowiseApiKey?: string;
}

function bootstrapEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../.env"),
    resolve(process.cwd(), "../../.env")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      dotenv.config({ path: candidate });
      return;
    }
  }
}

function required(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function loadConfig(serviceName: string, fallbackPort: number): AppConfig {
  bootstrapEnv();
  return {
    serviceName,
    port: Number(process.env.PORT ?? fallbackPort),
    databaseUrl: required("DATABASE_URL", "postgresql://platform:platform@localhost:5432/automation?schema=public&sslmode=verify-full"),
    redisUrl: required("REDIS_URL", "rediss://:platformredis@localhost:6379"),
    rabbitmqUrl: required("RABBITMQ_URL", "amqps://guest:guest@localhost:5671"),
    opensearchUrl: required("OPENSEARCH_URL", "https://localhost:9200"),
    keycloakUrl: required("KEYCLOAK_URL", "https://localhost:8443"),
    keycloakRealm: required("KEYCLOAK_REALM", "automation-platform"),
    workflowServiceUrl: required("WORKFLOW_SERVICE_URL", "https://localhost:4001"),
    orderServiceUrl: required("ORDER_SERVICE_URL", "https://localhost:4002"),
    executionEngineServiceUrl: required("EXECUTION_ENGINE_SERVICE_URL", "https://localhost:4003"),
    integrationServiceUrl: required("INTEGRATION_SERVICE_URL", "https://localhost:4004"),
    loggingServiceUrl: required("LOGGING_SERVICE_URL", "https://localhost:4005"),
    mtlsRequired: boolEnv("MTLS_REQUIRED", true),
    tlsCertPath: required("TLS_CERT_PATH", "/tls/cert.pem"),
    tlsKeyPath: required("TLS_KEY_PATH", "/tls/key.pem"),
    tlsCaPath: required("TLS_CA_PATH", "/tls/ca.pem"),
    tlsReloadDebounceMs: Number(process.env.TLS_RELOAD_DEBOUNCE_MS ?? 1000),
    tlsVerifyPeer: boolEnv("TLS_VERIFY_PEER", true),
    tlsServerName: process.env.TLS_SERVER_NAME,
    securityDiagnosticsToken: process.env.SECURITY_DIAGNOSTICS_TOKEN,
    temporalAddress: required("TEMPORAL_ADDRESS", "temporal:7233"),
    temporalNamespace: required("TEMPORAL_NAMESPACE", "default"),
    temporalTaskQueue: required("TEMPORAL_TASK_QUEUE", "automation-task-queue"),
    flowisePlannerUrl: required("FLOWISE_PLANNER_URL", "http://flowise:3000"),
    flowiseOperationsChatUrl: required(
      "FLOWISE_OPERATIONS_CHAT_URL",
      "http://flowise:3000/api/v1/prediction/4b37e62c-da5c-43e5-ba10-8a1cfc9d06f1"
    ),
    flowiseApiKey: process.env.FLOWISE_API_KEY
  };
}
