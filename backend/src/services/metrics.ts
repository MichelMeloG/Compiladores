import { median, type DashboardMetrics, type FleetMetrics, type TimePeriod } from '@roboflow/contracts';
import { AppError } from '../errors.js';
import type { MissionDoc, RobotDoc, RollupDoc } from '../domain/types.js';
import { C, type Filter } from '../store/types.js';
import { iso, type Deps } from './common.js';
import { publicRobot } from './projection.js';

export interface Range {
  start?: Date;
  end?: Date;
}

/** Converte `period`/`startDate`/`endDate` num intervalo [start, end) em UTC. */
export function resolveRange(
  q: { period?: TimePeriod | undefined; startDate?: string | undefined; endDate?: string | undefined },
  now: Date,
): Range {
  switch (q.period) {
    case '24h':
      return { start: new Date(now.getTime() - 24 * 3600_000), end: new Date(now.getTime() + 1) };
    case '7d':
      return { start: new Date(now.getTime() - 7 * 24 * 3600_000), end: new Date(now.getTime() + 1) };
    case '30d':
      return { start: new Date(now.getTime() - 30 * 24 * 3600_000), end: new Date(now.getTime() + 1) };
    case 'custom': {
      if (!q.startDate || !q.endDate) {
        throw new AppError('INVALID_QUERY', 'period=custom exige startDate e endDate.');
      }
      const start = new Date(q.startDate);
      const end = new Date(q.endDate);
      if (start > end) throw new AppError('INVALID_QUERY', 'startDate não pode ser posterior a endDate.');
      return { start, end };
    }
    default:
      return {};
  }
}

export interface Agg {
  completed: number;
  failed: number;
  aborted: number;
  indeterminate: number;
  inProgress: number;
  durations: number[];
  stops: number;
  presence: number;
  other: number;
  unknown: number;
  errors: number;
}

const emptyAgg = (): Agg => ({
  completed: 0,
  failed: 0,
  aborted: 0,
  indeterminate: 0,
  inProgress: 0,
  durations: [],
  stops: 0,
  presence: 0,
  other: 0,
  unknown: 0,
  errors: 0,
});

function addMission(a: Agg, m: MissionDoc): void {
  switch (m.state) {
    case 'completed':
      a.completed += 1;
      if (m.durationSeconds !== null) a.durations.push(m.durationSeconds);
      break;
    case 'failed':
      a.failed += 1;
      break;
    case 'aborted':
      a.aborted += 1;
      break;
    case 'uncertain':
      a.indeterminate += 1;
      break;
    default:
      a.inProgress += 1;
  }
  a.stops += m.stopCount;
  a.presence += m.presenceStopCount;
  a.other += m.otherStopCount;
  a.unknown += m.unknownStopCount;
  a.errors += m.errorCount;
}

function addRollup(a: Agg, r: RollupDoc): void {
  a.completed += r.completed;
  a.failed += r.failed;
  a.aborted += r.aborted;
  a.durations.push(...r.durations);
  a.stops += r.stops;
  a.presence += r.presenceStops;
  a.other += r.otherStops;
  a.unknown += r.unknownStops;
  a.errors += r.errors;
}

const DAY_MS = 24 * 3600_000;
const ceilDay = (d: Date) => new Date(Math.ceil(d.getTime() / DAY_MS) * DAY_MS);
const floorDay = (d: Date) => new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);

/**
 * Agrega missões por robô lendo POUCOS documentos (cota do Firestore):
 *  - dias inteiros dentro do intervalo => documentos de rollup (1 leitura/dia/robô);
 *  - bordas parciais do intervalo => missões terminadas dessas bordas;
 *  - missões ativas e terminadas ainda não consolidadas => consulta pequena.
 * Sem intervalo ("all") lê só os rollups.
 */
