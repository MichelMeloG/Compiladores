import { ENDPOINTS, type Endpoint, type EndpointId } from '@roboflow/contracts';
import type { FastifyInstance } from 'fastify';
import { expect } from 'vitest';
import { loadConfig, type Config } from '../src/config.js';
import type { OidcVerifier } from '../src/auth/internal.js';
import type { OperatorVerifier } from '../src/auth/operator.js';
import { RecordingPublisher } from '../src/pubsub.js';
import { seedStore, type SeedProfile } from '../src/seed.js';
import { buildApp } from '../src/server.js';
import type { Deps, Publisher } from '../src/services/common.js';
import { MemoryStore } from '../src/store/memory.js';
import { EspSim, type Transport } from '../tools/esp-sim/sim.js';

export const SECRETS = {
  'RB-01': 'secret-rb01-0123456789abcdef0123',
  'RB-02': 'secret-rb02-0123456789abcdef0123',
  'RB-03': 'secret-rb03-0123456789abcdef0123',
};

export class TestClock {
  constructor(public t = Date.parse('2026-10-26T18:00:00.000Z')) {}
  now = () => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

export interface Harness {
  app: FastifyInstance;
  deps: Deps;
  store: MemoryStore;
  clock: TestClock;
  cfg: Config;
  publisher: Publisher;
  recorded: RecordingPublisher | undefined;
  transport: Transport;
  sim: (deviceId?: keyof typeof SECRETS) => EspSim;
  api: (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    o?: { body?: unknown; role?: string; uid?: string; idem?: string; headers?: Record<string, string>; token?: string },
  ) => Promise<{ status: number; json: any; headers: Record<string, any> }>;
  close: () => Promise<void>;
}

export interface HarnessOptions {
  profile?: SeedProfile;
  env?: Record<string, string>;
  /** `inline` (padrão): o consumidor roda no mesmo processo. `record`: só registra as mensagens. */
  publisher?: 'inline' | 'record';
  operatorVerifier?: OperatorVerifier;
  oidcVerifier?: OidcVerifier;
  logger?: any;
}

export async function makeHarness(o: HarnessOptions = {}): Promise<Harness> {
  const clock = new TestClock();
  const cfg = loadConfig({
    STORE: 'memory',
    AUTH_MODE: 'off',
    LOG_LEVEL: 'silent',
    DEVICE_SECRETS_JSON: JSON.stringify(SECRETS),
    SEED_ON_BOOT: 'false',
    CORS_ORIGINS: 'https://michelmelog.github.io',
    INTERNAL_AUDIENCE: 'https://api.test',
    PUBSUB_PUSH_SA: 'pubsub-invoker@test.iam',
    SCHEDULER_SA: 'scheduler-invoker@test.iam',
    ...o.env,
  } as NodeJS.ProcessEnv);
  const store = new MemoryStore();
  const recorded = o.publisher === 'record' ? new RecordingPublisher() : undefined;
  const { app, deps } = await buildApp({
    cfg,
    store,
    clock: clock.now,
    ...(recorded ? { publisher: recorded } : {}),
    ...(o.operatorVerifier ? { operatorVerifier: o.operatorVerifier } : {}),
    ...(o.oidcVerifier ? { oidcVerifier: o.oidcVerifier } : {}),
    logger: o.logger ?? false,
  });
  await seedStore(deps, o.profile ?? 'clean');
  await app.ready();

  const transport: Transport = async (req) => {
    const r = await app.inject({
      method: req.method,
      url: req.path,
      headers: req.headers,
      ...(req.body !== undefined ? { payload: req.body } : {}),
    });
    return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
  };

  return {
    app,
    deps,
    store,
    clock,
    cfg,
    publisher: deps.publisher,
    recorded,
    transport,
    sim: (deviceId = 'RB-01') =>
      new EspSim({ deviceId, secret: SECRETS[deviceId], transport, now: () => clock.t }),
    api: async (method, url, opt = {}) => {
      const r = await app.inject({
        method,
        url,
        headers: {
          ...(opt.token ? { authorization: `Bearer ${opt.token}` } : {}),
          'x-dev-role': opt.role ?? 'operator',
          'x-dev-uid': opt.uid ?? 'op-1',
          ...(opt.idem ? { 'idempotency-key': opt.idem } : {}),
          ...(opt.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...opt.headers,
        },
        ...(opt.body !== undefined ? { payload: JSON.stringify(opt.body) } : {}),
      });
      let json: any = null;
      try {
        json = r.body ? JSON.parse(r.body) : null;
      } catch {
        json = r.body;
      }
      return { status: r.statusCode, json, headers: r.headers as Record<string, any> };
    },
    close: async () => {
      await app.close();
    },
  };
}

/** Valida `data` contra o schema do registro de contratos. */
export function expectContract(id: EndpointId, json: any): void {
  const ep = (ENDPOINTS as readonly Endpoint[]).find((e) => e.id === id) as Endpoint;
  const r = ep.response.safeParse(json?.data);
  if (!r.success) {
    throw new Error(`Resposta de ${id} fora do contrato: ${JSON.stringify((r.error as any).issues?.slice(0, 5))}`);
  }
  expect(json.success).toBe(true);
}

/** Rota válida do RB-01 (pista-1, a partir de 2,1 com rumo E): F F E. */
export const ROUTE_RB01 = [
  { x: 2, y: 1 },
  { x: 3, y: 1 },
  { x: 4, y: 1 },
  { x: 4, y: 0 },
];

export interface Started {
  missionId: string;
  routeId: string;
  commandId: string;
}

/** Cria a missão (online) e carrega a fila no simulador: estado `ready`. */
export async function loadMission(h: Harness, sim: EspSim, key = 'k-route-1'): Promise<Started> {
  const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: key });
  expect(r.status).toBe(201);
  expect(r.json.data.accepted).toBe(true);
  await sim.poll();
  return { missionId: r.json.data.missionId, routeId: r.json.data.routeId, commandId: r.json.data.commandId };
}

export async function startMission(h: Harness, sim: EspSim, missionId: string, key = 'k-start-1'): Promise<void> {
  const r = await h.api('POST', `/api/missions/${missionId}/start`, { body: {}, idem: key });
  expect(r.status).toBe(202);
  await sim.poll();
}

export const mission = async (h: Harness, id: string) => (await h.api('GET', `/api/missions/${id}`)).json.data;
export const execution = async (h: Harness, id: string) => (await h.api('GET', `/api/missions/${id}/execution`)).json.data;
