import { DeviceCommandMessageSchema, aggregateMetrics, simulateActions, translateRoute } from '@roboflow/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RECURRENCE_THRESHOLD } from '../src/services/derive.js';
import { C } from '../src/store/types.js';
import { execution, expectContract, loadMission, makeHarness, mission, ROUTE_RB01, startMission, type Harness } from './helpers.js';

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

describe('fluxo completo: operador -> backend -> AGV (simulador)', () => {
  it('rota -> carga -> início -> execução -> concluída, com métricas coerentes', async () => {
    const sim = h.sim();
    await sim.boot();
    expect((await h.api('GET', '/api/robots/RB-01')).json.data.status).toBe('idle');

    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'k1' });
    expect(r.status).toBe(201);
    expectContract('submitRoute', r.json);
    expect(r.json.data).toMatchObject({ accepted: true, waypointCount: 4, actions: ['F', 'F', 'E'] });
    const { missionId, commandId } = r.json.data;

    // Carregar a fila NÃO inicia o movimento; só depois do poll do dispositivo.
    expect((await execution(h, missionId)).state).toBe('queued');
    await sim.poll();
    expect(sim.route?.actions).toEqual(['F', 'F', 'E']);
    expect(sim.state).toBe('ready');
    expect((await execution(h, missionId)).state).toBe('ready');
    const cmd = (await h.api('GET', `/api/commands/${commandId}`)).json;
    expectContract('getCommand', cmd);
    expect(cmd.data).toMatchObject({ type: 'load_route', status: 'accepted', attempts: 1 });

    // O comando entregue obedece ao protocolo.
    expect(DeviceCommandMessageSchema.safeParse(sim.received[0]).success).toBe(true);

    await startMission(h, sim, missionId);
    expect(sim.state).toBe('running');
    expect((await execution(h, missionId)).state).toBe('running');

    await sim.doAction();
    const mid = await execution(h, missionId);
    expect(mid).toMatchObject({ completedActions: 1, lastConfirmedNode: '3,1', expectedNode: '4,1', atNode: false });
    expectContract('getExecution', { success: true, data: mid });
    expect((await h.api('GET', '/api/robots/RB-01/route')).json.data.currentWaypointIndex).toBe(1);

    h.clock.advance(60_000);
    await sim.runToEnd();

    const done = await mission(h, missionId);
    expect(done.status).toBe('completed');
    expect(done.durationSeconds).toBeGreaterThanOrEqual(60);
    expect(done.events.map((e: any) => e.eventType)).toEqual(
      expect.arrayContaining(['mission_start', 'command', 'state_change', 'destination_reached', 'mission_end']),
    );
    expectContract('getMission', { success: true, data: done });

    // Robô liberado, posição final estimada e igual ao destino da rota.
    const robot = (await h.api('GET', '/api/robots/RB-01')).json.data;
    expect(robot).toMatchObject({ currentPoint: '4,0', status: 'idle' });
    expect(robot.currentMissionId).toBeUndefined();
    const route = (await h.api('GET', '/api/robots/RB-01/route')).json.data;
    expect(route).toMatchObject({ status: 'completed', currentWaypointIndex: 3 });

    // Ida e volta com a simulação de referência dos contratos.
    const t = translateRoute({ cols: 5, rows: 4, points: [{ x: 2, y: 2, kind: 'blocked' }] }, ROUTE_RB01, 'E');
    expect(simulateActions({ x: 2, y: 1 }, 'E', t.actions).path.at(-1)).toEqual({ x: 4, y: 0 });

    // Métricas (rollup pelo consumidor inline) coerentes com a missão.
    const m = (await h.api('GET', '/api/dashboard/metrics?period=all&robotId=RB-01')).json;
    expectContract('dashboardMetrics', m);
    expect(m.data).toMatchObject({ totalMissions: 1, completedMissions: 1, completionRate: 100, totalStops: 0 });
    expect(m.data.avgDurationSeconds).toBe(done.durationSeconds);
    const ref = aggregateMetrics([done], [], []);
    expect(m.data).toMatchObject({ totalMissions: ref.totalMissions, completedMissions: ref.completedMissions, completionRate: ref.completionRate });
    const fleet = (await h.api('GET', '/api/fleet/metrics?period=24h')).json;
    expectContract('fleetMetrics', fleet);
    expect(fleet.data.perRobot.find((x: any) => x.robotId === 'RB-01').completedMissions).toBe(1);
  });

  it('mesma Idempotency-Key e mesmo corpo devolve a mesma resposta; corpo diferente dá 409', async () => {
    const sim = h.sim();
    await sim.boot();
    const a = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'same' });
    const b = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'same' });
    expect(b.status).toBe(a.status);
    expect(b.json.data.missionId).toBe(a.json.data.missionId);
    expect(h.store.size(C.missions)).toBe(1);
    const c = await h.api('POST', '/api/robots/RB-01/route', {
      body: { waypoints: ROUTE_RB01.slice(0, 3) },
      idem: 'same',
    });
    expect(c.status).toBe(409);
    expect(c.json.error).toBe('CONFLICT_IDEMPOTENCY');
  });

  it('dois envios simultâneos: só um vence (uma missão ativa por robô)', async () => {
    await h.sim().boot();
    const [a, b] = await Promise.all([
      h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'x1' }),
      h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'x2' }),
    ]);
    const accepted = [a, b].filter((r) => r.json.data?.accepted === true);
    expect(accepted).toHaveLength(1);
    const refused = [a, b].find((r) => r.json.data?.accepted === false)!;
    expect(refused.status).toBe(200);
    expect(refused.json.data.message).toMatch(/já executa|aguarda/);
    expect(h.store.size(C.missions)).toBe(1);
  });

  it('dois starts simultâneos: um comando só, o outro recebe 409', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    const [a, b] = await Promise.all([
      h.api('POST', `/api/missions/${missionId}/start`, { body: {}, idem: 's1' }),
      h.api('POST', `/api/missions/${missionId}/start`, { body: {}, idem: 's2' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
  });
});

describe('recusas de negócio (200 accepted:false) e rotas inválidas (422)', () => {
  beforeEach(async () => {
    await h.sim().boot();
  });

  it('diagonal e salto sobre cruzamento => 422 ROUTE_INVALID', async () => {
    const diag = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 2, y: 1 }, { x: 3, y: 0 }] }, idem: 'd' });
    expect(diag.status).toBe(422);
    expect(diag.json).toMatchObject({ success: false, error: 'ROUTE_INVALID' });
    const jump = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 2, y: 1 }, { x: 4, y: 1 }] }, idem: 'j' });
    expect(jump.status).toBe(422);
    expect(jump.json.details.errors[0].code).toBe('STEP_JUMP');
    const blocked = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 2, y: 1 }, { x: 2, y: 2 }] }, idem: 'b' });
    expect(blocked.status).toBe(422);
    expect(h.store.size(C.missions)).toBe(0);
  });

  it('menos de dois pontos => 422 e sem rumo disponível => 422 HEADING_REQUIRED', async () => {
    const short = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 2, y: 1 }] }, idem: 's' });
    expect(short.status).toBe(422);
    await h.store.runTransaction(async (tx) => {
      const r = (await tx.get(C.robots, 'RB-01')) as any;
      tx.set(C.robots, 'RB-01', { ...r, heading: null });
    });
    const noHeading = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'h' });
    expect(noHeading.status).toBe(422);
    expect(noHeading.json.error).toBe('HEADING_REQUIRED');
  });

  it('marcha à ré (T) sem capacidade => 422 CAPABILITY_UNSUPPORTED, nunca substituída por outra manobra', async () => {
    // De (2,1) rumo E indo para oeste (1,1): rumo oposto => T.
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 2, y: 1 }, { x: 1, y: 1 }] }, idem: 't' });
    expect(r.status).toBe(422);
    expect(r.json.error).toBe('CAPABILITY_UNSUPPORTED');
    expect(r.json.details.errors[0].code).toBe('REVERSE_UNSUPPORTED');
    expect(r.json.details.actions).toEqual(['T']);
    expect(h.store.size(C.missions)).toBe(0);
  });

  it('o primeiro waypoint declara a posição inicial: divergência é aceita, avisada no evento e vira a posição do robô', async () => {
    const r = await h.api('POST', '/api/robots/RB-01/route', {
      body: { waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }], initialHeading: 'E' },
      idem: 'decl',
    });
    expect(r.json.data.accepted).toBe(true);
    const m = await mission(h, r.json.data.missionId);
    expect(m.events[0].message).toMatch(/difere da última conhecida \(2, 1\)/);
    const ex = await execution(h, r.json.data.missionId);
    expect(ex).toMatchObject({ lastConfirmedNode: '0,0', positionConfidence: 'confirmed' });
    expect((await h.api('GET', '/api/robots/RB-01')).json.data.currentPoint).toBe('0,0');
  });

  it('posição nunca conhecida: a declaração basta; POST /position confirma sem missão ativa', async () => {
    await h.store.runTransaction(async (tx) => {
      const r = (await tx.get(C.robots, 'RB-01')) as any;
      tx.set(C.robots, 'RB-01', { ...r, currentPoint: null, positionConfidence: 'unknown' });
    });
    const confirm = await h.api('POST', '/api/robots/RB-01/position', { body: { x: 2, y: 1, heading: 'E' } });
    expect(confirm.status).toBe(200);
    expect(confirm.json.data).toMatchObject({ currentPoint: '2,1', positionConfidence: 'confirmed' });
    const bad = await h.api('POST', '/api/robots/RB-01/position', { body: { x: 2, y: 2, heading: 'E' } }); // bloqueado
    expect(bad.status).toBe(422);
    const ok = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'u2' });
    expect(ok.json.data.accepted).toBe(true);
    expect((await execution(h, ok.json.data.missionId)).positionConfidence).toBe('confirmed');
    // com missão ativa não se reposiciona
    expect((await h.api('POST', '/api/robots/RB-01/position', { body: { x: 2, y: 1, heading: 'E' } })).status).toBe(409);
  });

  it('modo estrito (REQUIRE_CONFIRMED_POSITION): divergência e posição desconhecida são recusadas até confirmar', async () => {
    await h.close();
    h = await makeHarness({ env: { REQUIRE_CONFIRMED_POSITION: 'true' } });
    await h.sim().boot();
    const wrong = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }], initialHeading: 'E' }, idem: 'w' });
    expect(wrong.json.data).toMatchObject({ accepted: false });
    expect(wrong.json.data.message).toMatch(/robô está em \(2, 1\)/);
    await h.store.runTransaction(async (tx) => {
      const r = (await tx.get(C.robots, 'RB-01')) as any;
      tx.set(C.robots, 'RB-01', { ...r, positionConfidence: 'unknown' });
    });
    const unknown = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 's1' });
    expect(unknown.json.data.message).toMatch(/Confirme/);
    await h.api('POST', '/api/robots/RB-01/position', { body: { x: 2, y: 1, heading: 'E' } });
    expect((await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 's2' })).json.data.accepted).toBe(true);
  });

  it('robô offline recusa a rota', async () => {
    h.clock.advance(h.cfg.offlineAfterIdleMs + 1000); // em repouso o limiar é o longo
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'o' });
    expect(r.json.data).toMatchObject({ accepted: false });
    expect(r.json.data.message).toMatch(/offline/);
  });

  it('prévia não reserva o robô e informa divergência de posição', async () => {
    const p = await h.api('POST', '/api/robots/RB-01/route/preview', { body: { waypoints: ROUTE_RB01 } });
    expect(p.status).toBe(200);
    expectContract('previewRoute', p.json);
    expect(p.json.data).toMatchObject({ executable: true, actions: ['F', 'F', 'E'], finalHeading: 'N', startMismatch: false });
    expect(h.store.size(C.missions)).toBe(0);
    const bad = await h.api('POST', '/api/robots/RB-01/route/preview', { body: { waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } });
    expect(bad.json.data.startMismatch).toBe(true);
  });
});

