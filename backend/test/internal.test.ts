import { InternalEventEnvelopeSchema } from '@roboflow/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OidcVerifier } from '../src/auth/internal.js';
import { C } from '../src/store/types.js';
import { loadMission, makeHarness, mission, startMission, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.close();
  h = undefined;
});

const PUSH = 'pubsub-invoker@test.iam';
/** Documentos de rollup por escopo: cada missão terminada gera 1 do dia e 1 acumulado. */
const rollups = (hh: Harness, scope: 'day' | 'all') =>
  hh.store.query<any>('rollups', { filters: [{ field: 'scope', op: '==', value: scope }] });
const SCHED = 'scheduler-invoker@test.iam';
const oidc: OidcVerifier = {
  async verify(token, audience) {
    if (audience !== 'https://api.test') throw new Error('audiência errada');
    const t: Record<string, { email: string; emailVerified: boolean }> = {
      push: { email: PUSH, emailVerified: true },
      sched: { email: SCHED, emailVerified: true },
      other: { email: 'outra@x.iam', emailVerified: true },
      unverified: { email: PUSH, emailVerified: false },
    };
    const hit = t[token];
    if (!hit) throw new Error('token inválido');
    return hit;
  },
};

const post = (hh: Harness, url: string, token?: string, body?: unknown) =>
  hh.app.inject({
    method: 'POST',
    url,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
    payload: body === undefined ? '{}' : JSON.stringify(body),
  });

const push = (env: unknown) => ({
  message: { data: Buffer.from(JSON.stringify(env)).toString('base64'), messageId: 'pm-1' },
  subscription: 'projects/p/subscriptions/agv-events-push',
});

describe('/internal/*: só o OIDC da service account certa entra', () => {
  it('sem token 401; token inválido 401; SA errada, e-mail não verificado ou SA trocada 403', async () => {
    h = await makeHarness({ oidcVerifier: oidc, publisher: 'record' });
    expect((await post(h, '/internal/events')).statusCode).toBe(401);
    expect((await post(h, '/internal/events', 'lixo', push({}))).statusCode).toBe(401);
    expect((await post(h, '/internal/events', 'other', push({}))).statusCode).toBe(403);
    expect((await post(h, '/internal/events', 'unverified', push({}))).statusCode).toBe(403);
    expect((await post(h, '/internal/events', 'sched', push({}))).statusCode).toBe(403); // SA do Scheduler no endpoint do Pub/Sub
    expect((await post(h, '/internal/offline-check')).statusCode).toBe(401);
    expect((await post(h, '/internal/offline-check', 'push')).statusCode).toBe(403);
    expect((await post(h, '/internal/offline-check', 'sched')).statusCode).toBe(200);
  });

  it('sem verificador configurado, /internal/* nunca é aberto', async () => {
    h = await makeHarness({ publisher: 'record' });
    expect((await post(h, '/internal/offline-check', 'sched')).statusCode).toBe(401);
  });

  it('mensagem malformada => 400 (vai para retry e depois DLQ)', async () => {
    h = await makeHarness({ oidcVerifier: oidc, publisher: 'record' });
    expect((await post(h, '/internal/events', 'push', { foo: 1 })).statusCode).toBe(400);
    const notJson = { message: { data: Buffer.from('nao-json').toString('base64'), messageId: '1' }, subscription: 's' };
    expect((await post(h, '/internal/events', 'push', notJson)).statusCode).toBe(400);
    expect((await post(h, '/internal/events', 'push', push({ qualquer: 'coisa' }))).statusCode).toBe(400);
  });
});

