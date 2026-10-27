import cors from '@fastify/cors';
import { buildError, type ErrorCode } from '@roboflow/contracts';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { DeviceAuthenticator } from './auth/device.js';
import type { OidcVerifier } from './auth/internal.js';
import { OperatorAuth, type OperatorVerifier } from './auth/operator.js';
import type { Config } from './config.js';
import { AlreadyExistsError, AppError } from './errors.js';
import { RateLimiter } from './lib/rateLimit.js';
import { loggerOptions, traceField } from './lib/logging.js';
import { systemClock, type Clock } from './lib/ids.js';
import { InlinePublisher, PubSubPublisher } from './pubsub.js';
import { registerApiRoutes } from './routes/api.js';
import { registerDeviceRoutes } from './routes/device.js';
import { registerInternalRoutes } from './routes/internal.js';
import { consumeEnvelope } from './services/derive.js';
import type { Deps, Publisher } from './services/common.js';
import type { Operator } from './services/operator.js';
import type { Store } from './store/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: string;
    operator?: Operator;
  }
}

export const VERSION = '1.0.0';

export interface AppOptions {
  cfg: Config;
  store: Store;
  clock?: Clock;
  publisher?: Publisher;
  operatorVerifier?: OperatorVerifier;
  oidcVerifier?: OidcVerifier;
  /** `false` silencia o log (testes). Por padrão usa o formato do Cloud Logging. */
  logger?: FastifyServerOptions['logger'];
}

export interface BuiltApp {
  app: FastifyInstance;
  deps: Deps;
}

export async function buildApp(opts: AppOptions): Promise<BuiltApp> {
  const { cfg, store } = opts;
  const clock = opts.clock ?? systemClock;

  const app = Fastify({
    logger: opts.logger ?? loggerOptions(cfg),
    // Log de requisição próprio (onResponse): sem o par incoming/completed padrão do Fastify.
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 64 * 1024,
    trustProxy: true,
  });

  const deps = { store, cfg, clock, log: app.log, mapCache: new Map() } as Deps;
  deps.publisher =
    opts.publisher ??
    (cfg.store === 'memory'
      ? new InlinePublisher((env) => consumeEnvelope(deps, env), app.log)
      : new PubSubPublisher(cfg.gcpProject, cfg.topicEvents));

  // ------------------------------------------------------------- corpo cru
  // O HMAC do dispositivo é calculado sobre os bytes exatos enviados.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    req.rawBody = body as string;
    if ((body as string).length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError('INVALID_BODY', 'Corpo não é um JSON válido.'), undefined);
    }
  });

  // ------------------------------------------------------------------ CORS
  await app.register(cors, {
    origin: cfg.corsOrigins.length > 0 ? cfg.corsOrigins : false,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
    maxAge: 600,
  });

  // --------------------------------------------- trace do Cloud Logging + headers
  app.addHook('onRequest', async (req, reply) => {
    const trace = traceField(req.headers['x-cloud-trace-context'] as string | undefined, cfg.gcpProject);
    if (Object.keys(trace).length > 0) req.log = req.log.child(trace);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('cache-control', 'no-store');
  });

  app.addHook('onResponse', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    const quiet = path === '/health' || path.startsWith('/device/poll');
    const level = reply.statusCode >= 500 ? 'error' : reply.statusCode >= 400 ? 'warn' : quiet ? 'debug' : 'info';
    req.log[level](
      { method: req.method, path, status: reply.statusCode, ms: Math.round(reply.elapsedTime) },
      'requisição',
    );
  });

  // -------------------------------------------------------------------- erros
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string };
    if (e instanceof AppError) {
      return reply.code(e.status).send(buildError(e.code, e.message, e.details));
    }
    if (e instanceof AlreadyExistsError) {
      return reply.code(409).send(buildError('CONFLICT_STATE', 'Conflito de concorrência; tente novamente.'));
    }
    if (e.statusCode === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send(buildError('PAYLOAD_TOO_LARGE', 'Corpo da requisição grande demais.'));
    }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) {
      const code: ErrorCode = 'INVALID_BODY';
      return reply.code(e.statusCode).send(buildError(code, 'Requisição inválida.'));
    }
    req.log.error({ err: { message: e.message, stack: e.stack } }, 'erro interno');
    return reply.code(500).send(buildError('INTERNAL', 'Erro interno do servidor.'));
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(buildError('NOT_FOUND', 'Recurso não encontrado.'));
  });

  // ------------------------------------------------------------------- rotas
  const userLimiter = new RateLimiter(cfg.rateLimitUserPerMin);
  const deviceLimiter = new RateLimiter(cfg.rateLimitDevicePerMin);
  const operatorAuth = new OperatorAuth(cfg, opts.operatorVerifier);
  const deviceAuth = new DeviceAuthenticator(cfg.deviceSecrets, cfg.deviceClockSkewMs, clock);

  app.get('/health', async () => ({ status: 'ok' })); // sem dependência de banco (probe do Cloud Run)
  registerApiRoutes(app, deps, { operatorAuth, userLimiter });
  registerDeviceRoutes(app, deps, { deviceAuth, deviceLimiter });
  registerInternalRoutes(app, deps, opts.oidcVerifier);

  return { app, deps };
}
