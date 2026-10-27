/**
 * Servidor MOCK de referência do contrato RoboFlow.
 *
 * Implementa TODOS os endpoints de `ENDPOINTS` em memória, carregando o seed.
 * Serve a três propósitos:
 *   1. o frontend pode desenvolver contra ele (substitui o demo por fetch);
 *   2. valida o runner de contrato (`npm run contract:test`);
 *   3. é a especificação executável: o backend real deve passar na MESMA suíte.
 *
 * NÃO é o backend: sem persistência, sem Firestore, sem Pub/Sub, sem limites de
 * cota. Autenticação simplificada (tokens fixos) apenas para exercitar papéis.
 *
 *   npm run mock                      # http://localhost:8080
 *   MOCK_PORT=9000 MOCK_NO_AUTH=1 npm run mock
 *
 * Variáveis: MOCK_PORT, MOCK_NO_AUTH, MOCK_TOKEN (dev-token), MOCK_VIEWER_TOKEN
 * (viewer-token), MOCK_ADMIN_TOKEN (admin-token), MOCK_INTERNAL_TOKEN (internal-token), MOCK_DEVICE_SECRET
 * (mock-device-secret), MOCK_ORIGINS (http://localhost:3000, separados por vírgula).
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  DEFAULT_CAPABILITIES,
  ERROR_HTTP_STATUS,
  LIMITS,
  POLL_MS,
  aggregateFleetMetrics,
  aggregateMetrics,
  buildError,
  canTransition,
  deviceEventDocId,
  deviceStateToRoverState,
  blockedSet,
  isCriticalEvent,
  isInsideGrid,
  matchEndpoint,
  nodeId,
  parseNodeId,
  projectDeviceEvent,
  publicMissionStatus,
  translateRoute,
  ACTIVE_STATES,
  DeviceEventMessageSchema,
  type Alert,
  type Capabilities,
  type Command,
  type DeviceCommand,
  type DeviceCommandMessage,
  type DeviceCommandType,
  type DeviceEventMessage,
  type DeviceRecord,
  type DeviceState,
  type Endpoint,
  type ErrorCode,
  type Heading,
  type LogEvent,
  type Mission,
  type MissionState,
  type RobotMap,
  type Robot,
  type RouteStep,
  type TimePeriod,
} from '../src/index.js';
import { verifyRequest } from '../src/signing.js';

// ------------------------------------------------------------------ config
const PORT = Number(process.env.MOCK_PORT ?? 8080);
const NO_AUTH = process.env.MOCK_NO_AUTH === '1';
const TOKENS: Record<string, 'admin' | 'operator' | 'viewer'> = {
  [process.env.MOCK_TOKEN ?? 'dev-token']: 'operator',
  [process.env.MOCK_VIEWER_TOKEN ?? 'viewer-token']: 'viewer',
  [process.env.MOCK_ADMIN_TOKEN ?? 'admin-token']: 'admin',
};
const INTERNAL_TOKEN = process.env.MOCK_INTERNAL_TOKEN ?? 'internal-token';
const DEVICE_SECRET = process.env.MOCK_DEVICE_SECRET ?? 'mock-device-secret';
const ORIGINS = (process.env.MOCK_ORIGINS ?? 'http://localhost:3000').split(',');
const COMMAND_TTL_MS = 30_000;

// -------------------------------------------------------------------- seed
const seedDir = join(import.meta.dirname, '..', 'seed');
const seed = <T,>(n: string): T =>
  JSON.parse(readFileSync(join(seedDir, `${n}.json`), 'utf8')) as T;

interface MissionInternal {
  state: MissionState;
  deviceId: string;
  routeRevision: number;
  waypoints: Array<{ x: number; y: number }>;
  actions: Command[];
  expectedNodes: string[];
  steps: RouteStep[];
  startNode: string;
  initialHeading: Heading;
  completedActions: number;
  blockId: string | null;
  blockReasons: string[];
  routeId: string | null;
  sessionId: string | null;
  updatedAt: string;
}

interface DeviceRuntime {
  record: DeviceRecord;
  sessionId: string | null;
  firmwareVersion: string;
  capabilities: Capabilities | null;
  state: DeviceState | null;
  lastSeenAt: string | null;
  lastRequestSequence: number;
  /** Sequências de eventos recebidas na sessão, para ack contíguo e dedupe. */
  seenSequences: Set<number>;
  ackedSequence: number;
  sensors: {
    line: [0 | 1, 0 | 1, 0 | 1] | null;
    distanceCm: number | null;
    distanceValid: boolean;
    distanceAgeMs: number | null;
  } | null;
  blockId: string | null;
  blockReasons: string[];
}

const SEED_NOW = Date.parse(seed<{ seedNow: string }>('manifest').seedNow);
const SHIFT = Date.now() - SEED_NOW;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Reancora todas as datas do seed em "agora", como o demo da dashboard faz. */
function rebase<T>(v: T): T {
  if (typeof v === 'string') return (ISO.test(v) ? new Date(Date.parse(v) + SHIFT).toISOString() : v) as T;
  if (Array.isArray(v)) return v.map(rebase) as T;
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rebase(x)])) as T;
  }
  return v;
}

const maps = seed<RobotMap[]>('maps');
const robots = rebase(seed<Robot[]>('robots'));
const events = rebase(seed<LogEvent[]>('events'));
const missions = rebase(seed<Mission[]>('missions'));
const alerts = rebase(seed<Alert[]>('alerts'));
const activeRoutes = rebase(seed<Array<Record<string, unknown> & { robotId: string }>>('active-routes'));
const deviceRecords = seed<DeviceRecord[]>('devices');
const stateRecords = seed<
  Array<{ missionId: string; deviceId: string; state: MissionState; routeRevision: number }>
>('mission-states');

const routes = new Map<string, Record<string, unknown>>(activeRoutes.map((r) => [r.robotId, r]));
const deviceEvents: Array<LogEvent & { missionId?: string }> = []; // sem missão (diagnóstico)
const commands = new Map<string, DeviceCommand & { messageBody?: DeviceCommandMessage }>();
const idempotency = new Map<string, { hash: string; status: number; body: unknown }>();
const internal = new Map<string, MissionInternal>();
const devices = new Map<string, DeviceRuntime>();

