import assert from "node:assert/strict";
import test from "node:test";
import type { Channel, ChannelModel } from "amqplib";
import { buildEventEnvelope, EventPublisher } from "../src/events.js";

test("buildEventEnvelope returns stable rag event shape", () => {
  const now = new Date("2026-04-10T00:00:00.000Z");
  const envelope = buildEventEnvelope("rag.index.requested", { source: "manual" }, now);
  assert.deepEqual(envelope, {
    event: "rag.index.requested",
    timestamp: "2026-04-10T00:00:00.000Z",
    payload: { source: "manual" }
  });
});

test("EventPublisher publishes rag index envelope to topic exchange", async () => {
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
  await publisher.publish("rag.index.requested", { source: "manual", documents: 3 });

  assert.equal(routingKey, "rag.index.requested");
  assert.equal(contentType, "application/json");
  assert.equal(persistent, true);

  const decoded = JSON.parse(rawMessage) as {
    event: string;
    timestamp: string;
    payload: { source: string; documents: number };
  };
  assert.equal(decoded.event, "rag.index.requested");
  assert.equal(typeof decoded.timestamp, "string");
  assert.deepEqual(decoded.payload, { source: "manual", documents: 3 });
});
