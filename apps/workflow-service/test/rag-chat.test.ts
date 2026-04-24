import assert from "node:assert/strict";
import test from "node:test";
import {
  RAG_DISCUSSION_RETENTION_DAYS,
  buildRagThreadExpiry,
  deriveRagThreadTitle,
  extractFlowiseText,
  mapRagDiscussionSummary,
  mapRagDiscussionThread
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

test("discussion mappers expose dify vs legacy backend metadata", () => {
  const legacySummary = mapRagDiscussionSummary({
    id: "legacy-thread",
    title: "Legacy",
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    lastMessageAt: new Date("2026-04-15T00:00:00.000Z"),
    expiresAt: new Date("2026-04-22T00:00:00.000Z"),
    knowledgeBaseId: null
  });
  assert.equal(legacySummary.backend, "legacy-flowise");
  assert.equal(legacySummary.knowledgeBaseId, undefined);

  const difyThread = mapRagDiscussionThread(
    {
      id: "dify-thread",
      title: "Dify",
      createdAt: new Date("2026-04-15T00:00:00.000Z"),
      updatedAt: new Date("2026-04-15T00:00:00.000Z"),
      lastMessageAt: new Date("2026-04-15T00:00:00.000Z"),
      expiresAt: new Date("2026-04-22T00:00:00.000Z"),
      knowledgeBaseId: "kb-1"
    },
    []
  );
  assert.equal(difyThread.backend, "dify");
  assert.equal(difyThread.knowledgeBaseId, "kb-1");
});
