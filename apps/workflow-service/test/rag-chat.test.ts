import assert from "node:assert/strict";
import test from "node:test";
import {
  RAG_DISCUSSION_RETENTION_DAYS,
  buildRagThreadExpiry,
  deriveRagThreadTitle,
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

test("discussion mappers always report dify backend", () => {
  const summary = mapRagDiscussionSummary({
    id: "dify-thread-summary",
    title: "Summary",
    createdAt: new Date("2026-04-15T00:00:00.000Z"),
    updatedAt: new Date("2026-04-15T00:00:00.000Z"),
    lastMessageAt: new Date("2026-04-15T00:00:00.000Z"),
    expiresAt: new Date("2026-04-22T00:00:00.000Z"),
    knowledgeBaseId: "kb-1"
  });
  assert.equal(summary.backend, "dify");

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