for (const d of deviceRecords) {
  devices.set(d.id, {
    record: d,
    sessionId: null,
    firmwareVersion: robots.find((r) => r.id === d.robotId)?.firmwareVersion ?? '0',
    capabilities: null,
    state: null,
    lastSeenAt: robots.find((r) => r.id === d.robotId)?.lastSeenAt ?? null,
    lastRequestSequence: 0,
    seenSequences: new Set(),
    ackedSequence: 0,
    sensors: null,
    blockId: null,
    blockReasons: [],
  });
}

// Rota ativa do RB-01 vira a missão interna RF-0112 (estado `running`).
for (const s of stateRecords) {
  const route = [...routes.values()].find((r) => r.missionId === s.missionId);
  const map = maps.find((m) => m.id === deviceRecords.find((d) => d.id === s.deviceId)?.mapId)!;
  const waypoints = (route?.waypoints as Array<{ x: number; y: number }> | undefined) ?? [];
  const tr = route
    ? translateRoute(map, waypoints, route.initialHeading as Heading)
    : null;
  internal.set(s.missionId, {
    state: s.state,
    deviceId: s.deviceId,
    routeRevision: s.routeRevision,
    waypoints,
    actions: tr?.actions ?? [],
    expectedNodes: tr?.expectedNodes ?? [],
    steps: tr?.steps ?? [],
    startNode: waypoints[0] ? nodeId(waypoints[0]) : '0,0',
    initialHeading: (route?.initialHeading as Heading | undefined) ?? 'N',
    completedActions: s.state === 'running' ? 3 : tr?.actions.length ?? 0,
    blockId: null,
    blockReasons: [],
    routeId: (route?.routeId as string | undefined) ?? null,
    sessionId: null,
    updatedAt: new Date().toISOString(),
  });
}

let counters = { mission: 113, route: 42, command: 1, event: 1, alert: 5 };
const nowIso = () => new Date().toISOString();

// ----------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
    public status = ERROR_HTTP_STATUS[code]
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(text);
}
const ok = (data: unknown, extra: Record<string, unknown> = {}) => ({ success: true, data, ...extra });

function periodRange(q: Record<string, string>): [number, number] {
  const now = Date.now();
  const period = (q.period ?? 'all') as TimePeriod;
  if (period === 'custom') {
    const s = q.startDate ? Date.parse(q.startDate) : -Infinity;
    const e = q.endDate ? Date.parse(q.endDate) : Infinity;
    if (s > e) throw new HttpError('INVALID_QUERY', 'startDate deve ser anterior a endDate.');
    return [s, e]; // [start, end)
  }
  const h = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 }[period as '24h'];
  return h ? [now - h * 3_600_000, Infinity] : [-Infinity, Infinity];
}

const inRange = (iso: string, [s, e]: [number, number]) => {
  const t = Date.parse(iso);
  return t >= s && t < e;
};

function paginate<T>(items: T[], q: Record<string, string>) {
  const limit = q.limit ? Number(q.limit) : undefined;
  if (!limit) return { items };
  const offset = q.cursor ? Number(Buffer.from(q.cursor, 'base64url').toString()) || 0 : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? Buffer.from(String(offset + limit)).toString('base64url') : undefined;
  return { items: page, nextCursor: next };
}

const matchesSearch = (text: string[], s?: string) =>
  !s || text.some((t) => t.toLowerCase().includes(s.toLowerCase()));

function deviceOf(robotId: string): DeviceRuntime {
  const d = devices.get(robotId);
  if (!d) throw new HttpError('NOT_FOUND', `Robô ${robotId} não encontrado.`);
  return d;
}
const robotOf = (id: string): Robot => {
  const r = robots.find((x) => x.id === id);
  if (!r) throw new HttpError('NOT_FOUND', `Robô ${id} não encontrado.`);
  return r;
};
const missionOf = (id: string) => {
  const m = missions.find((x) => x.id === id);
  const i = internal.get(id);
  if (!m || !i) throw new HttpError('NOT_FOUND', `Missão ${id} não encontrada.`);
  return { m, i };
};
const mapOf = (robotId: string): RobotMap => {
  const d = deviceOf(robotId);
  return maps.find((m) => m.id === d.record.mapId && m.version === d.record.mapVersion)!;
};
const activeMissionOf = (robotId: string) =>
  [...internal.entries()].find(([, i]) => i.deviceId === robotId && ACTIVE_STATES.includes(i.state));

function setState(id: string, to: MissionState) {
  const { m, i } = missionOf(id);
  if (i.state === to) return;
  if (!canTransition(i.state, to)) {
    throw new HttpError('CONFLICT_STATE', `Transição inválida: ${i.state} -> ${to}.`);
  }
  i.state = to;
  i.updatedAt = nowIso();
  m.status = publicMissionStatus(to);
  const route = routes.get(i.deviceId);
  if (route && route.missionId === id) {
    route.state = to;
    route.status =
      to === 'completed' ? 'completed' : to === 'aborted' || to === 'failed' ? 'cancelled' : to === 'running' || to === 'blocked' || to === 'paused' ? 'running' : 'queued';
  }
  if (['completed', 'aborted', 'failed'].includes(to)) {
    m.endedAt = nowIso();
    m.durationSeconds = to === 'completed' ? Math.max(1, Math.round((Date.now() - Date.parse(m.startedAt)) / 1000)) : m.durationSeconds;
    syncRobot(i.deviceId);
  }
}

function syncRobot(robotId: string) {
  const r = robotOf(robotId);
  const active = activeMissionOf(robotId);
  const dev = deviceOf(robotId);
  r.currentMissionId = active?.[0];
  // Enquanto o dispositivo não abriu sessão neste processo, vale o status do seed.
  if (dev.sessionId) {
    if (dev.lastSeenAt) r.lastSeenAt = dev.lastSeenAt;
    if (!dev.lastSeenAt || Date.now() - Date.parse(dev.lastSeenAt) > 90_000) r.status = 'offline';
    else r.status = active ? 'busy' : 'online';
  }
  r.activeAlertsCount = alerts.filter((a) => a.robotId === robotId && !a.acknowledged).length;
}

