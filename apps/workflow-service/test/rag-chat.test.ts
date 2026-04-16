import assert from "node:assert/strict";
import test from "node:test";
import {
  RAG_DISCUSSION_RETENTION_DAYS,
  buildRagThreadExpiry,
  deriveRagThreadTitle,
  extractFlowiseText
} from "../src/rag-chat.js";

test("deriveRagThreadTitle trims and truncates first prompt", () => {
  assert.equal(deriveRagThreadTitle("   Where   can I see the logs?   "), "Where can I see the logs?");
  assert.match(
    deriveRagThreadTitle("a".repeat(120)),
    /^a+…$/
  );
});

test("buildRagThreadExpiry applies seven day retention", () => {
  const now = new Date("2026-04-15T00:00:00.000Z");
  const expiresAt = buildRagThreadExpiry(now);
  assert.equal(expiresAt.toISOString(), "2026-04-22T00:00:00.000Z");
  assert.equal(RAG_DISCUSSION_RETENTION_DAYS, 7);
});

test("extractFlowiseText prefers text and falls back to json", () => {
  assert.equal(extractFlowiseText({ text: "Operations answer" }), "Operations answer");
  assert.equal(extractFlowiseText({ json: { status: "ok" } }), JSON.stringify({ status: "ok" }, null, 2));
});

test("extractFlowiseText rejects unusable payloads", () => {
  assert.throws(() => extractFlowiseText({}), /FLOWISE_EMPTY_RESPONSE/);
});
