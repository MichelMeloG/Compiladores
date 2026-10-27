import {
  ENDPOINTS,
  IDEMPOTENCY_HEADER,
  type Endpoint,
  type EndpointId,
  type Heading,
} from '@roboflow/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireRole, type OperatorAuth } from '../auth/operator.js';
import { AppError, invalidBody, invalidQuery, tooMany } from '../errors.js';
import type { RateLimiter } from '../lib/rateLimit.js';
import type { Deps } from '../services/common.js';
import * as ops from '../services/operator.js';
import type { Operator } from '../services/operator.js';
import * as q from '../services/queries.js';
import { fleetMetrics, dashboardMetrics } from '../services/metrics.js';
import { VERSION } from '../server.js';

interface Ctx {
  req: FastifyRequest;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  op: Operator;
  idemKey: string | undefined;
}

interface Result {
  status?: number;
  data: unknown;
  extra?: Record<string, unknown>;
}

type Handler = (c: Ctx) => Promise<Result>;

const CACHEABLE = new Set<string>(['dashboardMetrics', 'fleetMetrics', 'listMissions', 'listLogs', 'getGrid', 'getRobotEvents']);

const endpointById = (id: EndpointId): Endpoint => {
  const e = (ENDPOINTS as readonly Endpoint[]).find((x) => x.id === id);
  if (!e) throw new Error(`Endpoint ${id} ausente do registro de contratos.`);
  return e;
};

function issues(err: { issues?: { path: PropertyKey[]; message: string }[] }): string {
  return (err.issues ?? [])
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join('.') || '(raiz)'}: ${i.message}`)
    .join('; ');
}

function pageResult<T>(p: q.Page<T>): Result {
  return { data: p.items, extra: p.nextCursor ? { nextCursor: p.nextCursor } : {} };
}

export function registerApiRoutes(
  app: FastifyInstance,
  deps: Deps,
  g: { operatorAuth: OperatorAuth; userLimiter: RateLimiter },
): void {
  const handlers: Partial<Record<EndpointId, Handler>> = {
    health: async () => ({ data: await q.health(deps, VERSION) }),
    listRobots: async () => ({ data: await q.listRobots(deps) }),
    getRobot: async (c) => ({ data: await q.getRobot(deps, c.params['id'] as string) }),
    fleetMetrics: async (c) => ({ data: await fleetMetrics(deps, c.query) }),
    dashboardMetrics: async (c) => ({ data: await dashboardMetrics(deps, c.query) }),
    listMissions: async (c) => pageResult(await q.listMissions(deps, c.query)),
    getMission: async (c) => ({ data: await q.getMission(deps, c.params['id'] as string) }),
    listLogs: async (c) => pageResult(await q.listLogs(deps, c.query)),
    importLogs: async (c) => ({ data: await q.importLogs(deps, c.body['events'] as never) }),
    listAlerts: async (c) => pageResult(await q.listAlerts(deps, c.query)),
    acknowledgeAlert: async (c) => ({ data: await q.acknowledgeAlert(deps, c.params['id'] as string) }),
    getRobotEvents: async (c) => pageResult(await q.listRobotEvents(deps, c.params['id'] as string, c.query)),
    getGrid: async (c) => ({ data: await q.getGrid(deps, c.params['id'] as string) }),
    getRoute: async (c) => ({ data: await q.getActiveRoute(deps, c.params['id'] as string) }),
    previewRoute: async (c) => ({ data: await ops.previewRoute(deps, c.params['id'] as string, c.body as never) }),
    submitRoute: async (c) => {
      const r = await ops.submitRoute(deps, c.params['id'] as string, c.body as never, c.op, c.idemKey as string);
      return { status: r.status, data: r.body };
    },
    startMission: control('start'),
    stopMission: control('stop'),
    resumeMission: control('resume'),
    abortMission: control('abort'),
    getCommand: async (c) => ({ data: await q.getCommand(deps, c.params['id'] as string) }),
    getExecution: async (c) => ({ data: await q.getExecution(deps, c.params['id'] as string) }),
    getDeviceStatus: async (c) => ({ data: await q.getDeviceStatus(deps, c.params['id'] as string) }),
    confirmPosition: async (c) => ({
      data: await ops.confirmPosition(deps, c.params['id'] as string, {
        x: c.body['x'] as number,
        y: c.body['y'] as number,
        heading: c.body['heading'] as Heading,
      }),
    }),
    forceCloseMission: async (c) => ({ data: await ops.forceCloseMission(deps, c.params['id'] as string, c.op) }),
  };

  function control(kind: ops.ControlKind): Handler {
    return async (c) => {
      const r = await ops.controlMission(deps, c.params['id'] as string, kind, c.body as never, c.op, c.idemKey as string);
      return { status: r.status, data: r.body };
    };
  }

  for (const ep of ENDPOINTS as readonly Endpoint[]) {
    if (ep.auth !== 'public' && ep.auth !== 'operator') continue;
    const handler = handlers[ep.id as EndpointId];
    if (!handler) throw new Error(`Handler ausente para ${ep.id}`);
    const bodyLimit = ep.id === 'importLogs' ? 2 * 1024 * 1024 : 64 * 1024;

    app.route({
      method: ep.method,
      url: ep.path,
      bodyLimit,
      handler: async (req, reply) => {
        let op: Operator = { uid: 'anonymous', email: '', role: 'viewer' };
        if (ep.auth === 'operator') {
          op = await g.operatorAuth.authenticate(req);
          requireRole(op, ep.roles);
          if (!g.userLimiter.allow(op.uid)) {
            reply.header('retry-after', '60');
            throw tooMany();
          }
          req.operator = op;
        }

        const idemRaw = req.headers[IDEMPOTENCY_HEADER.toLowerCase()];
        const idemKey = (Array.isArray(idemRaw) ? idemRaw[0] : idemRaw)?.trim();
        if (ep.idempotency === 'required' && !idemKey) {
          throw new AppError('IDEMPOTENCY_KEY_REQUIRED', `Envie o cabeçalho ${IDEMPOTENCY_HEADER}.`);
        }
        if (idemKey && idemKey.length > 200) throw invalidBody(`${IDEMPOTENCY_HEADER} longo demais.`);

        let query: Record<string, unknown> = {};
        if (ep.query) {
          const r = ep.query.safeParse(req.query);
          if (!r.success) throw invalidQuery(issues(r.error as never) || 'Parâmetros de consulta inválidos.');
          query = r.data as Record<string, unknown>;
        }
        let body: Record<string, unknown> = {};
        if (ep.body) {
          const r = ep.body.safeParse(req.body ?? {});
          if (!r.success) throw invalidBody(issues(r.error as never) || 'Corpo inválido.');
          body = r.data as Record<string, unknown>;
        }

        const result = await handler({
          req,
          params: req.params as Record<string, string>,
          query,
          body,
          op,
          idemKey,
        });
        // Leituras pesadas e estáveis: o navegador pode reaproveitar por 5 s (cota do Firestore).
        // Estado operacional (robôs, execução, comandos, alertas, rota) nunca é cacheado.
        if (CACHEABLE.has(ep.id)) reply.header('cache-control', 'private, max-age=5');
        return reply.code(result.status ?? ep.okStatus[0] ?? 200).send({ success: true, data: result.data, ...(result.extra ?? {}) });
      },
    });
  }
}
