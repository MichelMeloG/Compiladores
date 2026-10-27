import type {
  ActiveRoute,
  AckResult,
  Alert,
  AlertsQuery,
  DeviceCommand,
  DeviceStatus,
  ExecutionState,
  Health,
  ImportResult,
  LogEvent,
  LogsQuery,
  Mission,
  MissionsQuery,
  Robot,
  RobotGrid,
} from '@roboflow/contracts';
import { LIMITS, deviceStateToRoverState } from '@roboflow/contracts';
import { AppError, notFound } from '../errors.js';
import type { AlertDoc, CommandDoc, EventDoc, MapDoc, MissionDoc, RobotDoc, RouteDoc } from '../domain/types.js';
import { C, isValidDocId, type Doc, type Filter, type Query, type Store } from '../store/types.js';
import { decodeCursor, encodeCursor, isOnline, iso, type Deps } from './common.js';
import { loadMap } from './maps.js';
import { unackedByRobot, resolveRange } from './metrics.js';
import { toPublicCommand } from './operator.js';
import {
  executionState,
  publicAlert,
  publicEvent,
  publicMission,
  publicRobot,
  publicRobotEvent,
} from './projection.js';
import { pollInterval } from './device.js';

// ---------------------------------------------------------------------------
// Paginação com pós-filtro (campos sem índice)
// ---------------------------------------------------------------------------

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

const MAX_SCAN = 500;

/**
 * Lê uma página aplicando filtros em memória (busca textual, severidade...)
 * sobre no máximo `MAX_SCAN` documentos: o custo de leitura é limitado mesmo
 * quando o filtro é seletivo.
 */
export async function pagedQuery<T extends Doc>(
  store: Store,
  collection: Parameters<Store['query']>[0],
  base: Query,
  opts: { limit: number; cursor?: string | undefined; post?: (d: T) => boolean },
): Promise<Page<T>> {
  const field = base.orderBy?.field ?? 'id';
  const valueOf = (d: T) => (d as Record<string, unknown>)[field];
  let cursor = decodeCursor(opts.cursor);
  const items: T[] = [];
  let scanned = 0;
  let tail: T | undefined;
  let more = false;

  while (items.length < opts.limit && scanned < MAX_SCAN) {
    const batchSize = opts.post ? Math.min(200, MAX_SCAN - scanned) : opts.limit + 1 - items.length;
    const q: Query = { ...base, limit: batchSize };
    if (cursor) q.startAfter = { value: cursor.value, id: cursor.id };
    const docs = await store.query<T>(collection, q);

    let broke = -1;
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i] as T;
      scanned += 1;
      tail = d;
      if (!opts.post || opts.post(d)) {
        items.push(d);
        if (items.length >= opts.limit) {
          broke = i;
          break;
        }
      }
    }
    if (broke >= 0) {
      // Parou por ter enchido a página: há mais se sobrou doc no lote ou o lote veio cheio.
      more = broke < docs.length - 1 || docs.length === batchSize;
      break;
    }
    if (docs.length < batchSize) {
      more = false; // fim da coleção
      break;
    }
    more = true; // lote cheio sem completar a página: pode haver mais
    const last = docs[docs.length - 1] as T;
    cursor = { value: valueOf(last), id: last.id };
  }

  const page: Page<T> = { items: items.slice(0, opts.limit) };
  if (more && tail) page.nextCursor = encodeCursor(valueOf(tail), tail.id);
  return page;
}

const clampLimit = (n: number | undefined): number =>
  Math.min(n ?? LIMITS.listDefaultLimit, LIMITS.listMaxLimit);

const contains = (hay: string | undefined, needle: string): boolean =>
  (hay ?? '').toLowerCase().includes(needle.toLowerCase());

// ---------------------------------------------------------------------------
// Robôs
// ---------------------------------------------------------------------------

export async function listRobots(deps: Deps): Promise<Robot[]> {
  const now = deps.clock();
  const robots = await deps.store.query<RobotDoc>(C.robots, { orderBy: { field: 'id', dir: 'asc' }, limit: 200 });
  const alerts = await unackedByRobot(deps, robots.map((r) => r.id));
  return robots.map((r) => publicRobot(r, now, deps.cfg, alerts.get(r.id) ?? 0));
}