function logEvent(missionId: string | undefined, robotId: string, e: Omit<LogEvent, 'id' | 'missionId' | 'robotId' | 'timestamp'>) {
  const ev = {
    id: `evt-mock-${counters.event++}`,
    robotId,
    timestamp: nowIso(),
    ...e,
    ...(missionId ? { missionId } : {}),
  };
  if (missionId) {
    events.push(ev as LogEvent);
    const m = missions.find((x) => x.id === missionId);
    if (m) m.eventCount += 1;
  } else {
    deviceEvents.push(ev as LogEvent);
  }
  return ev;
}

// --------------------------------------------------------------- comandos
function newCommand(type: DeviceCommandType, missionId: string, deviceId: string, extra: Partial<DeviceCommand> = {}) {
  const id = `cmd-${String(counters.command++).padStart(4, '0')}`;
  const created = Date.now();
  const cmd: DeviceCommand = {
    id,
    type,
    missionId,
    deviceId,
    status: 'pending',
    attempts: 0,
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(created + COMMAND_TTL_MS).toISOString(),
    ...extra,
  };
  const sid = devices.get(deviceId)?.sessionId;
  if (sid) cmd.sessionId = sid;
  commands.set(id, cmd);
  return cmd;
}

function toMessage(cmd: DeviceCommand, dev: DeviceRuntime): DeviceCommandMessage {
  const i = internal.get(cmd.missionId)!;
  const base = {
    v: 1 as const,
    messageId: cmd.id,
    deviceId: cmd.deviceId,
    sessionId: dev.sessionId!,
    missionId: cmd.missionId,
    validForMs: Math.max(1, Date.parse(cmd.expiresAt) - Date.now()),
  };
  switch (cmd.type) {
    case 'load_route':
      return { ...base, type: 'load_route', routeRevision: i.routeRevision, actions: i.actions, expectedNodes: i.expectedNodes, startNode: i.startNode, initialHeading: i.initialHeading };
    case 'start':
      return { ...base, type: 'start', routeRevision: i.routeRevision };
    case 'resume':
      return { ...base, type: 'resume', routeRevision: i.routeRevision, blockId: cmd.blockId! };
    case 'stop':
      return { ...base, type: 'stop' };
    case 'abort':
      return { ...base, type: 'abort' };
  }
}

function expireCommands() {
  for (const c of commands.values()) {
    if (c.status === 'pending' && Date.parse(c.expiresAt) < Date.now()) {
      c.status = c.type === 'stop' || c.type === 'abort' ? 'uncertain' : 'expired';
      c.resolvedAt = nowIso();
      if (c.type === 'load_route') {
        const i = internal.get(c.missionId);
        if (i && canTransition(i.state, 'failed')) setState(c.missionId, 'failed');
      }
    }
  }
}

function resolveCommand(replyTo: string, accepted: boolean, reason?: string) {
  const cmd = commands.get(replyTo);
  if (!cmd || cmd.status !== 'pending') return cmd;
  cmd.status = accepted ? 'accepted' : 'rejected';
  if (reason) cmd.reason = reason;
  cmd.resolvedAt = nowIso();
  const i = internal.get(cmd.missionId);
  if (!i) return cmd;
  try {
    if (accepted) {
      if (cmd.type === 'load_route') setState(cmd.missionId, 'ready');
      else if (cmd.type === 'start') setState(cmd.missionId, 'running');
      else if (cmd.type === 'resume') {
        i.blockId = null;
        i.blockReasons = [];
        setState(cmd.missionId, 'running');
      } else if (cmd.type === 'stop') setState(cmd.missionId, 'paused');
      else if (cmd.type === 'abort') setState(cmd.missionId, 'aborted');
    } else if (cmd.type === 'load_route') {
      setState(cmd.missionId, 'failed');
    }
  } catch {
    /* transição já aplicada por outro caminho */
  }
  return cmd;
}

// ------------------------------------------------------------ idempotência
function withIdempotency(
  req: IncomingMessage,
  path: string,
  rawBody: string,
  endpoint: Endpoint,
  run: () => { status: number; body: unknown }
) {
  const key = req.headers['idempotency-key'];
  const k = Array.isArray(key) ? key[0] : key;
  if (!k) {
    if (endpoint.idempotency === 'required') {
      throw new HttpError('IDEMPOTENCY_KEY_REQUIRED', 'Cabeçalho Idempotency-Key é obrigatório.');
    }
    return run();
  }
  const id = `${req.method} ${path}|${k}`;
  const hash = createHash('sha256').update(rawBody).digest('hex');
  const prev = idempotency.get(id);
  if (prev) {
    if (prev.hash !== hash) {
      throw new HttpError('CONFLICT_IDEMPOTENCY', 'A mesma Idempotency-Key foi usada com outro corpo.');
    }
    return { status: prev.status, body: prev.body };
  }
  const out = run();
  idempotency.set(id, { hash, ...out });
  return out;
}

// ---------------------------------------------------------------- handlers
type Ctx = {
  params: Record<string, string>;
  q: Record<string, string>;
  body: any;
  req: IncomingMessage;
  path: string;
  raw: string;
  endpoint: Endpoint;
};
type Result = { status?: number; body: unknown };

const labelOf = (map: RobotMap, p: { x: number; y: number }) =>
  map.points?.find((q) => q.x === p.x && q.y === p.y && q.kind === 'station')?.label ?? nodeId(p);

function missionsFor(q: Record<string, string>) {
  const range = periodRange(q);
  return missions
    .filter((m) => !q.robotId || m.robotId === q.robotId)
    .filter((m) => inRange(m.startedAt, range))
    .filter((m) => !q.status || q.status === 'all' || m.status === q.status)
    .filter((m) => !q.origin || m.origin === q.origin)
    .filter((m) => !q.destination || m.destination === q.destination)
    .filter((m) => matchesSearch([m.id, m.origin, m.destination, m.robotId], q.search))
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}

