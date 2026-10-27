import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AlertSchema,
  DEFAULT_CAPABILITIES,
  DeviceRecordSchema,
  LogEventSchema,
  MissionSchema,
  MissionStateRecordSchema,
  RobotMapSchema,
  RobotSchema,
  RouteTemplateSchema,
  ActiveRouteSchema,
  SeedManifestSchema,
  aggregateFleetMetrics,
  aggregateMetrics,
  canTransition,
  nodeId,
  publicMissionStatus,
  translateRoute,
} from '../src/index.js';

const load = <T = unknown>(n: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'seed', `${n}.json`), 'utf8')) as T;

const maps = z.array(RobotMapSchema).parse(load('maps'));
const devices = z.array(DeviceRecordSchema).parse(load('devices'));
const robots = z.array(RobotSchema).parse(load('robots'));
const events = z.array(LogEventSchema).parse(load('events'));
const missions = z.array(MissionSchema).parse(load('missions'));
const alerts = z.array(AlertSchema).parse(load('alerts'));
const templates = z.array(RouteTemplateSchema).parse(load('route-templates'));
const states = z.array(MissionStateRecordSchema).parse(load('mission-states'));
const active = z.array(ActiveRouteSchema).parse(load('active-routes'));

describe('seed — validade e coerência', () => {
  it('manifest e todos os arquivos validam nos schemas', () => {
    expect(SeedManifestSchema.safeParse(load('manifest')).success).toBe(true);
    expect(maps).toHaveLength(4);
    expect(robots).toHaveLength(4);
    expect(missions).toHaveLength(10);
  });

  it('pista-1 é a grade 5x4 do demo, com estações e um bloqueio', () => {
    const p = maps.find((m) => m.id === 'pista-1')!;
    expect([p.cols, p.rows]).toEqual([5, 4]);
    expect(p.points?.filter((x) => x.kind === 'station').map((x) => x.label)).toEqual([
      'carga',
      'descarga',
      'triagem',
    ]);
    expect(p.points?.filter((x) => x.kind === 'blocked')).toEqual([{ x: 2, y: 2, kind: 'blocked' }]);
  });

  it('capacidades do seed = MVP (sem ré, 64 ações, 4096 bytes)', () => {
    for (const d of devices) expect(d.capabilities).toEqual(DEFAULT_CAPABILITIES);
  });

  it('referências cruzadas existem (robô, mapa, missão, evento)', () => {
    const robotIds = new Set(robots.map((r) => r.id));
    const mapIds = new Set(maps.map((m) => m.id));
    const missionIds = new Set(missions.map((m) => m.id));
    const eventIds = new Set(events.map((e) => e.id));
    for (const d of devices) {
      expect(robotIds.has(d.robotId)).toBe(true);
      expect(mapIds.has(d.mapId)).toBe(true);
    }
    for (const m of missions) expect(robotIds.has(m.robotId)).toBe(true);
    for (const e of events) {
      expect(missionIds.has(e.missionId)).toBe(true);
      expect(robotIds.has(e.robotId)).toBe(true);
    }
    for (const a of alerts) {
      for (const id of a.relatedEventIds) expect(eventIds.has(id)).toBe(true);
      if (a.missionId) expect(missionIds.has(a.missionId)).toBe(true);
    }
    for (const r of robots) {
      if (r.currentMissionId) expect(missionIds.has(r.currentMissionId)).toBe(true);
    }
  });

  it('eventCount de cada missão bate com os eventos', () => {
    for (const m of missions) {
      expect(events.filter((e) => e.missionId === m.id).length, m.id).toBe(m.eventCount);
    }
  });

  it('IDs únicos e eventos em ordem cronológica por missão', () => {
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    for (const m of missions) {
      const ts = events.filter((e) => e.missionId === m.id).map((e) => Date.parse(e.timestamp));
      expect(ts).toEqual([...ts].sort((a, b) => a - b));
    }
  });

  it('missão concluída tem endedAt e duração; em andamento não', () => {
    for (const m of missions) {
      if (m.status === 'completed') {
        expect(m.endedAt).toBeDefined();
        expect(m.durationSeconds).not.toBeNull();
      }
      if (m.status === 'in_progress') expect(m.endedAt).toBeUndefined();
    }
  });

  it('estado interno projeta no status público', () => {
    for (const s of states) {
      const m = missions.find((x) => x.id === s.missionId)!;
      expect(publicMissionStatus(s.state)).toBe(m.status);
    }
  });

  it('todas as rotas cadastradas são executáveis sem ré no seu mapa', () => {
    for (const t of templates) {
      const map = maps.find((m) => m.id === t.mapId && m.version === t.mapVersion)!;
      const r = translateRoute(map, t.waypoints, t.initialHeading);
      expect(r.errors, t.id).toEqual([]);
      expect(r.executable, t.id).toBe(true);
      expect(r.actions.length, t.id).toBe(t.waypoints.length - 1);
    }
  });

  it('rota ativa RT-0041 confere com as ações e com a posição do RB-01', () => {
    const rt = active[0]!;
    const map = maps.find((m) => m.id === 'pista-1')!;
    const r = translateRoute(map, rt.waypoints, rt.initialHeading!);
    expect(r.actions).toEqual(rt.actions);
    const robot = robots.find((x) => x.id === 'RB-01')!;
    // currentWaypointIndex 3 => último nó confirmado é o waypoint 3
    expect(robot.currentPoint).toBe(nodeId(rt.waypoints[rt.currentWaypointIndex!]!));
    expect(canTransition('running', 'blocked')).toBe(true);
  });

  it('currentPoint dos robôs fica dentro da malha e fora de bloqueios', () => {
    for (const r of robots) {
      if (!r.currentPoint) continue;
      const d = devices.find((x) => x.robotId === r.id)!;
      const map = maps.find((m) => m.id === d.mapId)!;
      const [x, y] = r.currentPoint.split(',').map(Number) as [number, number];
      expect(x).toBeLessThan(map.cols);
      expect(y).toBeLessThan(map.rows);
      expect(map.points?.some((p) => p.kind === 'blocked' && p.x === x && p.y === y)).toBe(false);
    }
  });

  it('alertas ativos por robô batem com activeAlertsCount', () => {
    for (const r of robots) {
      const n = alerts.filter((a) => a.robotId === r.id && !a.acknowledged).length;
      expect(n, r.id).toBe(r.activeAlertsCount);
    }
  });
});

