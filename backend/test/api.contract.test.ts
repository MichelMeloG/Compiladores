import { LIMITS, LogEventSchema } from '@roboflow/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { C } from '../src/store/types.js';
import { expectContract, makeHarness, type Harness } from './helpers.js';

let h: Harness;
beforeAll(async () => {
  h = await makeHarness({ profile: 'demo' });
});
afterAll(async () => {
  await h.close();
});

const get = async (url: string) => h.api('GET', url);

describe('API de leitura: cada resposta cumpre o schema do registro de contratos', () => {
  it.each([
    ['listRobots', '/api/robots'],
    ['getRobot', '/api/robots/RB-01'],
    ['fleetMetrics', '/api/fleet/metrics?period=all'],
    ['dashboardMetrics', '/api/dashboard/metrics?period=all'],
    ['dashboardMetrics', '/api/dashboard/metrics?period=7d&robotId=RB-02'],
    ['listMissions', '/api/missions'],
    ['getMission', '/api/missions/RF-0111'],
    ['listLogs', '/api/logs'],
    ['listAlerts', '/api/alerts'],
    ['getRobotEvents', '/api/robots/RB-03/events'],
    ['getGrid', '/api/robots/RB-01/grid'],
    ['getRoute', '/api/robots/RB-01/route'],
    ['getExecution', '/api/missions/RF-0112/execution'],
    ['getDeviceStatus', '/api/devices/RB-01/status'],
  ] as const)('%s %s', async (id, url) => {
    const r = await get(url);
    expect(r.status).toBe(200);
    expectContract(id, r.json);
  });

  it('health: /health não toca o banco; /api/health informa robôs conectados', async () => {
    const light = await h.app.inject({ method: 'GET', url: '/health' });
    expect(light.json()).toEqual({ status: 'ok' });
    const full = await get('/api/health');
    expectContract('health', full.json);
  });

  it('404 de rota e de recurso usam o envelope de erro', async () => {
    const noRoute = await get('/api/robots/RB-02/route');
    expect(noRoute.status).toBe(404);
    expect(noRoute.json).toMatchObject({ success: false, error: 'NOT_FOUND' });
    expect((await get('/api/missions/NAO-EXISTE')).status).toBe(404);
    expect((await get('/api/robots/XX')).status).toBe(404);
    expect((await get('/api/devices/XX/status')).status).toBe(404);
  });

  it('query inválida => 400 INVALID_QUERY', async () => {
    expect((await get('/api/missions?limit=9999')).json.error).toBe('INVALID_QUERY');
    expect((await get('/api/dashboard/metrics?period=custom')).json.error).toBe('INVALID_QUERY');
    expect((await get('/api/logs?severity=banana')).json.error).toBe('INVALID_QUERY');
    expect((await get('/api/dashboard/metrics?period=custom&startDate=2026-10-26T00:00:00Z&endDate=2026-10-25T00:00:00Z')).status).toBe(400);
  });
});