const handlers: Record<string, (c: Ctx) => Result> = {
  health: () => ({ body: ok({ status: 'ok', version: '1.0.0-mock', robotsConnected: robots.filter((r) => r.status !== 'offline').length }) }),

  listRobots: () => {
    robots.forEach((r) => syncRobot(r.id));
    return { body: ok(robots) };
  },
  getRobot: ({ params }) => {
    syncRobot(params.id!);
    return { body: ok(robotOf(params.id!)) };
  },

  dashboardMetrics: ({ q }) => {
    const range = periodRange(q);
    const ms = missionsFor({ ...q, status: 'all' } as Record<string, string>);
    const ids = new Set(ms.map((m) => m.id));
    const es = events.filter((e) => (!q.robotId || e.robotId === q.robotId) && inRange(e.timestamp, range));
    const as = alerts.filter((a) => (!q.robotId || a.robotId === q.robotId) && inRange(a.timestamp, range));
    void ids;
    return { body: ok(aggregateMetrics(ms, es, as)) };
  },
  fleetMetrics: ({ q }) => {
    const range = periodRange(q);
    const ms = missionsFor({ ...q, status: 'all' } as Record<string, string>);
    robots.forEach((r) => syncRobot(r.id));
    return {
      body: ok(
        aggregateFleetMetrics(
          robots,
          ms,
          events.filter((e) => inRange(e.timestamp, range)),
          alerts.filter((a) => inRange(a.timestamp, range))
        )
      ),
    };
  },

  listMissions: ({ q }) => {
    const { items, nextCursor } = paginate(missionsFor(q), q);
    return { body: ok(items.map(({ events: _e, ...m }) => m), nextCursor ? { nextCursor } : {}) };
  },
  getMission: ({ params }) => {
    const { m } = missionOf(params.id!);
    return { body: ok({ ...m, events: events.filter((e) => e.missionId === m.id).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)) }) };
  },

  listLogs: ({ q }) => {
    const range = periodRange(q);
    const list = events
      .filter((e) => !q.robotId || e.robotId === q.robotId)
      .filter((e) => !q.missionId || q.missionId === 'all' || e.missionId === q.missionId)
      .filter((e) => !q.eventType || q.eventType === 'all' || e.eventType === q.eventType)
      .filter((e) => !q.severity || q.severity === 'all' || e.severity === q.severity)
      .filter((e) => inRange(e.timestamp, range))
      .filter((e) => matchesSearch([e.message, e.command ?? '', e.id], q.search))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const { items, nextCursor } = paginate(list, q);
    return { body: ok(items, nextCursor ? { nextCursor } : {}) };
  },
  importLogs: ({ body, raw }) => {
    if (Buffer.byteLength(raw) > LIMITS.importMaxBodyBytes || body.events.length > LIMITS.importMaxEvents) {
      throw new HttpError('PAYLOAD_TOO_LARGE', `Lote acima do limite de ${LIMITS.importMaxEvents} eventos.`);
    }
    let imported = 0;
    let ignored = 0;
    const known = new Set(events.map((e) => e.id));
    for (const e of body.events as LogEvent[]) {
      if (known.has(e.id)) {
        ignored++;
        continue;
      }
      known.add(e.id);
      events.push(e);
      imported++;
    }
    // Importação NUNCA cria comando nem altera missão ativa.
    return { status: 200, body: ok({ importedCount: imported, ignoredCount: ignored }) };
  },

  listAlerts: ({ q }) => {
    const list = alerts
      .filter((a) => !q.robotId || a.robotId === q.robotId)
      .filter((a) => !q.severity || q.severity === 'all' || a.severity === q.severity)
      .filter((a) => !q.missionId || q.missionId === 'all' || a.missionId === q.missionId)
      .filter((a) => !q.status || q.status === 'all' || (q.status === 'acknowledged') === a.acknowledged)
      .filter((a) => matchesSearch([a.title, a.description], q.search))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const { items, nextCursor } = paginate(list, q);
    return { body: ok(items, nextCursor ? { nextCursor } : {}) };
  },
  acknowledgeAlert: ({ params }) => {
    const a = alerts.find((x) => x.id === params.id);
    if (!a) throw new HttpError('NOT_FOUND', `Alerta ${params.id} não encontrado.`);
    a.acknowledged = true;
    a.acknowledgedAt ??= nowIso();
    if (a.robotId) syncRobot(a.robotId);
    return { body: ok({ id: a.id, acknowledged: true, acknowledgedAt: a.acknowledgedAt }) };
  },
  getRobotEvents: ({ params, q }) => {
    robotOf(params.id!);
    const range = periodRange(q);
    const all = [...events, ...deviceEvents].filter((e) => e.robotId === params.id);
    const list = all
      .filter((e) => !q.severity || q.severity === 'all' || e.severity === q.severity)
      .filter((e) => !q.eventType || q.eventType === 'all' || e.eventType === q.eventType)
      .filter((e) => inRange(e.timestamp, range))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    const { items, nextCursor } = paginate(list, q);
    return { body: ok(items, nextCursor ? { nextCursor } : {}) };
  },

  getGrid: ({ params }) => {
    robotOf(params.id!);
    const { cols, rows, points } = mapOf(params.id!);
    return { body: ok({ cols, rows, points }) };
  },
  getRoute: ({ params }) => {
    robotOf(params.id!);
    const r = routes.get(params.id!);
    if (!r) throw new HttpError('NOT_FOUND', 'Este robô não tem rota definida.');
    return { body: ok(r) };
  },

  previewRoute: ({ params, body }) => {
    const robot = robotOf(params.id!);
    const dev = deviceOf(robot.id);
    const heading = (body.initialHeading ?? dev.record.lastConfirmedHeading) as Heading;
    const map = mapOf(robot.id);
    if (body.mapVersion && body.mapVersion !== map.version) {
      throw new HttpError('ROUTE_INVALID', `Versão de mapa ${body.mapVersion} incompatível (atual: ${map.version}).`);
    }
    const t = translateRoute(map, body.waypoints, heading, dev.capabilities ?? dev.record.capabilities);
    return {
      body: ok({
        robotId: robot.id,
        mapId: map.id,
        mapVersion: map.version,
        waypoints: body.waypoints,
        actions: t.actions,
        expectedNodes: t.expectedNodes,
        initialHeading: t.initialHeading,
        finalHeading: t.finalHeading,
        executable: t.executable,
        errors: t.errors,
        startMismatch: robot.currentPoint ? robot.currentPoint !== t.nodeIds[0] : undefined,
      }),
    };
  },

  submitRoute: (c) => {
    const { params, body } = c;
    const robot = robotOf(params.id!);
    return withIdempotency(c.req, c.path, c.raw, c.endpoint, () => {
      const dev = deviceOf(robot.id);
      const map = mapOf(robot.id);
      const heading = (body.initialHeading ?? dev.record.lastConfirmedHeading) as Heading;
      const count = body.waypoints.length;

      if (count < 2) {
        throw new HttpError('ROUTE_INVALID', 'A rota precisa de pelo menos dois pontos.');
      }
      const t = translateRoute(map, body.waypoints, heading, dev.record.capabilities);
      if (!t.executable) {
        const reverse = t.errors.some((e) => e.code === 'REVERSE_UNSUPPORTED');
        throw new HttpError(reverse ? 'CAPABILITY_UNSUPPORTED' : 'ROUTE_INVALID', t.errors[0]?.message ?? 'Rota inválida.', { errors: t.errors });
      }
      syncRobot(robot.id);
      if (robot.status === 'offline') {
        return { status: 200, body: ok({ routeId: '', accepted: false, waypointCount: count, message: `${robot.name} está offline e não pode receber uma rota agora.` }) };
      }
      if (robot.status === 'error') {
        return { status: 200, body: ok({ routeId: '', accepted: false, waypointCount: count, message: `${robot.name} está em falha e não pode receber uma rota agora.` }) };
      }
      if (activeMissionOf(robot.id)) {
        return { status: 200, body: ok({ routeId: '', accepted: false, waypointCount: count, message: `${robot.name} já tem uma missão ativa.` }) };
      }

      const missionId = `RF-${String(counters.mission++).padStart(4, '0')}`;
      const routeId = `RT-${String(counters.route++).padStart(4, '0')}`;
      const first = body.waypoints[0]!;
      const last = body.waypoints[count - 1]!;
      const startedAt = nowIso();
      missions.unshift({
        id: missionId,
        robotId: robot.id,
        origin: labelOf(map, first),
        destination: labelOf(map, last),
        status: 'in_progress',
        startedAt,
        durationSeconds: null,
        stopCount: 0,
        presenceStopCount: 0,
        errorCount: 0,
        eventCount: 0,
        stopReasons: [],
      });
      internal.set(missionId, {
        state: 'queued',
        deviceId: robot.id,
        routeRevision: 1,
        waypoints: body.waypoints,
        actions: t.actions,
        expectedNodes: t.expectedNodes,
        steps: t.steps,
        startNode: t.nodeIds[0]!,
        initialHeading: heading,
        completedActions: 0,
        blockId: null,
        blockReasons: [],
        routeId,
        sessionId: dev.sessionId,
        updatedAt: startedAt,
      });
      routes.set(robot.id, {
        routeId,
        robotId: robot.id,
        waypoints: body.waypoints,
        createdAt: startedAt,
        status: 'queued',
        currentWaypointIndex: null,
        missionId,
        state: 'queued',
        initialHeading: heading,
        actions: t.actions,
        mapVersion: map.version,
      });
      logEvent(missionId, robot.id, { eventType: 'mission_start', severity: 'info', roverState: 'idle', message: `Rota iniciada: ${labelOf(map, first)} → ${labelOf(map, last)}.` });
      const cmd = newCommand('load_route', missionId, robot.id);
      setState(missionId, 'loading');
      return { status: 201, body: ok({ routeId, accepted: true, waypointCount: count, message: 'Rota aceita e enfileirada no robô.', missionId, commandId: cmd.id, actions: t.actions }) };
    });
  },

  startMission: (c) => control(c, 'start'),
  stopMission: (c) => control(c, 'stop'),
  resumeMission: (c) => control(c, 'resume'),
  abortMission: (c) => control(c, 'abort'),

  confirmPosition: ({ params, body }) => {
    const robot = robotOf(params.id!);
    const dev = deviceOf(robot.id);
    if (activeMissionOf(robot.id)) {
      throw new HttpError('DEVICE_BUSY', 'O robô tem missão ativa; não é possível reposicioná-lo.');
    }
    const map = mapOf(robot.id);
    const p = { x: body.x as number, y: body.y as number };
    if (!isInsideGrid(p, map) || blockedSet(map).has(nodeId(p))) {
      throw new HttpError('ROUTE_INVALID', `(${p.x}, ${p.y}) está fora da malha ou bloqueado.`);
    }
    robot.currentPoint = nodeId(p);
    dev.record.lastConfirmedHeading = body.heading as Heading;
    return { body: ok({ currentPoint: nodeId(p), heading: body.heading, positionConfidence: 'confirmed' }) };
  },

  forceCloseMission: ({ params }) => {
    const { m, i } = missionOf(params.id!);
    if (i.state !== 'uncertain') {
      throw new HttpError('CONFLICT_STATE', 'Só missões com estado incerto podem ser encerradas à força.');
    }
    setState(params.id!, 'aborted');
    // Sem confirmação do dispositivo: não inventa endedAt nem duração.
    delete m.endedAt;
    m.durationSeconds = null;
    for (const c of commands.values()) {
      if (c.missionId === params.id && c.status === 'pending') {
        c.status = 'expired';
        c.reason = 'FORCE_CLOSED';
        c.resolvedAt = nowIso();
      }
    }
    logEvent(params.id, i.deviceId, {
      eventType: 'mission_end',
      severity: 'warning',
      roverState: 'unknown',
      message: 'Missão encerrada manualmente SEM confirmação do dispositivo. Reposicione o robô antes da próxima rota.',
    });
    return { body: ok({ missionId: params.id!, state: 'aborted' }) };
  },

  getCommand: ({ params }) => {
    expireCommands();
    const c = commands.get(params.id!);
    if (!c) throw new HttpError('NOT_FOUND', `Comando ${params.id} não encontrado.`);
    const { messageBody: _m, ...pub } = c;
    return { body: ok(pub) };
  },

  getExecution: ({ params }) => {
    expireCommands();
    const { i } = missionOf(params.id!);
    const dev = deviceOf(i.deviceId);
    const terminal = ['completed', 'aborted', 'failed'].includes(i.state);
    const total = i.actions.length;
    const last = i.completedActions === 0 ? i.startNode : i.expectedNodes[i.completedActions - 1] ?? null;
    const step = i.completedActions > 0 ? i.steps[i.completedActions - 1] : undefined;
    return {
      body: ok({
        missionId: params.id!,
        deviceId: i.deviceId,
        sessionId: dev.sessionId,
        state: i.state,
        actionIndex: terminal && i.completedActions >= total ? null : Math.min(i.completedActions, Math.max(total - 1, 0)),
        completedActions: i.completedActions,
        totalActions: total,
        lastConfirmedNode: last,
        expectedNode: terminal ? null : i.expectedNodes[i.completedActions] ?? null,
        atNode: !['running', 'blocked', 'paused'].includes(i.state),
        positionConfidence: i.state === 'uncertain' ? 'unknown' : ['running', 'blocked', 'paused'].includes(i.state) ? 'estimated' : 'confirmed',
        headingAtLastConfirmedNode: step ? step.headingAfter : i.initialHeading,
        blockId: i.blockId,
        blockReasons: i.blockReasons,
        pendingCommands: [...commands.values()].filter((x) => x.missionId === params.id && x.status === 'pending').map(({ messageBody: _m, ...p }) => p),
        updatedAt: i.updatedAt,
      }),
    };
  },

  getDeviceStatus: ({ params }) => {
    const dev = deviceOf(params.id!);
    const active = activeMissionOf(dev.record.id);
    const age = dev.lastSeenAt ? Date.now() - Date.parse(dev.lastSeenAt) : null;
    return {
      body: ok({
        deviceId: dev.record.id,
        robotId: dev.record.robotId,
        connection: age === null || age > 90_000 ? 'offline' : age > 10_000 ? 'stale' : 'online',
        sessionId: dev.sessionId,
        firmwareVersion: dev.firmwareVersion,
        protocolVersion: 1,
        capabilities: dev.capabilities,
        state: dev.state,
        activeMissionId: active?.[0] ?? null,
        sensors: dev.sensors,
        blockId: dev.blockId,
        blockReasons: dev.blockReasons,
        lastSeenAt: dev.lastSeenAt,
        dataAgeMs: age,
        nextPollMs: dev.sessionId ? (active ? POLL_MS.activeMission : POLL_MS.idle) : null,
      }),
    };
  },
};