describe('ingest -> Pub/Sub -> consumidor idempotente', () => {
  it('publica o envelope de cada evento crítico, no formato do contrato', async () => {
    h = await makeHarness({ publisher: 'record' });
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.runToEnd();
    const rec = h.recorded!.published;
    expect(rec.length).toBeGreaterThan(0);
    for (const env of rec) expect(InternalEventEnvelopeSchema.safeParse(env).success).toBe(true);
    const types = rec.map((e) => e.event.type);
    expect(types).toContain('mission_completed');
    expect(types).not.toContain('telemetry');
    expect(types).not.toContain('action_started');
  });

  it('reentrega at-least-once: rollup e alertas não duplicam', async () => {
    h = await makeHarness({ oidcVerifier: oidc, publisher: 'record' });
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.runToEnd();
    const done = h.recorded!.published.find((e) => e.event.type === 'mission_completed')!;
    // nenhum consumidor rodou ainda
    expect(h.store.size(C.rollups)).toBe(0);

    for (let i = 0; i < 4; i++) expect((await post(h, '/internal/events', 'push', push(done))).statusCode).toBe(200);
    const days = await rollups(h, 'day');
    const all = await rollups(h, 'all');
    expect(days).toHaveLength(1);
    expect(all).toHaveLength(1);
    expect(days[0]).toMatchObject({ id: expect.stringMatching(/^RB-01_\d{8}$/), total: 1, completed: 1 });
    expect(all[0]).toMatchObject({ id: 'RB-01_all', total: 1, completed: 1 });
    expect(((await h.store.get(C.missions, missionId)) as any).rolledUp).toBe(true);
  });

  it('falha do consumidor devolve status não-2xx (reentrega e DLQ)', async () => {
    h = await makeHarness({ oidcVerifier: oidc, publisher: 'record' });
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.runToEnd();
    const done = h.recorded!.published.find((e) => e.event.type === 'mission_completed')!;
    const spy = vi.spyOn(h.store, 'runTransaction').mockRejectedValueOnce(new Error('Firestore indisponível'));
    const bad = await post(h, '/internal/events', 'push', push(done));
    expect(bad.statusCode).toBe(500);
    expect(spy).toHaveBeenCalled();
    expect((await post(h, '/internal/events', 'push', push(done))).statusCode).toBe(200); // a reentrega funciona
    expect(await rollups(h, 'day')).toHaveLength(1);
  });

  it('falha ao publicar NÃO derruba o ingest; a varredura do Scheduler recupera o rollup', async () => {
    h = await makeHarness({ oidcVerifier: oidc, publisher: 'record' });
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.doAction();
    await sim.doAction();
    h.recorded!.failNext = true; // a publicação do lote final falha
    await sim.doAction();
    expect((await mission(h, missionId)).status).toBe('completed'); // o estado crítico é síncrono
    expect(h.store.size(C.rollups)).toBe(0);
    const r = await post(h, '/internal/offline-check', 'sched');
    expect(r.json().data.rolledUp).toBe(1);
    expect(await rollups(h, 'day')).toHaveLength(1);
    expect(((await post(h, '/internal/offline-check', 'sched')).json().data.rolledUp)).toBe(0);
  });
});

describe('offline-check (Cloud Scheduler)', () => {
  it('sem comunicação durante a missão: alerta único; a missão NÃO é concluída nem abortada por timeout', async () => {
    h = await makeHarness({ oidcVerifier: oidc });
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    h.clock.advance(h.cfg.offlineAfterMs + 10_000);
    const first = await post(h, '/internal/offline-check', 'sched');
    expect(first.json().data).toMatchObject({ checked: 4, markedOffline: 1 });
    await post(h, '/internal/offline-check', 'sched');
    const alerts = (await h.api('GET', `/api/alerts?missionId=${missionId}`)).json.data;
    expect(alerts.filter((a: any) => a.title.includes('sem comunicação'))).toHaveLength(1);
    expect((await mission(h, missionId)).status).toBe('in_progress');
    expect((await h.api('GET', '/api/robots/RB-01')).json.data.status).toBe('offline');
    // ao voltar, o mesmo dispositivo retoma de onde estava (mesma sessão)
    await sim.poll();
    expect((await h.api('GET', '/api/robots/RB-01')).json.data.status).toBe('busy');
  });

  it('comando vencido é expirado; load_route que nunca foi entregue encerra a missão sem movimento', async () => {
    h = await makeHarness({ oidcVerifier: oidc });
    await h.sim().boot();
    const r = await h.api('POST', '/api/robots/RB-01/route', {
      body: { waypoints: [{ x: 2, y: 1 }, { x: 3, y: 1 }] },
      idem: 'late',
    });
    const { missionId, commandId } = r.json.data;
    h.clock.advance(h.cfg.loadCommandTtlMs + 1000);
    const sweep = await post(h, '/internal/offline-check', 'sched');
    expect(sweep.json().data.expiredCommands).toBe(1);
    expect((await h.api('GET', `/api/commands/${commandId}`)).json.data).toMatchObject({ status: 'expired', reason: 'EXPIRED' });
    expect((await mission(h, missionId)).status).toBe('failed');
    expect(((await h.api('GET', '/api/robots/RB-01')).json.data.currentMissionId)).toBeUndefined();
  });

  it('o poll nunca entrega comando vencido', async () => {
    h = await makeHarness();
    const sim = h.sim();
    await sim.boot();
    await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 2, y: 1 }, { x: 3, y: 1 }] }, idem: 'v' });
    h.clock.advance(h.cfg.loadCommandTtlMs + 1000);
    await sim.poll();
    expect(sim.received).toHaveLength(0);
  });
});

describe('poll: custo e intervalo', () => {
  it('em repouso o poll não escreve no banco e o intervalo é longo; com missão é curto', async () => {
    h = await makeHarness();
    const sim = h.sim();
    await sim.boot();
    const spy = vi.spyOn(h.store, 'runTransaction');
    h.clock.advance(1000);
    const idle = await sim.poll();
    expect(spy).not.toHaveBeenCalled(); // contato recente e nada pendente: zero escritas
    expect(idle.nextPollMs).toBe(h.cfg.pollIdleMs);
    h.clock.advance(h.cfg.lastSeenWriteIdleMs + 1);
    await sim.poll();
    expect(spy).toHaveBeenCalledTimes(1); // em repouso, renova lastSeen só a cada ~2 min (cota de escrita)

    await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 2, y: 1 }, { x: 3, y: 1 }] }, idem: 'p' });
    const busy = await sim.poll();
    expect(busy.nextPollMs).toBe(h.cfg.pollActiveMs);
  });
});