describe('métricas — invariantes (BACKEND_INTEGRATION.md §3.2/§3.10)', () => {
  const dash = aggregateMetrics(missions, events, alerts);
  const fleet = aggregateFleetMetrics(robots, missions, events, alerts);

  it('totalStops = presença + outras + desconhecidas', () => {
    expect(dash.totalStops).toBe(dash.presenceStops + dash.otherStops + dash.unknownStops);
  });

  it('completionRate é percentual 0–100 e bate com as contagens', () => {
    expect(dash.completionRate).toBe(
      Math.round((dash.completedMissions / dash.totalMissions) * 1000) / 10
    );
    expect(dash.completionRate).toBeGreaterThan(1);
  });

  it('sem missões: taxa 0 e durações null', () => {
    const empty = aggregateMetrics([], [], []);
    expect(empty.completionRate).toBe(0);
    expect(empty.avgDurationSeconds).toBeNull();
    expect(empty.medianDurationSeconds).toBeNull();
    expect(empty.minDurationSeconds).toBeNull();
    expect(empty.maxDurationSeconds).toBeNull();
  });

  it('durações só sobre concluídas com duração conhecida', () => {
    const d = missions.filter((m) => m.status === 'completed').map((m) => m.durationSeconds!);
    expect(dash.minDurationSeconds).toBe(Math.min(...d));
    expect(dash.maxDurationSeconds).toBe(Math.max(...d));
  });

  it('a soma de perRobot reproduz o total da frota', () => {
    expect(fleet.perRobot.reduce((s, r) => s + r.totalMissions, 0)).toBe(fleet.totalMissions);
    expect(fleet.perRobot.reduce((s, r) => s + r.totalStops, 0)).toBe(fleet.totalStops);
    expect(fleet.onlineRobots + fleet.offlineRobots + fleet.errorRobots).toBe(fleet.totalRobots);
    expect(fleet.perRobot).toHaveLength(robots.length);
  });

  it('valores conhecidos do seed', () => {
    expect(dash.totalMissions).toBe(10);
    expect(dash.completedMissions).toBe(7);
    expect(dash.inProgressMissions).toBe(1);
    expect(dash.abortedMissions).toBe(1);
    expect(dash.failedMissions).toBe(1);
    expect(dash.totalErrors).toBe(2);
    expect(dash.activeAlertsCount).toBe(3);
    expect(fleet.onlineRobots).toBe(2);
  });
});
