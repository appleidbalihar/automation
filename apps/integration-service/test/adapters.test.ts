import test from "node:test";
import assert from "node:assert/strict";
import { executeIntegration } from "../src/adapters.js";

test("script adapter executes command", async () => {
  const result = await executeIntegration({
    executionType: "SCRIPT",
    commandRef: "echo integration-ok"
  });
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.executionType, "SCRIPT");
});

test("unsupported adapter returns failed status", async () => {
  const result = await executeIntegration({
    executionType: "TELNET" as never,
    commandRef: "noop"
  });
  assert.equal(result.status, "FAILED");
});

test("dangerous script command is blocked", async () => {
  const result = await executeIntegration({
    executionType: "SCRIPT",
    commandRef: "rm -rf /"
  });
  assert.equal(result.status, "FAILED");
  assert.match(String(result.error), /dangerous command policy/i);
});

test("env refs are blocked by strict vault-only policy", async () => {
  const result = await executeIntegration({
    executionType: "SCRIPT",
    commandRef: "cat",
    input: {
      token: "env:SMOKE_SECRET_TOKEN"
    }
  });
  assert.equal(result.status, "FAILED");
  assert.match(String(result.error), /ENV_SECRET_REF_BLOCKED/i);
});

test("script command is blocked by default production allowlist", async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  const prevAllowlist = process.env.INTEGRATION_SCRIPT_ALLOWLIST;
  process.env.NODE_ENV = "production";
  delete process.env.INTEGRATION_SCRIPT_ALLOWLIST;

  const result = await executeIntegration({
    executionType: "SCRIPT",
    commandRef: "echo prod-check"
  });

  assert.equal(result.status, "FAILED");
  assert.match(String(result.error), /allowlist policy/i);

  process.env.NODE_ENV = prevNodeEnv;
  if (prevAllowlist === undefined) {
    delete process.env.INTEGRATION_SCRIPT_ALLOWLIST;
  } else {
    process.env.INTEGRATION_SCRIPT_ALLOWLIST = prevAllowlist;
  }
});

test("plain string with colon is not treated as secret reference", async () => {
  const result = await executeIntegration({
    executionType: "SCRIPT",
    commandRef: "cat",
    input: {
      note: "http://localhost:9999/not-a-secret-ref"
    }
  });
  assert.equal(result.status, "SUCCESS");
  const stdout = String((result.output as { stdout?: string })?.stdout ?? "");
  assert.match(stdout, /http:\/\/localhost:9999\/not-a-secret-ref/);
});

test("vault ref fails clearly when vault is not configured", async () => {
  const prevAddr = process.env.VAULT_ADDR;
  delete process.env.VAULT_ADDR;

  const result = await executeIntegration({
    executionType: "SCRIPT",
    commandRef: "cat",
    input: {
      token: "vault:secret/data/demo#token"
    }
  });

  assert.equal(result.status, "FAILED");
  assert.match(String(result.error), /Vault is not configured/i);

  if (prevAddr === undefined) delete process.env.VAULT_ADDR;
  else process.env.VAULT_ADDR = prevAddr;
});
