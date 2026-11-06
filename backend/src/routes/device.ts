import { ENDPOINTS, LIMITS, SensorInputSchema, type DeviceEventMessage, type Endpoint, type HelloMessage } from '@roboflow/contracts';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeviceAuthenticator } from '../auth/device.js';
import type { RobotDoc } from '../domain/types.js';
import { AppError, invalidBody, tooMany } from '../errors.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { labels } from '../lib/logging.js';
import type { Deps } from '../services/common.js';
import { handleEvents, handleHello, handlePoll, type DeviceAuth } from '../services/device.js';
import { C } from '../store/types.js';
import { handleSensors } from '../services/sensor-control.js';

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
  // Limites aplicados ANTES de qualquer leitura de banco: por IP de origem e por falhas de autenticação.
  const ipLimiter = new RateLimiter(deps.cfg.rateLimitIpPerMin);
  const failLimiter = new RateLimiter(deps.cfg.rateLimitAuthFailPerMin);
  const preAuth = (req: FastifyRequest, reply: { header: (k: string, v: string) => unknown }): void => {
    if (!ipLimiter.allow(req.ip) || failLimiter.peek(req.ip)) {
      reply.header('retry-after', '60');
      throw tooMany();
    }
  };

  // O controle remoto precisa de amostras frequentes, em rede local. Legado: desligado em produção.
  const sensorLimiter = new RateLimiter(1800);
  app.post('/device/sensors', { bodyLimit: 1024 }, async (req, reply) => {
    if (!deps.cfg.enableLegacySensors) throw new AppError('NOT_FOUND', 'Recurso não encontrado.');
    const deviceId = req.headers['x-device-id'];
    const authorization = req.headers.authorization ?? '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const digest = (s: string) => createHash('sha256').update(s).digest();
    const secrets = typeof deviceId === 'string' && Object.hasOwn(deps.cfg.deviceSecrets, deviceId)
      ? deps.cfg.deviceSecrets[deviceId]! : [];
    if (!token || !secrets.some(secret => timingSafeEqual(digest(secret), digest(token)))) {
      throw new AppError('SIGNATURE_INVALID', 'Credencial inválida.');
    }
    if (!sensorLimiter.allow(deviceId as string)) throw tooMany();
    const parsed = SensorInputSchema.safeParse(req.body);
    if (!parsed.success) throw invalidBody('Envie line:[0|1,0|1,0|1], boot, sequence e applied.');
    return reply.send({ success: true, data: await handleSensors(deps, deviceId as string, parsed.data) });
  });

  /** Autentica (HMAC) e aplica o limite por dispositivo. Dispositivo desconhecido não toca o banco. */
  async function guard(req: FastifyRequest, reply: { header: (k: string, v: string) => unknown }): Promise<{ auth: DeviceAuth; robot: RobotDoc }> {
    preAuth(req, reply);
    const claimed = (req.headers['x-device-id'] as string | undefined) ?? '';
    const robot = g.deviceAuth.hasDevice(claimed) ? await deps.store.get<RobotDoc>(C.robots, claimed) : undefined;
    let auth: DeviceAuth;
    try {
      auth = g.deviceAuth.verify(req, robot, req.rawBody ?? '');
    } catch (err) {
      failLimiter.allow(req.ip); // conta a falha; ao exceder o teto, preAuth passa a barrar antes do banco
      throw err;
    }
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
      const { auth } = await guard(req, reply);
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
      const { auth, robot } = await guard(req, reply);
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
      const { auth } = await guard(req, reply);
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