export async function aggregateByRobot(deps: Deps, range: Range, robotId?: string): Promise<Map<string, Agg>> {
  const out = new Map<string, Agg>();
  const agg = (id: string) => {
    let a = out.get(id);
    if (!a) {
      a = emptyAgg();
      out.set(id, a);
    }
    return a;
  };
  const robotFilter: Filter[] = robotId ? [{ field: 'robotId', op: '==', value: robotId }] : [];
  const inRange = (startedAt: string, from?: Date, to?: Date) =>
    (!from || startedAt >= iso(from)) && (!to || startedAt < iso(to));

  const seen = new Set<string>();
  const readEdge = async (from: Date, to: Date) => {
    const ms = await deps.store.query<MissionDoc>(C.missions, {
      filters: [
        ...robotFilter,
        { field: 'active', op: '==', value: false },
        { field: 'startedAt', op: '>=', value: iso(from) },
        { field: 'startedAt', op: '<', value: iso(to) },
      ],
      orderBy: { field: 'startedAt', dir: 'desc' },
      limit: 1000,
    });
    for (const m of ms) {
      seen.add(m.id);
      addMission(agg(m.robotId), m);
    }
  };

  let midFrom: Date | undefined;
  let midTo: Date | undefined;
  if (!range.start && !range.end) {
    // "all": só rollups (+ pendentes e ativas abaixo)
  } else {
    const start = range.start ?? new Date(0);
    const end = range.end ?? new Date(Date.now() + DAY_MS);
    const dayStart = ceilDay(start);
    const dayEnd = floorDay(end);
    if (dayStart >= dayEnd) {
      await readEdge(start, end);
    } else {
      if (start < dayStart) await readEdge(start, dayStart);
      if (dayEnd < end) await readEdge(dayEnd, end);
      midFrom = dayStart;
      midTo = dayEnd;
    }
  }

  const useRollups = (!range.start && !range.end) || (midFrom && midTo);
  if (useRollups) {
    // "all": 1 documento acumulado por robô; intervalo: 1 documento por dia/robô.
    const filters: Filter[] = [...robotFilter];
    if (midFrom && midTo) {
      filters.push({ field: 'scope', op: '==', value: 'day' });
      filters.push({ field: 'day', op: '>=', value: midFrom.toISOString().slice(0, 10) });
      filters.push({ field: 'day', op: '<', value: midTo.toISOString().slice(0, 10) });
    } else {
      filters.push({ field: 'scope', op: '==', value: 'all' });
    }
    const rolls = await deps.store.query<RollupDoc>(C.rollups, { filters, limit: 2000 });
    for (const r of rolls) addRollup(agg(r.robotId), r);

    // Terminadas, ainda sem rollup (janela entre o fim da missão e o consumidor).
    const pending = await deps.store.query<MissionDoc>(C.missions, {
      filters: [...robotFilter, { field: 'active', op: '==', value: false }, { field: 'rolledUp', op: '==', value: false }],
      limit: 100,
    });
    for (const m of pending) {
      if (seen.has(m.id)) continue;
      if (midFrom && midTo ? inRange(m.startedAt, midFrom, midTo) : true) {
        seen.add(m.id);
        addMission(agg(m.robotId), m);
      }
    }
  }

  // Ativas (em andamento ou incertas): sempre contam, se no intervalo.
  const active = await deps.store.query<MissionDoc>(C.missions, {
    filters: [...robotFilter, { field: 'active', op: '==', value: true }],
    limit: 200,
  });
  for (const m of active) {
    if (seen.has(m.id)) continue;
    if (inRange(m.startedAt, range.start, range.end)) addMission(agg(m.robotId), m);
  }
  return out;
}

export function mergeAggs(list: Iterable<Agg>): Agg {
  const t = emptyAgg();
  for (const a of list) {
    t.completed += a.completed;
    t.failed += a.failed;
    t.aborted += a.aborted;
    t.indeterminate += a.indeterminate;
    t.inProgress += a.inProgress;
    t.durations.push(...a.durations);
    t.stops += a.stops;
    t.presence += a.presence;
    t.other += a.other;
    t.unknown += a.unknown;
    t.errors += a.errors;
  }
  return t;
}

