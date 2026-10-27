import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { translateRoute, nodeId, type Heading, type MissionState } from '@roboflow/contracts';
import type { MapDoc, MissionDoc, RobotDoc, RouteDoc } from './domain/types.js';
import { isActive } from './domain/mission.js';
import { C, mapsCollection } from './store/types.js';
import { counterFloor } from './services/ids.js';
import { deriveForMission } from './services/derive.js';
import type { Deps } from './services/common.js';
import { iso } from './services/common.js';

export type SeedProfile = 'clean' | 'demo';

/** Lê um JSON do pacote de contratos (fonte única de dados de exemplo). */
function readSeed<T>(name: string): T {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve('@roboflow/contracts/seed/manifest.json');
  return JSON.parse(readFileSync(join(dirname(manifest), name), 'utf8')) as T;
}

interface SeedManifest {
  seedNow: string;
}
interface SeedMap {
  id: string;
  version: number;
  name?: string;
  cols: number;
  rows: number;
  points?: MapDoc['points'];
  closedEdges?: { from: { x: number; y: number }; to: { x: number; y: number }; bidirectional?: boolean }[];
}
interface SeedDevice {
  id: string;
  robotId: string;
  mapId: string;
  mapVersion: number;
  lastConfirmedHeading: Heading;
  capabilities: NonNullable<RobotDoc['capabilities']>;
}
interface SeedRobot {
  id: string;
  name: string;
  area?: string;
  model?: string;
  status: string;
  currentMissionId?: string;
  batteryPercent?: number | null;
  currentPoint?: string | null;
  firmwareVersion?: string;
  lastSeenAt: string;
}
interface SeedActiveRoute {
  routeId: string;
  robotId: string;
  waypoints: { x: number; y: number }[];
  createdAt: string;
  currentWaypointIndex?: number | null;
  missionId?: string;
  initialHeading?: Heading;
}
interface SeedMission {
  id: string;
  robotId: string;
  origin: string;
  destination: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number | null;
  stopCount: number;
  presenceStopCount: number;
  errorCount: number;
  eventCount: number;
  stopReasons: { reason: string; count: number }[];
}
interface SeedMissionState {
  missionId: string;
  state: MissionState;
  routeRevision: number;
}

const STATE_FOR_STATUS: Record<string, MissionState> = {
  in_progress: 'running',
  completed: 'completed',
  aborted: 'aborted',
  failed: 'failed',
  indeterminate: 'uncertain',
};

/** Já existe dado? (seed é idempotente: só popula banco vazio). */
export async function isSeeded(deps: Deps): Promise<boolean> {
  const any = await deps.store.query(C.robots, { limit: 1 });
  return any.length > 0;
}

/**
 * Popula o store com mapas e robôs ("clean") ou com um conjunto completo de
 * demonstração ("demo": missões, eventos, alertas e rollups). Datas do seed
 * são deslocadas para que "agora" seja o instante da carga.
 */