export async function getRobot(deps: Deps, id: string): Promise<Robot> {
  const r = await deps.store.get<RobotDoc>(C.robots, id);
  if (!r) throw notFound(`Robô ${id} não encontrado.`);
  const alerts = await unackedByRobot(deps, [id]);
  return publicRobot(r, deps.clock(), deps.cfg, alerts.get(id) ?? 0);
}

export async function getGrid(deps: Deps, id: string): Promise<RobotGrid> {
  const r = await deps.store.get<RobotDoc>(C.robots, id);
  if (!r) throw notFound(`Robô ${id} não encontrado.`);
  const map = await loadMap(deps, deps.store, r.mapId, r.mapVersion);
  return { cols: map.cols, rows: map.rows, ...(map.points ? { points: map.points } : {}) };
}

export async function getActiveRoute(deps: Deps, robotId: string): Promise<ActiveRoute> {
  const r = await deps.store.get<RobotDoc>(C.robots, robotId);
  if (!r) throw notFound(`Robô ${robotId} não encontrado.`);
  if (!r.currentRouteId) throw notFound('Nenhuma rota definida para este robô.');
  const route = await deps.store.get<RouteDoc>(C.routes, r.currentRouteId);
  if (!route) throw notFound('Nenhuma rota definida para este robô.');
  const m = await deps.store.get<MissionDoc>(C.missions, route.missionId);
  const state = m?.state;
  const status: ActiveRoute['status'] =
    !state || ['queued', 'loading', 'ready'].includes(state)
      ? 'queued'
      : ['running', 'blocked', 'paused', 'uncertain'].includes(state)
        ? 'running'
        : state === 'completed'
          ? 'completed'
          : 'cancelled';
  return {
    routeId: route.id,
    robotId,
    waypoints: route.waypoints,
    createdAt: route.createdAt,
    status,
    currentWaypointIndex: status === 'queued' || !m ? null : m.completedActions,
    missionId: route.missionId,
    ...(state ? { state } : {}),
    initialHeading: route.initialHeading,
    actions: route.actions,
    mapVersion: route.mapVersion,
  };
}

// ---------------------------------------------------------------------------
// Missões
// ---------------------------------------------------------------------------