function control({ params, body, req, path, raw, endpoint }: Ctx, type: DeviceCommandType): Result {
  return withIdempotency(req, path, raw, endpoint, () => {
    expireCommands();
    const { i } = missionOf(params.id!);
    const dev = deviceOf(i.deviceId);
    if (body.sessionId && dev.sessionId && body.sessionId !== dev.sessionId) {
      throw new HttpError('CONFLICT_SESSION', 'A sessão do dispositivo mudou; recarregue o estado.');
    }
    const allowed: Record<string, MissionState[]> = {
      start: ['ready'],
      stop: ['running', 'blocked'],
      resume: ['blocked', 'paused'],
      abort: ['ready', 'running', 'blocked', 'paused', 'uncertain', 'queued', 'loading'],
    };
    if (!allowed[type]!.includes(i.state)) {
      throw new HttpError('CONFLICT_STATE', `Não é possível ${type} uma missão em estado ${i.state}.`);
    }
    if (
      (type === 'start' || type === 'resume') &&
      [...commands.values()].some((c) => c.missionId === params.id && c.type === type && c.status === 'pending')
    ) {
      throw new HttpError('CONFLICT_STATE', `Já existe um ${type} pendente para esta missão.`);
    }
    if ((type === 'start' || type === 'resume') && !dev.sessionId) {
      throw new HttpError('DEVICE_UNAVAILABLE', 'Dispositivo sem conexão. Start/resume exigem conexão.');
    }
    if (type === 'resume' && i.state === 'blocked' && body.blockId !== i.blockId) {
      throw new HttpError('STALE_BLOCK', 'O bloqueio informado não é o atual.');
    }
    const cmd = newCommand(type, params.id!, i.deviceId, type === 'resume' ? { blockId: body.blockId } : {});
    if (body.reason) cmd.reason = body.reason;
    // stop/abort sem conexão: intenção registrada, resultado incerto (nunca "parado").
    if ((type === 'stop' || type === 'abort') && !dev.sessionId) cmd.status = 'uncertain';
    return { status: 202, body: ok({ commandId: cmd.id, missionId: params.id!, status: 'pending' }) };
  });
}