export async function seedStore(deps: Deps, profile: SeedProfile): Promise<{ robots: number; missions: number }> {
  const now = deps.clock();
  const manifest = readSeed<SeedManifest>('manifest.json');
  const shift = now.getTime() - Date.parse(manifest.seedNow);
  const sh = (t: string) => new Date(Date.parse(t) + shift).toISOString();

  const maps = readSeed<SeedMap[]>('maps.json');
  const devices = readSeed<SeedDevice[]>('devices.json');
  const robots = readSeed<SeedRobot[]>('robots.json');
  const routes = readSeed<SeedActiveRoute[]>('active-routes.json');

  const mapDocs: MapDoc[] = maps.map((m) => ({
    id: String(m.version),
    mapId: m.id,
    version: m.version,
    cols: m.cols,
    rows: m.rows,
    ...(m.points ? { points: m.points } : {}),
    closedEdges: (m.closedEdges ?? []).map((e) => ({ ...e, bidirectional: e.bidirectional !== false })),
    ...(m.name ? { name: m.name } : {}),
  }));
  for (const m of mapDocs) await deps.store.set(mapsCollection(m.mapId), m.id, m);

  const demo = profile === 'demo';
  const routeByRobot = new Map(routes.map((r) => [r.robotId, r]));
  const robotDocs: RobotDoc[] = robots.map((r) => {
    const d = devices.find((x) => x.robotId === r.id);
    if (!d) throw new Error(`Seed inconsistente: robô ${r.id} sem dispositivo.`);
    const live = ['online', 'busy', 'idle'].includes(r.status);
    const route = routeByRobot.get(r.id);
    return {
      id: r.id,
      name: r.name,
      ...(r.area ? { area: r.area } : {}),
      ...(r.model ? { model: r.model } : {}),
      mapId: d.mapId,
      mapVersion: d.mapVersion,
      ...(r.firmwareVersion ? { firmwareVersion: r.firmwareVersion } : {}),
      currentPoint: r.currentPoint ?? null,
      heading: d.lastConfirmedHeading,
      positionConfidence: r.currentPoint ? 'confirmed' : 'unknown',
      batteryPercent: r.batteryPercent ?? null,
      createdAt: sh(r.lastSeenAt),
      sessionId: null,
      capabilities: d.capabilities,
      deviceState: null,
      lastSeenAt: demo ? (live ? iso(new Date(now.getTime() - 10_000)) : sh(r.lastSeenAt)) : null,
      lastHelloTs: 0,
      lastRequestSeq: 0,
      ackedSeq: 0,
      activeMissionId: demo ? (r.currentMissionId ?? null) : null,
      currentRouteId: demo && route ? route.routeId : null,
      pendingCommandIds: [],
      live: null,
    } satisfies RobotDoc;
  });
  for (const r of robotDocs) await deps.store.set(C.robots, r.id, r);

  if (!demo) return { robots: robotDocs.length, missions: 0 };

  // ---------------------------------------------------------------- demo
  const missions = readSeed<SeedMission[]>('missions.json');
  const states = new Map(readSeed<SeedMissionState[]>('mission-states.json').map((s) => [s.missionId, s]));
  const events = readSeed<Record<string, unknown>[]>('events.json');
  const alerts = readSeed<Record<string, unknown>[]>('alerts.json');

  for (const m of missions) {
    const robot = robotDocs.find((r) => r.id === m.robotId);
    const map = mapDocs.find((x) => x.mapId === robot?.mapId && x.version === robot?.mapVersion);
    if (!robot || !map) continue;
    const route = routes.find((r) => r.missionId === m.id);
    const state = states.get(m.id)?.state ?? STATE_FOR_STATUS[m.status] ?? 'completed';
    const heading = route?.initialHeading ?? robot.heading ?? 'N';
    const t = route ? translateRoute(map, route.waypoints, heading) : undefined;
    const done = route ? Math.max(0, route.currentWaypointIndex ?? 0) : 0;
    const start = route?.waypoints[0];
    const doc: MissionDoc = {
      id: m.id,
      robotId: m.robotId,
      routeId: route?.routeId ?? `RT-${m.id}`,
      routeRevision: states.get(m.id)?.routeRevision ?? 1,
      origin: m.origin,
      destination: m.destination,
      state,
      status: m.status as MissionDoc['status'],
      active: isActive(state),
      rolledUp: false,
      mapId: robot.mapId,
      mapVersion: robot.mapVersion,
      waypoints: route?.waypoints ?? [],
      actions: t?.actions ?? [],
      expectedNodes: t?.expectedNodes ?? [],
      initialHeading: heading,
      headingsAfter: t?.steps.map((s) => s.headingAfter) ?? [],
      startNode: start ? nodeId(start) : (robot.currentPoint ?? '0,0'),
      totalActions: t?.actions.length ?? 0,
      completedActions: done,
      lastConfirmedNode: route && done > 0 ? (t?.expectedNodes[done - 1] ?? nodeId(route.waypoints[0] as never)) : (start ? nodeId(start) : '0,0'),
      headingAtLastConfirmedNode: route && done > 0 ? ((t?.steps[done - 1]?.headingAfter ?? heading) as Heading) : heading,
      positionConfidence: 'estimated',
      startedAt: sh(m.startedAt),
      ...(m.endedAt ? { endedAt: sh(m.endedAt) } : {}),
      durationSeconds: m.durationSeconds,
      stopCount: m.stopCount,
      presenceStopCount: m.presenceStopCount,
      otherStopCount: Math.max(0, m.stopCount - m.presenceStopCount),
      unknownStopCount: 0,
      errorCount: m.errorCount,
      eventCount: m.eventCount,
      eventSeq: m.eventCount,
      stopReasons: m.stopReasons,
      currentBlock: null,
      faults: [],
      sessionId: null,
      operatorUid: 'seed',
      updatedAt: sh(m.endedAt ?? m.startedAt),
    };
    await deps.store.set(C.missions, doc.id, doc);
    if (route) {
      const rd: RouteDoc = {
        id: route.routeId,
        robotId: route.robotId,
        missionId: m.id,
        waypoints: route.waypoints,
        actions: t?.actions ?? [],
        initialHeading: heading,
        mapId: robot.mapId,
        mapVersion: robot.mapVersion,
        createdAt: sh(route.createdAt),
      };
      await deps.store.set(C.routes, rd.id, rd);
    }
  }

  for (const e of events) {
    const id = String(e.id);
    await deps.store.set(C.events, id, {
      ...(e as object),
      id,
      timestamp: sh(String(e.timestamp)),
      source: 'system',
    } as never);
  }
  for (const a of alerts) {
    const id = String(a.id);
    await deps.store.set(C.alerts, id, { ...(a as object), id, timestamp: sh(String(a.timestamp)) } as never);
  }

  // IDs sequenciais continuam depois dos do seed (RF-0113, RT-0042...).
  const maxNum = (ids: string[]) => Math.max(0, ...ids.map((x) => Number(/(\d+)$/.exec(x)?.[1] ?? 0)));
  await deps.store.set(C.counters, 'mission', counterFloor('mission', maxNum(missions.map((m) => m.id))));
  await deps.store.set(C.counters, 'route', counterFloor('route', maxNum(routes.map((r) => r.routeId))));

  // Rollups coerentes com as missões terminadas (mesma rotina do consumidor).
  for (const m of missions) await deriveForMission(deps, m.id);
  return { robots: robotDocs.length, missions: missions.length };
}