export function toMetrics(a: Agg, activeAlerts: number): DashboardMetrics {
  const total = a.completed + a.failed + a.aborted + a.indeterminate + a.inProgress;
  const d = a.durations;
  return {
    totalMissions: total,
    completedMissions: a.completed,
    inProgressMissions: a.inProgress,
    failedMissions: a.failed,
    abortedMissions: a.aborted,
    indeterminateMissions: a.indeterminate,
    avgDurationSeconds: d.length ? Math.round(d.reduce((x, y) => x + y, 0) / d.length) : null,
    medianDurationSeconds: median(d),
    minDurationSeconds: d.length ? Math.min(...d) : null,
    maxDurationSeconds: d.length ? Math.max(...d) : null,
    totalStops: a.presence + a.other + a.unknown,
    presenceStops: a.presence,
    otherStops: a.other,
    unknownStops: a.unknown,
    completionRate: total ? Math.round((a.completed / total) * 1000) / 10 : 0,
    activeAlertsCount: activeAlerts,
    totalErrors: a.errors,
  };
}

/** Alertas não reconhecidos por robô: agregação `count()` (1 leitura por 1.000 entradas), não varredura. */
export async function unackedByRobot(deps: Deps, robotIds: string[]): Promise<Map<string, number>> {
  const entries = await Promise.all(robotIds.map(async (id) => [id, await unackedTotal(deps, id)] as const));
  return new Map(entries);
}

export function unackedTotal(deps: Deps, robotId?: string): Promise<number> {
  const filters: Filter[] = [{ field: 'acknowledged', op: '==', value: false }];
  if (robotId) filters.push({ field: 'robotId', op: '==', value: robotId });
  return deps.store.count(C.alerts, filters);
}

export async function dashboardMetrics(
  deps: Deps,
  q: { period?: TimePeriod | undefined; startDate?: string | undefined; endDate?: string | undefined; robotId?: string | undefined },
): Promise<DashboardMetrics> {
  const range = resolveRange(q, deps.clock());
  const [byRobot, active] = await Promise.all([
    aggregateByRobot(deps, range, q.robotId),
    unackedTotal(deps, q.robotId),
  ]);
  return toMetrics(mergeAggs(byRobot.values()), active);
}

export async function fleetMetrics(
  deps: Deps,
  q: { period?: TimePeriod | undefined; startDate?: string | undefined; endDate?: string | undefined },
): Promise<FleetMetrics> {
  const now = deps.clock();
  const range = resolveRange(q, now);
  const [byRobot, robots, totalUnacked] = await Promise.all([
    aggregateByRobot(deps, range),
    deps.store.query<RobotDoc>(C.robots, { limit: 200 }),
    unackedTotal(deps),
  ]);
  const alerts = await unackedByRobot(deps, robots.map((r) => r.id));
  const pubs = robots.map((r) => publicRobot(r, now, deps.cfg, alerts.get(r.id) ?? 0));
  const total = toMetrics(mergeAggs(byRobot.values()), totalUnacked);
  return {
    ...total,
    totalRobots: pubs.length,
    onlineRobots: pubs.filter((r) => ['online', 'busy', 'idle'].includes(r.status)).length,
    offlineRobots: pubs.filter((r) => r.status === 'offline').length,
    errorRobots: pubs.filter((r) => r.status === 'error').length,
    perRobot: pubs.map((r) => {
      const s = toMetrics(byRobot.get(r.id) ?? emptyAgg(), alerts.get(r.id) ?? 0);
      return {
        robotId: r.id,
        robotName: r.name,
        totalMissions: s.totalMissions,
        completedMissions: s.completedMissions,
        totalStops: s.totalStops,
        totalErrors: s.totalErrors,
        completionRate: s.completionRate,
        avgDurationSeconds: s.avgDurationSeconds,
      };
    }),
  };
}