// ------------------------------------------------------------- dispositivo
const syncResponse = (dev: DeviceRuntime, extra: Record<string, unknown> = {}) => {
  const active = activeMissionOf(dev.record.id);
  return {
    sessionId: dev.sessionId!,
    serverTime: nowIso(),
    nextPollMs: active ? POLL_MS.activeMission : POLL_MS.idle,
    ackedSequence: dev.ackedSequence,
    commands: [] as DeviceCommandMessage[],
    resync: false,
    ...extra,
  };
};

function deliverCommands(dev: DeviceRuntime): DeviceCommandMessage[] {
  expireCommands();
  const out: DeviceCommandMessage[] = [];
  for (const c of commands.values()) {
    if (c.deviceId !== dev.record.id || c.status !== 'pending') continue;
    c.sessionId ??= dev.sessionId!;
    if (c.sessionId !== dev.sessionId) continue;
    c.attempts += 1;
    c.deliveredAt ??= nowIso();
    out.push(toMessage(c, dev));
  }
  return out;
}

/** `ackedSequence` = maior sequência de evento CRÍTICO processada (não contígua). */
function ackCritical(dev: DeviceRuntime, type: string, sequence: number) {
  if (isCriticalEvent(type)) dev.ackedSequence = Math.max(dev.ackedSequence, sequence);
}