describe('listas: filtros, ordenação e paginação por cursor', () => {
  it('missões: robotId, status e "all" equivale a omitido', async () => {
    const rb1 = (await get('/api/missions?robotId=RB-01')).json.data;
    expect(rb1.length).toBeGreaterThan(0);
    expect(rb1.every((m: any) => m.robotId === 'RB-01')).toBe(true);
    const completed = (await get('/api/missions?status=completed')).json.data;
    expect(completed.every((m: any) => m.status === 'completed')).toBe(true);
    const all = (await get('/api/missions?status=all')).json.data;
    const none = (await get('/api/missions')).json.data;
    expect(all.map((m: any) => m.id)).toEqual(none.map((m: any) => m.id));
    expect(none.every((m: any) => m.events === undefined)).toBe(true); // lista leve
  });

  it('missões: do mais recente ao mais antigo, e o cursor percorre tudo sem repetir', async () => {
    const full = (await get('/api/missions?limit=500')).json.data;
    const starts = full.map((m: any) => m.startedAt);
    expect([...starts].sort().reverse()).toEqual(starts);

    const ids: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await get(`/api/missions?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      ids.push(...r.json.data.map((m: any) => m.id));
      cursor = r.json.nextCursor;
      if (!cursor) break;
    }
    expect(ids).toEqual(full.map((m: any) => m.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('missões: busca textual e período', async () => {
    const found = (await get('/api/missions?search=inspe')).json.data;
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((m: any) => `${m.id} ${m.origin} ${m.destination}`.toLowerCase().includes('inspe'))).toBe(true);
    const day = (await get('/api/missions?period=24h')).json.data;
    const cutoff = h.clock.t - 24 * 3600_000;
    expect(day.every((m: any) => Date.parse(m.startedAt) >= cutoff)).toBe(true);
  });

  it('logs: mais recente primeiro, filtros de severidade/tipo/missão/robô e busca', async () => {
    const logs = (await get('/api/logs?limit=500')).json.data;
    const ts = logs.map((e: any) => e.timestamp);
    expect([...ts].sort().reverse()).toEqual(ts);
    const warn = (await get('/api/logs?severity=warning')).json.data;
    expect(warn.length).toBeGreaterThan(0);
    expect(warn.every((e: any) => e.severity === 'warning')).toBe(true);
    const byType = (await get('/api/logs?eventType=stop_preventive')).json.data;
    expect(byType.every((e: any) => e.eventType === 'stop_preventive')).toBe(true);
    const byMission = (await get('/api/logs?missionId=RF-0111')).json.data;
    expect(byMission.every((e: any) => e.missionId === 'RF-0111')).toBe(true);
    const byRobot = (await get('/api/logs?robotId=RB-03')).json.data;
    expect(byRobot.every((e: any) => e.robotId === 'RB-03')).toBe(true);
    const text = (await get('/api/logs?search=obst')).json.data;
    expect(text.every((e: any) => /obst/i.test(`${e.message} ${e.command ?? ''}`))).toBe(true);
  });

  it('detalhe da missão traz a linha do tempo em ordem cronológica', async () => {
    const m = (await get('/api/missions/RF-0111')).json.data;
    expect(m.events.length).toBe(m.eventCount);
    const ts = m.events.map((e: any) => e.timestamp);
    expect([...ts].sort()).toEqual(ts);
  });

  it('alertas: filtros por status, severidade e robô; contagem do robô bate com a lista', async () => {
    const un = (await get('/api/alerts?status=unacknowledged')).json.data;
    expect(un.every((a: any) => a.acknowledged === false)).toBe(true);
    const crit = (await get('/api/alerts?severity=critical')).json.data;
    expect(crit.every((a: any) => a.severity === 'critical')).toBe(true);
    const rb3 = (await get('/api/alerts?robotId=RB-03&status=unacknowledged')).json.data;
    const robot = (await get('/api/robots/RB-03')).json.data;
    expect(robot.activeAlertsCount).toBe(rb3.length);
  });
});

describe('escritas que NUNCA podem gerar movimento', () => {
  it('reconhecer alerta é persistido, idempotente e não cria comando', async () => {
    const before = h.store.size(C.commands);
    const id = (await get('/api/alerts?status=unacknowledged')).json.data[0].id;
    const a = await h.api('PATCH', `/api/alerts/${id}/acknowledge`);
    expect(a.status).toBe(200);
    expectContract('acknowledgeAlert', a.json);
    expect(a.json.data.acknowledged).toBe(true);
    const b = await h.api('PATCH', `/api/alerts/${id}/acknowledge`);
    expect(b.json.data.acknowledgedAt).toBe(a.json.data.acknowledgedAt);
    expect((await get('/api/alerts?status=acknowledged')).json.data.some((x: any) => x.id === id)).toBe(true);
    expect(h.store.size(C.commands)).toBe(before);
    expect((await h.api('PATCH', '/api/alerts/inexistente/acknowledge')).status).toBe(404);
  });

  it('importação deduplica por ID, valida cada evento e não mexe em missões, robôs nem comandos', async () => {
    const snap = async () => JSON.stringify({
      robots: await h.store.query(C.robots, {}),
      missions: await h.store.query(C.missions, {}),
      commands: h.store.size(C.commands),
    });
    const before = await snap();
    const ev = (id: string) => ({
      id,
      missionId: 'RF-0112', // missão ATIVA: o histórico não pode alterá-la
      robotId: 'RB-01',
      timestamp: '2026-10-20T10:00:00.000Z',
      eventType: 'command',
      command: 'STOP',
      severity: 'info',
      message: 'importado',
    });
    expect(LogEventSchema.safeParse(ev('imp-1')).success).toBe(true);
    const r1 = await h.api('POST', '/api/logs/import', { body: { events: [ev('imp-1'), ev('imp-2')] } });
    expect(r1.status).toBe(200);
    expectContract('importLogs', r1.json);
    expect(r1.json.data).toEqual({ importedCount: 2, ignoredCount: 0 });
    const r2 = await h.api('POST', '/api/logs/import', { body: { events: [ev('imp-2'), ev('imp-3')] } });
    expect(r2.json.data).toEqual({ importedCount: 1, ignoredCount: 1 });
    expect(await snap()).toBe(before);
    expect((await get('/api/logs?search=importado')).json.data).toHaveLength(3);
  });

  it('importação recusa evento inválido, lote vazio e lote acima do limite', async () => {
    const bad = await h.api('POST', '/api/logs/import', { body: { events: [{ id: 'x' }] } });
    expect(bad.status).toBe(400);
    expect((await h.api('POST', '/api/logs/import', { body: { events: [] } })).status).toBe(400);
    const many = Array.from({ length: LIMITS.importMaxEvents + 1 }, (_, i) => ({
      id: `m-${i}`, missionId: 'M', robotId: 'RB-01', timestamp: '2026-10-20T10:00:00.000Z', eventType: 'command', severity: 'info', message: 'x',
    }));
    const r = await h.api('POST', '/api/logs/import', { body: { events: many } });
    expect(r.status).toBe(413);
  });
});