export async function listMissions(deps: Deps, q: MissionsQuery): Promise<Page<Mission>> {
  const range = resolveRange(q, deps.clock());
  const filters: Filter[] = [];
  if (q.robotId) filters.push({ field: 'robotId', op: '==', value: q.robotId });
  if (q.status && q.status !== 'all') filters.push({ field: 'status', op: '==', value: q.status });
  if (range.start) filters.push({ field: 'startedAt', op: '>=', value: iso(range.start) });
  if (range.end) filters.push({ field: 'startedAt', op: '<', value: iso(range.end) });

  const needle = q.search?.trim();
  const page = await pagedQuery<MissionDoc>(
    deps.store,
    C.missions,
    { filters, orderBy: { field: 'startedAt', dir: 'desc' } },
    {
      limit: clampLimit(q.limit),
      cursor: q.cursor,
      post: (m) =>
        (!q.origin || q.origin === 'all' || m.origin === q.origin) &&
        (!q.destination || q.destination === 'all' || m.destination === q.destination) &&
        (!needle || contains(m.id, needle) || contains(m.origin, needle) || contains(m.destination, needle)),
    },
  );
  return { items: page.items.map((m) => publicMission(m)), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export async function getMission(deps: Deps, id: string): Promise<Mission> {
  const m = await deps.store.get<MissionDoc>(C.missions, id);
  if (!m) throw notFound(`Missão ${id} não encontrada.`);
  const events = await deps.store.query<EventDoc>(C.events, {
    filters: [{ field: 'missionId', op: '==', value: id }],
    orderBy: { field: 'timestamp', dir: 'asc' },
    limit: 500,
  });
  return publicMission(m, events);
}

export async function getExecution(deps: Deps, id: string): Promise<ExecutionState> {
  const m = await deps.store.get<MissionDoc>(C.missions, id);
  if (!m) throw notFound(`Missão ${id} não encontrada.`);
  const robot = await deps.store.get<RobotDoc>(C.robots, m.robotId);
  if (!robot) throw notFound(`Robô ${m.robotId} não encontrado.`);
  const pending: CommandDoc[] = [];
  for (const cid of robot.pendingCommandIds) {
    const c = await deps.store.get<CommandDoc>(C.commands, cid);
    if (c && c.missionId === id && c.status === 'pending') pending.push(c);
  }
  return executionState(m, robot, pending);
}

export async function getCommand(deps: Deps, id: string): Promise<DeviceCommand> {
  const c = await deps.store.get<CommandDoc>(C.commands, id);
  if (!c) throw notFound(`Comando ${id} não encontrado.`);
  return toPublicCommand(c);
}

export async function getDeviceStatus(deps: Deps, id: string): Promise<DeviceStatus> {
  const r = await deps.store.get<RobotDoc>(C.robots, id);
  if (!r) throw notFound(`Dispositivo ${id} não encontrado.`);
  const now = deps.clock();
  const age = r.lastSeenAt ? Math.max(0, now.getTime() - Date.parse(r.lastSeenAt)) : null;
  const online = isOnline(r, now, deps.cfg);
  const live = r.live;
  void deviceStateToRoverState;
  return {
    deviceId: r.id,
    robotId: r.id,
    connection: online ? 'online' : age !== null && age <= deps.cfg.offlineAfterMs * 4 ? 'stale' : 'offline',
    sessionId: r.sessionId,
    ...(r.firmwareVersion ? { firmwareVersion: r.firmwareVersion } : {}),
    ...(r.protocolVersion ? { protocolVersion: r.protocolVersion } : {}),
    capabilities: r.capabilities,
    state: live?.state ?? r.deviceState,
    activeMissionId: r.activeMissionId,
    sensors: live
      ? {
          line: live.line,
          distanceCm: live.distanceCm,
          distanceValid: live.distanceValid,
          distanceAgeMs: live.distanceAgeMs,
        }
      : null,
    blockId: live?.blockId ?? null,
    blockReasons: live?.blockReasons ?? [],
    lastSeenAt: r.lastSeenAt,
    dataAgeMs: age,
    nextPollMs: pollInterval(deps, r),
  };
}

// ---------------------------------------------------------------------------
// Logs e eventos
// ---------------------------------------------------------------------------

function eventFilter(
  q: { severity?: string | undefined; eventType?: string | undefined; search?: string | undefined },
): (e: EventDoc) => boolean {
  const needle = q.search?.trim();
  return (e) =>
    (!q.severity || q.severity === 'all' || e.severity === q.severity) &&
    (!q.eventType || q.eventType === 'all' || e.eventType === q.eventType) &&
    (!needle || contains(e.message, needle) || contains(e.command, needle) || contains(e.missionId ?? '', needle));
}

export async function listLogs(deps: Deps, q: LogsQuery): Promise<Page<LogEvent>> {
  const range = resolveRange(q, deps.clock());
  const filters: Filter[] = [];
  if (q.robotId) filters.push({ field: 'robotId', op: '==', value: q.robotId });
  if (q.missionId && q.missionId !== 'all') filters.push({ field: 'missionId', op: '==', value: q.missionId });
  if (range.start) filters.push({ field: 'timestamp', op: '>=', value: iso(range.start) });
  if (range.end) filters.push({ field: 'timestamp', op: '<', value: iso(range.end) });
  const page = await pagedQuery<EventDoc>(
    deps.store,
    C.events,
    { filters, orderBy: { field: 'timestamp', dir: 'desc' } },
    { limit: clampLimit(q.limit), cursor: q.cursor, post: (e) => e.missionId !== null && eventFilter(q)(e) },
  );
  return { items: page.items.map(publicEvent), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

export async function listRobotEvents(
  deps: Deps,
  robotId: string,
  q: { period?: LogsQuery['period']; startDate?: string | undefined; endDate?: string | undefined; severity?: string | undefined; eventType?: string | undefined; limit?: number | undefined; cursor?: string | undefined },
) {
  const robot = await deps.store.get<RobotDoc>(C.robots, robotId);
  if (!robot) throw notFound(`Robô ${robotId} não encontrado.`);
  const range = resolveRange(q, deps.clock());
  const filters: Filter[] = [{ field: 'robotId', op: '==', value: robotId }];
  if (range.start) filters.push({ field: 'timestamp', op: '>=', value: iso(range.start) });
  if (range.end) filters.push({ field: 'timestamp', op: '<', value: iso(range.end) });
  const page = await pagedQuery<EventDoc>(
    deps.store,
    C.events,
    { filters, orderBy: { field: 'timestamp', dir: 'desc' } },
    { limit: clampLimit(q.limit), cursor: q.cursor, post: eventFilter(q) },
  );
  return { items: page.items.map(publicRobotEvent), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

/**
 * Importa eventos históricos. Só ESCREVE documentos de evento novos:
 * nunca toca em missões, robôs ou comandos (não gera movimento).
 */
export async function importLogs(deps: Deps, events: LogEvent[]): Promise<ImportResult> {
  if (events.length > LIMITS.importMaxEvents) {
    throw new AppError('PAYLOAD_TOO_LARGE', `No máximo ${LIMITS.importMaxEvents} eventos por importação.`);
  }
  const badId = events.find((e) => !isValidDocId(e.id));
  if (badId) {
    throw new AppError('INVALID_BODY', `ID de evento inválido: "${badId.id.slice(0, 40)}" (sem "/", ".", ".." nem "__x__").`);
  }
  const docs: EventDoc[] = events.map((e) => ({
    id: e.id,
    missionId: e.missionId === 'unassigned' ? null : e.missionId,
    robotId: e.robotId,
    timestamp: e.timestamp,
    eventType: e.eventType,
    severity: e.severity,
    message: e.message,
    ...(e.command ? { command: e.command } : {}),
    ...(e.roverState ? { roverState: e.roverState } : {}),
    ...(e.payload ? { payload: e.payload } : {}),
    ...(e.raw ? { raw: e.raw } : {}),
    source: 'import' as const,
  }));
  const r = await deps.store.createManyIfAbsent(C.events, docs);
  return { importedCount: r.created, ignoredCount: r.existing };
}

// ---------------------------------------------------------------------------
// Alertas
// ---------------------------------------------------------------------------

export async function listAlerts(deps: Deps, q: AlertsQuery): Promise<Page<Alert>> {
  const filters: Filter[] = [];
  if (q.robotId) filters.push({ field: 'robotId', op: '==', value: q.robotId });
  if (q.missionId && q.missionId !== 'all') filters.push({ field: 'missionId', op: '==', value: q.missionId });
  if (q.status === 'unacknowledged') filters.push({ field: 'acknowledged', op: '==', value: false });
  if (q.status === 'acknowledged') filters.push({ field: 'acknowledged', op: '==', value: true });
  if (q.severity && q.severity !== 'all') filters.push({ field: 'severity', op: '==', value: q.severity });
  const needle = q.search?.trim();
  const page = await pagedQuery<AlertDoc>(
    deps.store,
    C.alerts,
    { filters, orderBy: { field: 'timestamp', dir: 'desc' } },
    {
      limit: clampLimit(q.limit),
      cursor: q.cursor,
      post: (a) => !needle || contains(a.title, needle) || contains(a.description, needle),
    },
  );
  return { items: page.items.map(publicAlert), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

/** Reconhece o alerta. Altera SOMENTE o alerta: nunca autoriza movimento. */
export async function acknowledgeAlert(deps: Deps, id: string): Promise<AckResult> {
  const now = deps.clock();
  return deps.store.runTransaction(async (tx) => {
    const a = await tx.get<AlertDoc>(C.alerts, id);
    if (!a) throw notFound(`Alerta ${id} não encontrado.`);
    if (!a.acknowledged) {
      a.acknowledged = true;
      a.acknowledgedAt = iso(now);
      tx.set(C.alerts, a.id, a);
    }
    return { id: a.id, acknowledged: true, ...(a.acknowledgedAt ? { acknowledgedAt: a.acknowledgedAt } : {}) };
  });
}

export async function health(deps: Deps, version: string): Promise<Health> {
  const now = deps.clock();
  const robots = await deps.store.query<RobotDoc>(C.robots, { limit: 200 });
  return {
    status: 'ok',
    version,
    robotsConnected: robots.filter((r) => isOnline(r, now, deps.cfg)).length,
  };
}