function applyDeviceEvent(dev: DeviceRuntime, e: DeviceEventMessage): { resync?: boolean } {
  const robotId = dev.record.robotId;
  const robot = robotOf(robotId);
  let resync = false;
  let missionId: string | undefined = 'missionId' in e ? e.missionId : undefined;
  const ctx: { ackedCommandType?: DeviceCommandType; totalActions?: number } = {};

  if (e.type === 'ack' || e.type === 'reject') {
    const cmd = commands.get(e.replyTo);
    if (cmd) {
      ctx.ackedCommandType = cmd.type;
      missionId ??= cmd.missionId;
      resolveCommand(e.replyTo, e.type === 'ack', e.type === 'reject' ? e.reason : undefined);
    }
  }

  const i = missionId ? internal.get(missionId) : undefined;
  if (i) ctx.totalActions = i.actions.length;

  switch (e.type) {
    case 'telemetry':
      dev.state = e.state;
      dev.sensors = { line: e.line, distanceCm: e.distanceCm, distanceValid: e.distanceValid, distanceAgeMs: e.distanceAgeMs };
      robot.roverState = deviceStateToRoverState(e.state, e.blockReasons);
      return {};
    case 'action_completed': {
      if (!i || !missionId || i.state !== 'running') break;
      if (e.actionIndex < i.completedActions) break; // duplicata: não altera posição
      if (e.actionIndex > i.completedActions || e.expectedNode !== i.expectedNodes[e.actionIndex]) {
        resync = true; // salto de índice: reconciliar, nunca presumir conclusão
        setState(missionId, 'uncertain');
        break;
      }
      i.completedActions += 1;
      i.updatedAt = nowIso();
      robot.currentPoint = e.expectedNode;
      const route = routes.get(robotId);
      if (route?.missionId === missionId) route.currentWaypointIndex = i.completedActions;
      break;
    }
    case 'mission_completed':
      if (i && missionId && i.state === 'running' && e.completedActions === i.actions.length) {
        i.completedActions = e.completedActions;
        setState(missionId, 'completed');
      }
      break;
    case 'block_started':
      if (i && missionId && i.state === 'running') {
        i.blockId = e.blockId;
        i.blockReasons = e.reasons;
        dev.blockId = e.blockId;
        dev.blockReasons = e.reasons;
        const m = missions.find((x) => x.id === missionId)!;
        m.stopCount += 1;
        if (e.reasons.includes('obstacle')) m.presenceStopCount += 1;
        const reason = e.reasons.includes('obstacle') ? 'Presença detectada' : 'Outro motivo';
        const r = m.stopReasons.find((x) => x.reason === reason);
        if (r) r.count += 1;
        else m.stopReasons.push({ reason, count: 1 });
        setState(missionId, 'blocked');
      }
      break;
    case 'block_cleared':
      dev.blockId = null;
      dev.blockReasons = [];
      break;
    case 'fault': {
      if (i && missionId) missions.find((x) => x.id === missionId)!.errorCount += e.severity === 'warning' ? 0 : 1;
      if (e.severity !== 'warning') {
        alerts.unshift({ id: `alt-mock-${counters.alert++}`, title: `Falha: ${e.code}`, description: e.message, severity: e.severity, timestamp: nowIso(), ...(missionId ? { missionId } : {}), robotId, occurrenceCount: 1, acknowledged: false, relatedEventIds: [] });
      }
      break;
    }
    case 'snapshot':
      dev.state = e.state;
      break;
    default:
      break;
  }

  for (const p of projectDeviceEvent(e, ctx)) {
    logEvent(missionId, robotId, { eventType: p.eventType, severity: p.severity, roverState: p.roverState, ...(p.command ? { command: p.command } : {}), message: p.message, ...(p.payload ? { payload: p.payload } : {}) });
  }
  return { resync };
}

function authDevice(req: IncomingMessage, path: string, raw: string, isHello: boolean) {
  const id = String(req.headers['x-device-id'] ?? '');
  const dev = devices.get(id);
  if (!dev) throw new HttpError('SIGNATURE_INVALID', 'Dispositivo desconhecido.');
  const sessionHeader = String(req.headers['x-session-id'] ?? '');
  const r = verifyRequest({
    method: req.method ?? 'GET',
    path,
    headers: req.headers,
    body: raw,
    secret: DEVICE_SECRET,
    nowSeconds: Math.floor(Date.now() / 1000),
    lastAcceptedSequence: sessionHeader === dev.sessionId ? dev.lastRequestSequence : undefined,
  });
  if (!r.ok) throw new HttpError(r.error, r.message);
  if (!isHello && sessionHeader !== dev.sessionId) {
    throw new HttpError('CONFLICT_SESSION', 'Sessão desconhecida: envie /device/hello após o boot.');
  }
  dev.lastRequestSequence = r.sequence;
  dev.lastSeenAt = nowIso();
  return dev;
}

function deviceHello(dev: DeviceRuntime, body: any, sessionId: string): Result {
  const newSession = dev.sessionId !== sessionId;
  dev.sessionId = sessionId;
  dev.firmwareVersion = body.firmwareVersion;
  dev.capabilities = body.capabilities;
  dev.state = body.state;
  if (newSession) {
    dev.seenSequences = new Set();
    dev.ackedSequence = 0;
    dev.lastRequestSequence = Number(1);
  }
  dev.seenSequences.add(body.sequence);
  ackCritical(dev, 'hello', body.sequence);
  // Reboot: movimento nunca é retomado sozinho (ADR 0002).
  let reconcile = false;
  for (const [id, i] of internal) {
    if (i.deviceId !== dev.record.id || !ACTIVE_STATES.includes(i.state)) continue;
    if (['running', 'blocked', 'paused'].includes(i.state)) {
      setState(id, 'uncertain');
      reconcile = true;
    } else if (i.state === 'uncertain') {
      reconcile = true;
    } else if (i.state === 'ready') {
      setState(id, 'failed');
    }
    // `loading`: o comando load_route segue pendente e será entregue na nova sessão.
    for (const c of commands.values()) if (c.missionId === id && c.status === 'pending') c.sessionId = sessionId;
  }
  syncRobot(dev.record.id);
  return {
    body: ok({
      ...syncResponse(dev),
      accepted: true,
      reconcileRequired: reconcile,
      limits: DEFAULT_CAPABILITIES,
    }),
  };
}

