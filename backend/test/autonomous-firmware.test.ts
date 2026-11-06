import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EspSim } from '../tools/esp-sim/sim.js';
import { C } from '../src/store/types.js';
import type { RobotDoc } from '../src/domain/types.js';
import { execution, loadMission, makeHarness, SECRETS, startMission, type Harness } from './helpers.js';

describe('firmware autônomo: rota local e comandos pela rede', () => {
  let h: Harness, esp: EspSim;
  beforeEach(async () => {
    h = await makeHarness();
    esp = new EspSim({ deviceId: 'RB-01', secret: SECRETS['RB-01'], transport: h.transport,
      now: () => h.clock.t, firmwareVersion: 'autonomo-1.0.0',
      capabilities: { supportsReverse: false, maxActions: 16, maxMessageBytes: 4096 } });
  });
  afterEach(async () => h.close());

  const sensorSample = () => h.app.inject({ method: 'POST', url: '/device/sensors',
    headers: { 'x-device-id': 'RB-01', authorization: `Bearer ${SECRETS['RB-01']}` },
    payload: { boot: 'sensor-boot', sequence: 1, applied: 0, line: [0, 1, 0] } });

  it('anuncia limites reais, aguarda start e não apresenta bateria fictícia', async () => {
    const hello = await esp.boot();
    expect(hello.nextPollMs).toBe(h.cfg.pollIdleAutonomoMs);
    expect(hello.limits).toEqual({ supportsReverse: false, maxActions: 16, maxMessageBytes: 4096 });
    const { missionId } = await loadMission(h, esp);
    expect(esp.state).toBe('ready');
    expect((await execution(h, missionId)).completedActions).toBe(0);
    const robot = (await h.api('GET', '/api/robots/RB-01')).json.data;
    expect(robot.batteryPercent).toBeNull();
    await startMission(h, esp, missionId);
    expect(esp.state).toBe('running');
  });

  it('executa F/D/E, retransmite sem duplicar progresso e conclui no nó final', async () => {
    await esp.boot();
    const route = await h.api('POST', '/api/robots/RB-01/route', { idem: 'fde', body: {
      initialHeading: 'E', waypoints: [{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 4, y: 2 }],
    } });
    expect(route.json.data.actions).toEqual(['F', 'D', 'E']);
    await esp.poll();
    await startMission(h, esp, route.json.data.missionId);
    esp.duplicateNextFlush(); await esp.doAction();
    expect((await execution(h, route.json.data.missionId)).completedActions).toBe(1);
    await esp.runToEnd();
    expect(await execution(h, route.json.data.missionId)).toMatchObject({ state: 'completed',
      completedActions: 3, lastConfirmedNode: '4,2' });
  });

  it('não deixa o endpoint antigo assumir uma missão com execução local', async () => {
    await esp.boot();
    const { missionId } = await loadMission(h, esp);
    expect((await sensorSample()).statusCode).toBe(409);
    expect((await h.store.get<RobotDoc>(C.robots, 'RB-01'))?.controller).toBe('local-route');
    expect((await execution(h, missionId)).state).toBe('ready');
  });

  it('permite migrar parado, mas recusa mudar uma missão do firmware original', async () => {
    expect((await sensorSample()).statusCode).toBe(200);
    await esp.boot();
    expect((await h.store.get<RobotDoc>(C.robots, 'RB-01'))?.sensorControl).toBeUndefined();
    // Volta ao original, parado, e cria uma missão para ele.
    expect((await sensorSample()).statusCode).toBe(200);
    const r = await h.api('POST', '/api/robots/RB-01/route', { idem: 'sensor-route', body: {
      initialHeading: 'E', waypoints: [{ x: 2, y: 1 }, { x: 3, y: 1 }],
    } });
    expect(r.status).toBe(201);
    // Documentos anteriores à integração ainda não possuem controller.
    await h.store.runTransaction(async tx => {
      const robot = (await tx.get<RobotDoc>(C.robots, 'RB-01'))!;
      delete robot.controller;
      tx.set(C.robots, robot.id, robot);
    });
    await expect(esp.boot()).rejects.toMatchObject({ status: 409 });
  });

  it('uma parada pode cancelar start ainda pendente, sem iniciar o carrinho', async () => {
    await esp.boot();
    const { missionId } = await loadMission(h, esp);
    const start = await h.api('POST', `/api/missions/${missionId}/start`, { body: {}, idem: 'pending-start' });
    const stop = await h.api('POST', `/api/missions/${missionId}/stop`, { body: {}, idem: 'stop-start' });
    expect(stop.status).toBe(202);
    expect((await h.api('GET', `/api/commands/${start.json.data.commandId}`)).json.data)
      .toMatchObject({ status: 'expired', reason: 'SUPERSEDED_BY_STOP' });
    await esp.poll();
    expect(esp.state).not.toBe('running');
    expect(esp.received.filter(c => c.type === 'start')).toHaveLength(0);
  });

  it('stop invalida resume pendente e a rede não retoma por conta própria', async () => {
    await esp.boot();
    const { missionId } = await loadMission(h, esp);
    await startMission(h, esp, missionId);
    const blockId = await esp.block(['line_lost'], null);
    await esp.clearBlock();
    const resume = await h.api('POST', `/api/missions/${missionId}/resume`, { body: { blockId }, idem: 'resume' });
    expect((await h.api('POST', `/api/missions/${missionId}/stop`, { body: {}, idem: 'stop-resume' })).status).toBe(202);
    await esp.poll();
    expect(esp.state).toBe('blocked');
    expect((await h.api('GET', `/api/commands/${resume.json.data.commandId}`)).json.data.status).toBe('expired');
  });

  it('rejeita ré que o sketch não executa', async () => {
    await esp.boot();
    const r = await h.api('POST', '/api/robots/RB-01/route/preview', { body: {
      initialHeading: 'E', waypoints: [{ x: 2, y: 1 }, { x: 1, y: 1 }],
    } });
    expect(r.json.data.executable).toBe(false);
    expect(r.json.data.errors[0].code).toBe('REVERSE_UNSUPPORTED');
  });

  it('pede reconciliação se o servidor perdeu a rota que o ESP ainda lembra', async () => {
    await esp.boot();
    const { missionId } = await loadMission(h, esp);
    await startMission(h, esp, missionId);
    await h.store.runTransaction(async tx => {
      tx.delete(C.missions, missionId);
      const robot = (await tx.get<RobotDoc>(C.robots, 'RB-01'))!;
      robot.activeMissionId = null; robot.currentRouteId = null;
      tx.set(C.robots, robot.id, robot);
    });
    expect((await esp.reconnect()).reconcileRequired).toBe(true);
  });
});
