import amqp from "amqplib";
import type { Channel, ChannelModel } from "amqplib";

const PLATFORM_EVENTS_EXCHANGE = "platform.events";

export interface EventEnvelope {
  event: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

export function buildEventEnvelope(event: string, payload: Record<string, unknown>, now: Date = new Date()): EventEnvelope {
  return {
    event,
    timestamp: now.toISOString(),
    payload
  };
}

type ConnectFn = (url: string) => Promise<ChannelModel>;

export class EventPublisher {
  private connection?: ChannelModel;
  private channel?: Channel;
  private connecting?: Promise<void>;

  constructor(
    private readonly rabbitmqUrl: string,
    private readonly exchange: string = PLATFORM_EVENTS_EXCHANGE,
    private readonly connectFn: ConnectFn = (url) => amqp.connect(url)
  ) {}

  private async connect(): Promise<void> {
    if (this.channel) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }
    this.connecting = (async () => {
      this.connection = await this.connectFn(this.rabbitmqUrl);
      const channel = await this.connection.createChannel();
      await channel.assertExchange(this.exchange, "topic", { durable: true });
      this.channel = channel;
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }

  async publish(event: string, payload: Record<string, unknown>): Promise<void> {
    try {
      await this.connect();
      if (!this.channel) return;
      const envelope = buildEventEnvelope(event, payload);
      this.channel.publish(this.exchange, event, Buffer.from(JSON.stringify(envelope)), {
        contentType: "application/json",
        persistent: true
      });
    } catch (error) {
      console.warn("[workflow-service] failed to publish event", event, error instanceof Error ? error.message : String(error));
    }
  }

  async close(): Promise<void> {
    await this.channel?.close().catch(() => undefined);
    await this.connection?.close().catch(() => undefined);
  }
}
