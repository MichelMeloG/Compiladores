import type { InternalEventEnvelope } from '@roboflow/contracts';
import type { FastifyBaseLogger } from 'fastify';
import type { Publisher } from './services/common.js';

/** Publica no tópico `agv-events` (a API tem `pubsub.publisher` só nele e na DLQ). */
export class PubSubPublisher implements Publisher {
  private topic: import('@google-cloud/pubsub').Topic | undefined;

  constructor(
    private readonly projectId: string,
    private readonly topicName: string,
  ) {}

  private async getTopic(): Promise<import('@google-cloud/pubsub').Topic> {
    if (!this.topic) {
      const { PubSub } = await import('@google-cloud/pubsub');
      this.topic = new PubSub({ projectId: this.projectId }).topic(this.topicName);
    }
    return this.topic;
  }

  async publish(envelope: InternalEventEnvelope): Promise<void> {
    const topic = await this.getTopic();
    await topic.publishMessage({
      json: envelope,
      attributes: { deviceId: envelope.deviceId, type: envelope.event.type },
    });
  }
}

/**
 * Entrega "inline" ao consumidor (dev e testes sem Pub/Sub): mesmo caminho de
 * código do consumidor real, sem rede. Falhas não derrubam o ingest.
 */
export class InlinePublisher implements Publisher {
  constructor(
    private handler: (env: InternalEventEnvelope) => Promise<unknown>,
    private readonly log: FastifyBaseLogger,
  ) {}

  async publish(envelope: InternalEventEnvelope): Promise<void> {
    try {
      await this.handler(envelope);
    } catch (err) {
      this.log.error({ err, eventId: envelope.eventId }, 'falha no consumidor inline');
    }
  }
}

/** Publicador de teste: registra o que foi publicado. */
export class RecordingPublisher implements Publisher {
  readonly published: InternalEventEnvelope[] = [];
  failNext = false;

  async publish(envelope: InternalEventEnvelope): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('falha simulada de publicação');
    }
    this.published.push(envelope);
  }
}
