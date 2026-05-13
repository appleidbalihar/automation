export const DEFAULT_WORKFLOW_IDS: Record<string, string> = {
  github: "rag-sync-github",
  gitlab: "rag-sync-gitlab",
  googledrive: "rag-sync-gdrive",
  web: "rag-sync-web",
  upload: ""
};

export type DifyProvisioningDefaults = {
  difyAppUrl: string;
  defaultApiKey?: string;
  workflowId: string;
};

export type DifyProvisioningConfig = {
  difyAppUrl: string;
  consoleEmail: string;
  consoleName: string;
  consolePassword: string;
  initPassword?: string;
  modelProvider: string;
  modelApiKey?: string;
  modelApiBase?: string;
  chatModel: string;
  embeddingModel: string;
  workflowId: string;
  // Split LLM vs embedding credentials.
  // When set, these override modelApiKey/modelApiBase for the respective model type.
  chatModelApiKey?: string;       // LLM provider key (e.g. api.fuelix.ai)
  chatModelApiBase?: string;      // LLM provider base URL
  embeddingModelApiKey?: string;  // Embedding provider key (e.g. Xinference — can be placeholder)
  embeddingModelApiBase?: string; // Embedding provider base URL
};

function nonEmptyString(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  return normalized ? normalized : undefined;
}

export function normalizedDifySourceType(sourceType: string): string {
  return sourceType === "gdrive" ? "googledrive" : sourceType;
}

export function resolveDifyWorkflowId(
  sourceType: string,
  configSecret: Record<string, unknown>,
  workflowIds: Record<string, string> = DEFAULT_WORKFLOW_IDS
): string {
  const normalizedType = normalizedDifySourceType(sourceType);
  return nonEmptyString(configSecret[`${normalizedType}_workflow_id`]) ?? workflowIds[normalizedType] ?? "";
}

export function buildDifyProvisioningConfig(input: {
  configSecret: Record<string, unknown>;
  defaults: DifyProvisioningDefaults;
  consolePassword: string;
  llmSecret?: Record<string, unknown>;
}): DifyProvisioningConfig {
  const { configSecret, defaults, consolePassword, llmSecret } = input;

  // LLM credentials: prefer dedicated platform/global/llm secret, fall back to dify/config
  const chatModelApiKey = nonEmptyString(llmSecret?.api_key) ?? nonEmptyString(configSecret.model_api_key);
  const chatModelApiBase = nonEmptyString(llmSecret?.base_url) ?? nonEmptyString(configSecret.model_api_base);
  const chatModel =
    nonEmptyString(llmSecret?.model) ??
    nonEmptyString(configSecret.chat_model) ??
    "gpt-4o-mini";

  // Embedding credentials: always from dify/config (stays on Xinference)
  const embeddingModelApiKey = nonEmptyString(configSecret.model_api_key);
  const embeddingModelApiBase = nonEmptyString(configSecret.model_api_base);

  return {
    difyAppUrl: nonEmptyString(configSecret.default_app_url) ?? defaults.difyAppUrl,
    consoleEmail: nonEmptyString(configSecret.console_email) ?? "operations-ai@automation-platform.local",
    consoleName: nonEmptyString(configSecret.console_name) ?? "Automation Platform",
    consolePassword,
    initPassword: nonEmptyString(configSecret.init_password),
    modelProvider: nonEmptyString(configSecret.model_provider) ?? "openai_api_compatible",
    modelApiKey: chatModelApiKey,
    modelApiBase: chatModelApiBase,
    chatModel,
    embeddingModel: nonEmptyString(configSecret.embedding_model) ?? "nomic-embed-text",
    workflowId: defaults.workflowId,
    chatModelApiKey,
    chatModelApiBase,
    embeddingModelApiKey,
    embeddingModelApiBase
  };
}
