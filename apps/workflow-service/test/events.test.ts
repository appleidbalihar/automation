import assert from "node:assert/strict";
import test from "node:test";
import type { Channel, ChannelModel } from "amqplib";
import { buildEventEnvelope, EventPublisher } from "../src/events.js";

test("buildEventEnvelope returns stable event shape", () => {
  const now = new Date("2026-04-10T00:00:00.000Z");
  const envelope = buildEventEnvelope("workflow.published", { workflowId: "wf-1" }, now);
  assert.deepEqual(envelope, {
    event: "workflow.published",
    timestamp: "2026-04-10T00:00:00.000Z",
    payload: { workflowId: "wf-1" }
  });
});

test("EventPublisher publishes workflow event envelope to topic exchange", async () => {
  let routingKey = "";
  let rawMessage = "";
  let persistent = false;
  let contentType = "";

  const fakeChannel = {
    assertExchange: async () => undefined,
    publish: (_exchange: string, key: string, buffer: Buffer, options: { persistent?: boolean; contentType?: string }) => {
      routingKey = key;
      rawMessage = buffer.toString("utf8");
      persistent = Boolean(options.persistent);
      contentType = String(options.contentType);
      return true;
    },
    close: async () => undefined
  } as unknown as Channel;

  const fakeConnection = {
    createChannel: async () => fakeChannel,
    close: async () => undefined
  } as unknown as ChannelModel;

  const publisher = new EventPublisher("amqp://local-test", "platform.events", async () => fakeConnection);
  await publisher.publish("workflow.published", { workflowId: "wf-1", version: 7 });

  assert.equal(routingKey, "workflow.published");
  assert.equal(contentType, "application/json");
  assert.equal(persistent, true);

  const decoded = JSON.parse(rawMessage) as {
    event: string;
    timestamp: string;
    payload: { workflowId: string; version: number };
  };
  assert.equal(decoded.event, "workflow.published");
  assert.equal(typeof decoded.timestamp, "string");
  assert.deepEqual(decoded.payload, { workflowId: "wf-1", version: 7 });
});
