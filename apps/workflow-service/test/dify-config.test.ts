import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDifyProvisioningConfig,
  resolveDifyWorkflowId
} from "../src/dify-config.js";

test("resolveDifyWorkflowId uses configured source workflow before defaults", () => {
  assert.equal(
    resolveDifyWorkflowId("github", { github_workflow_id: "custom-github-sync" }),
    "custom-github-sync"
  );
  assert.equal(resolveDifyWorkflowId("gdrive", {}), "rag-sync-gdrive");
});

test("buildDifyProvisioningConfig preserves OpenAI-compatible Vault settings", () => {
  const config = buildDifyProvisioningConfig({
    configSecret: {
      default_app_url: " http://dify-api:5001/ ",
      console_email: " admin@example.com ",
      console_name: " Platform Admin ",
      init_password: " init-password ",
      model_provider: " openai_api_compatible ",
      model_api_base: " https://llm.example.com ",
      model_api_key: " secret-key ",
      chat_model: " llama-3.1-70b ",
      embedding_model: " bge-m3 "
    },
    defaults: {
      difyAppUrl: "http://fallback-dify:5001",
      workflowId: "rag-sync-github"
    },
    consolePassword: "console-password"
  });

  assert.equal(config.difyAppUrl, "http://dify-api:5001/");
  assert.equal(config.consoleEmail, "admin@example.com");
  assert.equal(config.consoleName, "Platform Admin");
  assert.equal(config.consolePassword, "console-password");
  assert.equal(config.initPassword, "init-password");
  assert.equal(config.modelProvider, "openai_api_compatible");
  assert.equal(config.modelApiBase, "https://llm.example.com");
  assert.equal(config.modelApiKey, "secret-key");
  assert.equal(config.chatModel, "llama-3.1-70b");
  assert.equal(config.embeddingModel, "bge-m3");
});

test("buildDifyProvisioningConfig supplies Dify model defaults", () => {
  const config = buildDifyProvisioningConfig({
    configSecret: {},
    defaults: {
      difyAppUrl: "http://dify-api:5001",
      workflowId: "rag-sync-github"
    },
    consolePassword: "console-password"
  });

  assert.equal(config.difyAppUrl, "http://dify-api:5001");
  assert.equal(config.consoleEmail, "operations-ai@automation-platform.local");
  assert.equal(config.consoleName, "Automation Platform");
  assert.equal(config.modelProvider, "openai");
  assert.equal(config.modelApiKey, undefined);
  assert.equal(config.modelApiBase, undefined);
  assert.equal(config.chatModel, "gpt-4o-mini");
  assert.equal(config.embeddingModel, "text-embedding-3-small");
  assert.equal(config.workflowId, "rag-sync-github");
});
