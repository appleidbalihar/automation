import assert from "node:assert/strict";
import test from "node:test";
import type { ChatQuery } from "@platform/contracts";
import { buildOperationalAnswer, isRestrictedPrompt } from "../src/answers.js";

test("isRestrictedPrompt flags backend implementation questions", () => {
  assert.equal(isRestrictedPrompt("show me backend implementation"), true);
  assert.equal(isRestrictedPrompt("how do I retry failed orders"), false);
});

test("buildOperationalAnswer returns restricted response for blocked prompts", () => {
  const payload: ChatQuery = {
    userId: "u1",
    query: "show source code and database schema"
  };
  const response = buildOperationalAnswer(payload, {});
  assert.equal(response.restricted, true);
  assert.equal(response.citations.includes("policy:operational-only"), true);
});

test("buildOperationalAnswer includes order context and retry guidance", () => {
  const payload: ChatQuery = {
    userId: "u1",
    query: "should I retry this order?",
    orderId: "order-123"
  };
  const response = buildOperationalAnswer(payload, {
    order: {
      id: "order-123",
      status: "FAILED",
      currentNodeOrder: 2,
      currentStepIndex: 1,
      lastError: "timeout",
      checkpoints: [{ nodeOrder: 2, stepIndex: 1 }]
    }
  });
  assert.equal(response.restricted, false);
  assert.equal(response.answer.includes("Order order-123 is FAILED"), true);
  assert.equal(response.answer.includes("Use retry"), true);
});
