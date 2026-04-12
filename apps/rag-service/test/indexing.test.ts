import assert from "node:assert/strict";
import test from "node:test";
import { buildSourceDocuments } from "../src/indexing.js";

test("buildSourceDocuments returns filtered workflow guide docs", () => {
  const docs = buildSourceDocuments("workflow-guide");
  assert.ok(docs.length >= 1);
  assert.ok(docs.every((doc) => doc.externalId.includes("workflow") || doc.externalId.includes("checkpoint")));
});

test("buildSourceDocuments respects requested document limit", () => {
  const docs = buildSourceDocuments("incident-ops", 1);
  assert.equal(docs.length, 1);
});