// ---------------------------------------------------------------- servidor
function readBody(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError('PAYLOAD_TOO_LARGE', 'Corpo acima do limite.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
    res.setHeader('Access-Control-Max-Age', '600');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  cors(req, res);
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;
  const pathWithQuery = url.pathname + url.search;

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const found = matchEndpoint(req.method ?? 'GET', pathname);
  if (!found) throw new HttpError('NOT_FOUND', `Rota não prevista: ${req.method} ${pathname}`);
  const { endpoint, params } = found;

  const isDevice = endpoint.auth === 'device';
  const maxBody = isDevice ? LIMITS.deviceBodyMaxBytes : LIMITS.importMaxBodyBytes + 1024;
  let raw = '';
  if (req.method !== 'GET') {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > maxBody) throw new HttpError('PAYLOAD_TOO_LARGE', 'Corpo acima do limite.');
    raw = await readBody(req, maxBody);
  }

  // ---- autenticação
  let dev: DeviceRuntime | undefined;
  if (endpoint.auth === 'operator' && !NO_AUTH) {
    const h = String(req.headers.authorization ?? '');
    const role = TOKENS[h.replace(/^Bearer\s+/i, '')];
    if (!h || !role) throw new HttpError('UNAUTHENTICATED', 'Token ausente ou inválido.');
    if (!(endpoint.roles ?? []).includes(role)) {
      throw new HttpError('FORBIDDEN', 'Seu papel não permite esta operação.');
    }
  } else if (endpoint.auth === 'internal') {
    if (req.headers.authorization !== `Bearer ${INTERNAL_TOKEN}`) {
      throw new HttpError('UNAUTHENTICATED', 'Chamada interna sem credencial válida.');
    }
  } else if (isDevice) {
    dev = authDevice(req, pathWithQuery, raw, endpoint.id === 'deviceHello');
  }

  // ---- validação de entrada
  const q: Record<string, string> = Object.fromEntries(url.searchParams);
  if (endpoint.query) {
    const r = endpoint.query.safeParse(q);
    if (!r.success) throw new HttpError('INVALID_QUERY', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  let body: unknown;
  if (endpoint.body) {
    let json: unknown = {};
    try {
      json = raw ? JSON.parse(raw) : {};
    } catch {
      throw new HttpError('INVALID_BODY', 'Corpo não é JSON válido.');
    }
    const r = endpoint.body.safeParse(json);
    if (!r.success) throw new HttpError('INVALID_BODY', r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    body = r.data;
  }

  // ---- despacho
  let result: Result;
  if (endpoint.id === 'deviceHello') {
    result = deviceHello(dev!, body, String(req.headers['x-session-id']));
  } else if (endpoint.id === 'devicePoll') {
    result = { body: ok(syncResponse(dev!, { commands: deliverCommands(dev!) })) };
  } else if (endpoint.id === 'deviceEvents') {
    let resync = false;
    const rejected: Array<{ sequence: number; reason: string }> = [];
    for (const raw of (body as { events: unknown[] }).events) {
      const ev = DeviceEventMessageSchema.parse(raw);
      if (ev.sessionId !== dev!.sessionId || ev.deviceId !== dev!.record.id) {
        rejected.push({ sequence: ev.sequence, reason: 'sessão ou dispositivo não confere' });
        continue;
      }
      void deviceEventDocId(ev.deviceId, ev.sessionId, ev.sequence);
      if (dev!.seenSequences.has(ev.sequence)) {
        ackCritical(dev!, ev.type, ev.sequence);
        continue; // dedupe: create() falharia
      }
      dev!.seenSequences.add(ev.sequence);
      if (applyDeviceEvent(dev!, ev).resync) resync = true;
      ackCritical(dev!, ev.type, ev.sequence);
    }
    result = { body: ok(syncResponse(dev!, { resync, rejected, commands: deliverCommands(dev!) })) };
  } else if (endpoint.id === 'internalEvents') {
    result = { body: ok({ processed: true }) };
  } else if (endpoint.id === 'internalOfflineCheck') {
    let marked = 0;
    for (const d of devices.values()) {
      const r = robotOf(d.record.robotId);
      const stale = !d.lastSeenAt || Date.now() - Date.parse(d.lastSeenAt) > 90_000;
      if (stale && r.status !== 'offline') {
        r.status = 'offline';
        marked++;
      }
    }
    result = { body: ok({ checked: devices.size, markedOffline: marked }) };
  } else {
    const h = handlers[endpoint.id];
    if (!h) throw new HttpError('NOT_IMPLEMENTED', `Endpoint sem handler no mock: ${endpoint.id}`);
    result = h({ params, q, body, req, path: pathname, raw, endpoint });
  }

  send(res, result.status ?? endpoint.okStatus[0] ?? 200, result.body);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    if (err instanceof HttpError) {
      send(res, err.status, buildError(err.code, err.message, err.details));
    } else {
      console.error(err);
      send(res, 500, buildError('INTERNAL', 'Erro interno do servidor mock.'));
    }
  });
});

if (process.env.MOCK_NO_LISTEN !== '1') {
  server.listen(PORT, () => {
    console.log(`Mock RoboFlow em http://localhost:${PORT}  (operador: Bearer ${Object.keys(TOKENS)[0]}${NO_AUTH ? ', auth DESLIGADA' : ''})`);
  });
}

export { server, PORT };
void parseNodeId;
