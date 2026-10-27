import { aggregateMetrics, type Mission } from '@roboflow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deriveForMission } from '../src/services/derive.js';
import { C } from '../src/store/types.js';
import { makeHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness({ profile: 'demo' });
});
afterAll(async () => {
  await h.close();
});

const missions = async (): Promise<Mission[]> => (await h.api('GET', '/api/missions?limit=500')).json.data;
const metrics = async (qs: string) => (await h.api('GET', `/api/dashboard/metrics?${qs}`)).json.data;

/** A referência (`aggregateMetrics` dos contratos) aplicada às missões do intervalo. */
function reference(list: Mission[], from?: number, to?: number, robotId?: string) {
  const inRange = list.filter(
    (m) =>
      (!from || Date.parse(m.startedAt) >= from) &&
      (!to || Date.parse(m.startedAt) < to) &&
      (!robotId || m.robotId === robotId),
  );
  return aggregateMetrics(inRange, [], []);
}

const sameKpis = (got: any, ref: ReturnType<typeof aggregateMetrics>) => {
  for (const k of [
    'totalMissions', 'completedMissions', 'inProgressMissions', 'failedMissions', 'abortedMissions', 'indeterminateMissions',
    'avgDurationSeconds', 'minDurationSeconds', 'maxDurationSeconds', 'completionRate', 'totalStops', 'presenceStops',
  ] as const) {
    expect(got[k], k).toEqual(ref[k]);
  }
};

describe('métricas por rollup == agregação de referência dos contratos', () => {
  it('todo o período e por robô', async () => {
    const list = await missions();
    sameKpis(await metrics('period=all'), reference(list));
    for (const rb of ['RB-01', 'RB-02', 'RB-03', 'RB-04']) {
      sameKpis(await metrics(`period=all&robotId=${rb}`), reference(list, undefined, undefined, rb));
    }
  });

  it('janelas relativas (bordas parciais + dias inteiros)', async () => {
    const list = await missions();
    const now = h.clock.t;
    sameKpis(await metrics('period=24h'), reference(list, now - 24 * 3600_000, now + 1));
    sameKpis(await metrics('period=7d'), reference(list, now - 7 * 24 * 3600_000, now + 1));
    sameKpis(await metrics('period=30d'), reference(list, now - 30 * 24 * 3600_000, now + 1));
  });

  it('intervalos personalizados: alinhado ao dia e desalinhado; fim exclusivo', async () => {
    const list = await missions();
    const t = (s: string) => Date.parse(s);
    const aligned = ['2026-10-24T00:00:00.000Z', '2026-10-26T00:00:00.000Z'] as const;
    sameKpis(await metrics(`period=custom&startDate=${aligned[0]}&endDate=${aligned[1]}`), reference(list, t(aligned[0]), t(aligned[1])));
    const odd = ['2026-10-24T06:30:00.000Z', '2026-10-26T12:15:00.000Z'] as const;
    sameKpis(await metrics(`period=custom&startDate=${odd[0]}&endDate=${odd[1]}`), reference(list, t(odd[0]), t(odd[1])));
    const sameDay = ['2026-10-26T08:00:00.000Z', '2026-10-26T12:00:00.000Z'] as const;
    sameKpis(await metrics(`period=custom&startDate=${sameDay[0]}&endDate=${sameDay[1]}`), reference(list, t(sameDay[0]), t(sameDay[1])));
  });

  it('regras: taxa 0..100, durações só de concluídas, nulas sem amostra, total de paradas = soma das classes', async () => {
    const all = await metrics('period=all');
    expect(all.completionRate).toBeGreaterThanOrEqual(0);
    expect(all.completionRate).toBeLessThanOrEqual(100);
    expect(all.totalStops).toBe(all.presenceStops + all.otherStops + all.unknownStops);
    const empty = await metrics('period=custom&startDate=2020-01-01T00:00:00.000Z&endDate=2020-01-02T00:00:00.000Z');
    expect(empty).toMatchObject({ totalMissions: 0, completionRate: 0, avgDurationSeconds: null, medianDurationSeconds: null });
  });

  it('frota: contagem por estado e uma linha por robô (inclusive com zero missões)', async () => {
    const fleet = (await h.api('GET', '/api/fleet/metrics?period=all')).json.data;
    expect(fleet.totalRobots).toBe(4);
    expect(fleet.perRobot.map((r: any) => r.robotId).sort()).toEqual(['RB-01', 'RB-02', 'RB-03', 'RB-04']);
    expect(fleet.onlineRobots + fleet.offlineRobots + fleet.errorRobots).toBeLessThanOrEqual(fleet.totalRobots);
    expect(fleet.perRobot.reduce((s: number, r: any) => s + r.totalMissions, 0)).toBe(fleet.totalMissions);
  });

  it('o rollup é aplicado uma única vez, mesmo com reentregas do consumidor', async () => {
    const before = (await h.store.query<any>(C.rollups, {})).reduce((s, r) => s + r.total, 0);
    for (let i = 0; i < 3; i++) {
      for (const m of await missions()) await deriveForMission(h.deps, m.id);
    }
    const after = (await h.store.query<any>(C.rollups, {})).reduce((s, r) => s + r.total, 0);
    expect(after).toBe(before);
    sameKpis(await metrics('period=all'), reference(await missions()));
  });
});
