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
}): DifyProvisioningConfig {
  const { configSecret, defaults, consolePassword } = input;
  return {
    difyAppUrl: nonEmptyString(configSecret.default_app_url) ?? defaults.difyAppUrl,
    consoleEmail: nonEmptyString(configSecret.console_email) ?? "operations-ai@automation-platform.local",
    consoleName: nonEmptyString(configSecret.console_name) ?? "Automation Platform",
    consolePassword,
    initPassword: nonEmptyString(configSecret.init_password),
    modelProvider: nonEmptyString(configSecret.model_provider) ?? "openai",
    modelApiKey: nonEmptyString(configSecret.model_api_key),
    modelApiBase: nonEmptyString(configSecret.model_api_base),
    chatModel: nonEmptyString(configSecret.chat_model) ?? "gpt-4o-mini",
    embeddingModel: nonEmptyString(configSecret.embedding_model) ?? "text-embedding-3-small",
    workflowId: defaults.workflowId
  };
}
