import { InternalEventEnvelopeSchema, PubSubPushBodySchema } from '@roboflow/contracts';
import type { FastifyInstance } from 'fastify';
import { requireInternal, type OidcVerifier } from '../auth/internal.js';
import { invalidBody } from '../errors.js';
import type { Deps } from '../services/common.js';
import { consumeEnvelope, offlineCheck } from '../services/derive.js';

export function registerInternalRoutes(app: FastifyInstance, deps: Deps, verifier: OidcVerifier | undefined): void {
  /**
   * Entrega push do Pub/Sub. 2xx confirma; qualquer outro status reentrega
   * (e após 5 tentativas vai para a DLQ). O consumidor é idempotente.
   */
  app.post('/internal/events', async (req, reply) => {
    await requireInternal(req, verifier, deps.cfg, deps.cfg.pubsubPushSa);
    const push = PubSubPushBodySchema.safeParse(req.body ?? {});
    if (!push.success) throw invalidBody('Envelope Pub/Sub inválido.');
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(push.data.message.data, 'base64').toString('utf8'));
    } catch {
      throw invalidBody('Dados da mensagem não são JSON.');
    }
    const env = InternalEventEnvelopeSchema.safeParse(json);
    if (!env.success) throw invalidBody('Mensagem fora do formato InternalEventEnvelope.');
    const result = await consumeEnvelope(deps, env.data);
    return reply.send({ success: true, data: result });
  });

  /** Cloud Scheduler: offline, comandos vencidos e catch-up de rollups. */
  app.post('/internal/offline-check', async (req, reply) => {
    await requireInternal(req, verifier, deps.cfg, deps.cfg.schedulerSa);
    const result = await offlineCheck(deps);
    return reply.send({ success: true, data: result });
  });
}