describe('controle: start / stop / resume / abort', () => {
  it('start antes da fila aceita é 409; start sem conexão é 503', async () => {
    const sim = h.sim();
    await sim.boot();
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'a' });
    const id = r.json.data.missionId;
    const early = await h.api('POST', `/api/missions/${id}/start`, { body: {}, idem: 'e' });
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('CONFLICT_STATE');
    await sim.poll();
    h.clock.advance(h.cfg.offlineAfterMs + 1000);
    const offline = await h.api('POST', `/api/missions/${id}/start`, { body: {}, idem: 'f' });
    expect(offline.status).toBe(503);
    expect(offline.json.error).toBe('DEVICE_UNAVAILABLE');
  });

  it('controles exigem Idempotency-Key', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    const r = await h.api('POST', `/api/missions/${missionId}/start`, { body: {} });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const noKeyRoute = await h.api('POST', '/api/robots/RB-02/route', { body: { waypoints: ROUTE_RB01 } });
    expect(noKeyRoute.json.error).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('pedido de início só vira "running" depois do ack; resposta é 202 + commandId', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    const r = await h.api('POST', `/api/missions/${missionId}/start`, { body: {}, idem: 'st' });
    expect(r.status).toBe(202);
    expectContract('startMission', r.json);
    expect((await execution(h, missionId)).state).toBe('ready'); // ainda não confirmou
    expect((await execution(h, missionId)).pendingCommands).toHaveLength(1);
    await sim.poll();
    expect((await execution(h, missionId)).state).toBe('running');
    expect((await h.api('GET', `/api/commands/${r.json.data.commandId}`)).json.data.status).toBe('accepted');
  });

  it('obstáculo: uma parada por episódio, retomada exige o blockId atual', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.doAction();

    const blockId = await sim.block(['obstacle'], 12);
    sim.duplicateNextFlush();
    await sim.telemetry(12);
    let ex = await execution(h, missionId);
    expect(ex).toMatchObject({ state: 'blocked', blockId, blockReasons: ['obstacle'] });

    const m = await mission(h, missionId);
    expect(m).toMatchObject({ stopCount: 1, presenceStopCount: 1, status: 'in_progress' });
    expect(m.stopReasons).toEqual([{ reason: 'Presença detectada', count: 1 }]);
    const types = m.events.map((e: any) => e.eventType);
    expect(types.filter((t: string) => t === 'presence_detected')).toHaveLength(1);
    expect(types.filter((t: string) => t === 'stop_preventive')).toHaveLength(1);

    // bloqueio liberado no dispositivo NÃO retoma sozinho
    await sim.clearBlock();
    expect((await execution(h, missionId)).state).toBe('blocked');

    const stale = await h.api('POST', `/api/missions/${missionId}/resume`, { body: { blockId: 'block-antigo' }, idem: 'r0' });
    expect(stale.status).toBe(409);
    expect(stale.json.error).toBe('STALE_BLOCK');
    const ok = await h.api('POST', `/api/missions/${missionId}/resume`, { body: { blockId }, idem: 'r1' });
    expect(ok.status).toBe(202);
    expect((await execution(h, missionId)).state).toBe('blocked'); // ainda não confirmado
    await sim.poll();
    ex = await execution(h, missionId);
    expect(ex.state).toBe('running');
    expect((await mission(h, missionId)).events.some((e: any) => e.eventType === 'resume')).toBe(true);

    await sim.runToEnd();
    expect((await mission(h, missionId)).status).toBe('completed');
    // a mesma parada continua contada uma vez
    expect((await mission(h, missionId)).stopCount).toBe(1);
  });

  it('paradas recorrentes por presença geram alerta (idempotente)', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    for (let i = 0; i < RECURRENCE_THRESHOLD; i++) {
      const b = await sim.block(['obstacle']);
      await h.api('POST', `/api/missions/${missionId}/resume`, { body: { blockId: b }, idem: `rr${i}` });
      await sim.poll();
    }
    const alerts = (await h.api('GET', `/api/alerts?missionId=${missionId}`)).json.data;
    const rec = alerts.filter((a: any) => a.title.includes('recorrentes'));
    expect(rec).toHaveLength(1);
    expect(rec[0].occurrenceCount).toBe(RECURRENCE_THRESHOLD);
    expect(rec[0].acknowledged).toBe(false);
  });

  it('stop pausa e retomar volta a andar; abort descarta a fila e libera o robô', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.doAction();

    expect((await h.api('POST', `/api/missions/${missionId}/stop`, { body: {}, idem: 'sp' })).status).toBe(202);
    await sim.poll();
    expect(sim.state).toBe('paused');
    expect((await execution(h, missionId)).state).toBe('paused');
    // o índice não avança ao parar
    expect((await execution(h, missionId)).completedActions).toBe(1);

    await h.api('POST', `/api/missions/${missionId}/resume`, { body: { blockId: 'qualquer' }, idem: 'rs' });
    await sim.poll();
    expect(sim.state).toBe('running');

    await h.api('POST', `/api/missions/${missionId}/abort`, { body: {}, idem: 'ab' });
    await sim.poll();
    const m = await mission(h, missionId);
    expect(m.status).toBe('aborted');
    const robot = (await h.api('GET', '/api/robots/RB-01')).json.data;
    expect(robot.currentMissionId).toBeUndefined();
    // abortou em movimento: a posição passa a ser o último cruzamento confirmado, com confiança desconhecida
    const robot2 = (await h.api('GET', '/api/robots/RB-01')).json.data;
    expect(robot2.currentPoint).toBe('3,1');
    const again = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'n1' });
    expect(again.json.data.accepted).toBe(true); // o operador reposicionou e declarou (2,1)
    const note = (await mission(h, again.json.data.missionId)).events[0].message;
    expect(note).toMatch(/difere da última conhecida \(3, 1\)/);
  });

  it('abort de missão ainda não enviada cancela localmente (sem tocar o dispositivo)', async () => {
    const sim = h.sim();
    await sim.boot();
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'q' });
    const id = r.json.data.missionId;
    const ab = await h.api('POST', `/api/missions/${id}/abort`, { body: {}, idem: 'qa' });
    expect(ab.status).toBe(202);
    expect((await mission(h, id)).status).toBe('aborted');
    expect((await h.api('GET', `/api/commands/${ab.json.data.commandId}`)).json.data).toMatchObject({ status: 'accepted', reason: 'LOCAL_CANCEL' });
    // a posição segue confiável e o robô aceita nova rota
    const next = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'q2' });
    expect(next.json.data.accepted).toBe(true);
  });

  it('stop/abort SEM conexão: nunca "parado" — missão fica incerta até reconciliar', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    h.clock.advance(h.cfg.offlineAfterMs + 5000);
    const r = await h.api('POST', `/api/missions/${missionId}/stop`, { body: {}, idem: 'off' });
    expect(r.status).toBe(202);
    expect(r.json.data.status).toBe('pending');
    const m = await mission(h, missionId);
    expect(m.status).toBe('indeterminate');
    expect((await execution(h, missionId)).state).toBe('uncertain');
    // o dispositivo volta, recebe o stop e confirma: reconcilia para pausada
    await sim.poll();
    expect(sim.state).toBe('paused');
    expect((await execution(h, missionId)).state).toBe('paused');
  });
});

