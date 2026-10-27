import { ENDPOINTS, LIMITS, type DeviceEventMessage, type Endpoint, type HelloMessage } from '@roboflow/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceAuthenticator } from '../auth/device.js';
import type { RobotDoc } from '../domain/types.js';
import { AppError, invalidBody, tooMany } from '../errors.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import { labels } from '../lib/logging.js';
import type { Deps } from '../services/common.js';
import { handleEvents, handleHello, handlePoll, type DeviceAuth } from '../services/device.js';
import { C } from '../store/types.js';

const ep = (id: string): Endpoint => {
  const e = (ENDPOINTS as readonly Endpoint[]).find((x) => x.id === id);
  if (!e) throw new Error(`Endpoint ${id} ausente do registro de contratos.`);
  return e;
};

export function registerDeviceRoutes(
  app: FastifyInstance,
  deps: Deps,
  g: { deviceAuth: DeviceAuthenticator; deviceLimiter: RateLimiter },
): void {
  /** Autentica (HMAC) e aplica o limite por dispositivo. Dispositivo desconhecido não toca o banco. */
  async function guard(req: FastifyRequest): Promise<{ auth: DeviceAuth; robot: RobotDoc }> {
    const claimed = (req.headers['x-device-id'] as string | undefined) ?? '';
    const robot = g.deviceAuth.hasDevice(claimed) ? await deps.store.get<RobotDoc>(C.robots, claimed) : undefined;
    const auth = g.deviceAuth.verify(req, robot, req.rawBody ?? '');
    if (!g.deviceLimiter.allow(auth.deviceId)) throw tooMany();
    req.log = req.log.child(labels({ deviceId: auth.deviceId, sessionId: auth.sessionId }));
    return { auth, robot: robot as RobotDoc };
  }

  const opts = { bodyLimit: LIMITS.deviceBodyMaxBytes };

  app.route({
    method: 'POST',
    url: '/device/hello',
    ...opts,
    handler: async (req, reply) => {
      const { auth } = await guard(req);
      const parsed = ep('deviceHello').body?.safeParse(req.body ?? {});
      if (!parsed?.success) throw invalidBody('Mensagem hello inválida.');
      const hello = parsed.data as HelloMessage;
      if (hello.deviceId !== auth.deviceId || hello.sessionId !== auth.sessionId) {
        throw invalidBody('deviceId/sessionId do corpo divergem dos cabeçalhos assinados.');
      }
      const res = await handleHello(deps, auth, hello);
      req.log.info(labels({ deviceId: auth.deviceId, sessionId: auth.sessionId }), 'hello');
      return reply.send({ success: true, data: res });
    },
  });

  app.route({
    method: 'GET',
    url: '/device/poll',
    ...opts,
    handler: async (req, reply) => {
      const { auth, robot } = await guard(req);
      if (robot.sessionId !== auth.sessionId) {
        throw new AppError('CONFLICT_SESSION', 'Sessão desconhecida: envie /device/hello.');
      }
      return reply.send({ success: true, data: await handlePoll(deps, auth, robot) });
    },
  });

  app.route({
    method: 'POST',
    url: '/device/events',
    ...opts,
    handler: async (req, reply) => {
      const { auth } = await guard(req);
      const parsed = ep('deviceEvents').body?.safeParse(req.body ?? {});
      if (!parsed?.success) throw invalidBody('Lote de eventos inválido.');
      const events = (parsed.data as { events: DeviceEventMessage[] }).events;
      const { response, accepted } = await handleEvents(deps, auth, events);

      // Publicação best-effort: os eventos já estão persistidos; a varredura do
      // Scheduler recupera rollups se uma publicação se perder.
      await Promise.all(
        accepted.map((env) =>
          deps.publisher.publish(env).catch((err: unknown) => {
            req.log.error({ err, eventId: env.eventId }, 'falha ao publicar evento');
          }),
        ),
      );
      return reply.send({ success: true, data: response });
    },
  });
}