describe('sessão, reboot, duplicatas e lacunas', () => {
  it('reboot durante a missão: incerta, motores parados, sem retomada automática, alerta criado', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.doAction();

    h.clock.advance(5000); // o boot leva segundos; hello exige timestamp crescente
    const res = await sim.boot(); // novo boot = nova sessão
    expect(res.reconcileRequired).toBe(true);
    const ex = await execution(h, missionId);
    expect(ex).toMatchObject({ state: 'uncertain', positionConfidence: 'unknown' });
    expect((await h.api('GET', `/api/missions/${missionId}`)).json.data.status).toBe('indeterminate');
    expect(sim.state).toBe('ready'); // firmware não retoma sozinho
    const alerts = (await h.api('GET', `/api/alerts?missionId=${missionId}`)).json.data;
    expect(alerts.some((a: any) => a.title.includes('incerta'))).toBe(true);

    // a reserva é mantida: nova rota é recusada até encerrar/reconciliar
    const blocked = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'rb' });
    expect(blocked.json.data.accepted).toBe(false);

    // encerramento explícito (só administrador) sem inventar endedAt
    expect((await h.api('POST', `/api/missions/${missionId}/force-close`, { role: 'operator' })).status).toBe(403);
    const closed = await h.api('POST', `/api/missions/${missionId}/force-close`, { role: 'admin' });
    expect(closed.status).toBe(200);
    const m = await mission(h, missionId);
    expect(m.status).toBe('aborted');
    expect(m.endedAt).toBeUndefined();
    expect(m.durationSeconds).toBeNull();
  });

  it('reboot com a fila só carregada (ready): missão falha sem movimento; posição preservada', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    h.clock.advance(5000);
    await sim.boot();
    expect((await mission(h, missionId)).status).toBe('failed');
    const robot = (await h.api('GET', '/api/robots/RB-01')).json.data;
    expect(robot.currentPoint).toBe('2,1');
  });

  it('comando entregue à sessão antiga vira "uncertain" e ack tardio é recusado', async () => {
    const sim = h.sim();
    await sim.boot();
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'c' });
    const loadId = r.json.data.commandId;
    // entrega o load_route mas perde o ack (requisição perdida) e reinicia
    sim.dropNextFlush();
    await sim.poll();
    h.clock.advance(5000);
    await sim.boot();
    expect((await h.api('GET', `/api/commands/${loadId}`)).json.data.status).toBe('uncertain');
    expect((await mission(h, r.json.data.missionId)).status).toBe('failed');
  });

  it('eventos críticos perdidos são retransmitidos; duplicatas não alteram a posição', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);

    sim.dropNextFlush();
    await sim.doAction(); // action_completed(0) perdido: o simulador o retém
    expect((await execution(h, missionId)).completedActions).toBe(0);
    expect(sim.pendingCritical).toBeGreaterThan(0);

    sim.duplicateNextFlush();
    await sim.doAction(); // reenvia o retido + o novo, em lote duplicado
    expect((await execution(h, missionId)).completedActions).toBe(2);
    expect(sim.pendingCritical).toBe(0);
    expect((await mission(h, missionId)).events.filter((e: any) => e.eventType === 'command')).toHaveLength(2);
  });

  it('salto de índice nunca conclui: missão incerta e pedido de snapshot (resync)', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    sim.silentProgress(1); // o dispositivo andou 1 cruzamento sem avisar
    await sim.doAction(); // próximo evento chega com índice 2 (esperado 0)
    expect(sim.lastResponse.resync).toBe(true);
    expect((await execution(h, missionId)).state).toBe('uncertain');
  });

  it('reconciliação por snapshot adota o estado do dispositivo (nunca retoma sozinha)', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    sim.silentProgress(1);
    await sim.doAction(); // fica incerta
    await sim.runToEnd().catch(() => undefined);
    await sim.snapshot();
    const ex = await execution(h, missionId);
    expect(ex).toMatchObject({ state: 'completed', completedActions: 3 });
    expect((await h.api('GET', '/api/robots/RB-01')).json.data.currentPoint).toBe('4,0');
  });

  it('conclusão informada com contagem divergente não é aceita como sucesso', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    sim.silentProgress(3); // o firmware acredita ter terminado
    sim.state = 'finished' as never;
    (sim as any).queue('mission_completed', { ...(sim as any).mref(), completedActions: 3 });
    await sim.flush();
    expect((await execution(h, missionId)).state).toBe('uncertain');
    expect((await mission(h, missionId)).status).toBe('indeterminate');
  });

  it('falha crítica encerra a missão; falha comum só soma erro e gera alerta', async () => {
    const sim = h.sim();
    await sim.boot();
    const { missionId } = await loadMission(h, sim);
    await startMission(h, sim, missionId);
    await sim.fault('SENSOR_X', 'sensor com ruído', 'error');
    expect((await mission(h, missionId)).status).toBe('in_progress');
    expect((await mission(h, missionId)).errorCount).toBe(1);
    await sim.fault('MOTOR_STALL', 'motor travado', 'critical');
    const m = await mission(h, missionId);
    expect(m.status).toBe('failed');
    expect(m.errorCount).toBe(2);
    const alerts = (await h.api('GET', `/api/alerts?missionId=${missionId}`)).json.data;
    expect(alerts.map((a: any) => a.severity).sort()).toEqual(['critical', 'error']);
  });

  it('falha sem missão vira evento de diagnóstico do dispositivo, fora de /logs', async () => {
    const sim = h.sim();
    await sim.boot();
    await sim.fault('BOOT_WARN', 'calibração antiga', 'warning');
    const ev = (await h.api('GET', '/api/robots/RB-01/events')).json;
    expectContract('getRobotEvents', ev);
    expect(ev.data.some((e: any) => e.message === 'calibração antiga' && e.missionId === undefined)).toBe(true);
    const logs = (await h.api('GET', '/api/logs')).json.data;
    expect(logs.some((e: any) => e.message === 'calibração antiga')).toBe(false);
  });
});
