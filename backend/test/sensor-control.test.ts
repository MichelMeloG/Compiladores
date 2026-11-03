import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MotorOutputSchema, type MotorOutput } from '@roboflow/contracts';
import { C } from '../src/store/types.js';
import type { MissionDoc, RobotDoc } from '../src/domain/types.js';
import { makeHarness, SECRETS, type Harness } from './helpers.js';
import { buildApp } from '../src/server.js';

describe('ESP32 com sensores brutos e processamento no backend', () => {
  let h: Harness, sequence: number, applied: number;
  let boot: string;
  beforeEach(async () => { h = await makeHarness(); sequence = applied = 0; boot = 'boot-1'; });
  afterEach(async () => h.close());
  async function sample(line = [0, 1, 0], apply = true): Promise<MotorOutput> {
    h.clock.advance(50);
    const r = await h.app.inject({ method: 'POST', url: '/device/sensors', headers: {
      'x-device-id': 'RB-01', authorization: `Bearer ${SECRETS['RB-01']}`,
    }, payload: { line, boot, sequence: ++sequence, applied } });
    expect(r.statusCode, r.body).toBe(200);
    const output = MotorOutputSchema.parse(r.json().data);
    if (apply) applied = output.sequence;
    return output;
  }
  async function mission(points = [{ x: 2, y: 1 }, { x: 3, y: 1 }]) {
    await sample();
    const r = await h.api('POST', '/api/robots/RB-01/route', {
      body: { waypoints: points, initialHeading: 'E' }, idem: 'sensor-route',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const id = r.json.data.missionId as string;
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('ready');
    const start = await h.api('POST', `/api/missions/${id}/start`, { body: {}, idem: 'sensor-start' });
    expect(start.status).toBe(202);
    await sample(); await sample();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('running');
    return id;
  }
  async function segment() {
    for (let i = 0; i < 5; i++) await sample();
    for (let i = 0; i < 4; i++) await sample([1, 1, 1]);
  }

  it('sem rota para; exige credenciais e bits válidos', async () => {
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    const noAuth = await h.app.inject({ method: 'POST', url: '/device/sensors', payload: {} });
    expect(noAuth.statusCode).toBe(401);
    const bad = await h.app.inject({ method: 'POST', url: '/device/sensors', headers: {
      'x-device-id': 'RB-01', authorization: `Bearer ${SECRETS['RB-01']}`,
    }, payload: { line: [0, 2, 0], boot, sequence: 2, applied: 1 } });
    expect(bad.statusCode).toBe(400);
  });
  it('corrige a linha no backend e conclui a rota somente pelos sensores', async () => {
    const id = await mission();
    expect(await sample([1, 0, 0])).toMatchObject({ left: 75, right: 150 });
    expect(await sample([0, 0, 1])).toMatchObject({ left: 150, right: 75 });
    await segment();
    const m = await h.store.get<MissionDoc>(C.missions, id);
    expect(m).toMatchObject({ state: 'completed', completedActions: 1 });
    expect((await h.store.get<RobotDoc>(C.robots, 'RB-01'))?.currentPoint).toBe('3,1');
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
  });
  it('ignora o cruzamento inicial e ruído isolado, mesmo com muito tempo decorrido', async () => {
    await sample([1, 1, 1]);
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: {
      waypoints: [{ x: 2, y: 1 }, { x: 3, y: 1 }], initialHeading: 'E',
    }, idem: 'initial-crossing' });
    const id = r.json.data.missionId;
    await sample([1, 1, 1]);
    await h.api('POST', `/api/missions/${id}/start`, { body: {}, idem: 'start-crossing' });
    for (let i = 0; i < 20; i++) await sample([1, 1, 1]);
    expect((await h.store.get<MissionDoc>(C.missions, id))?.completedActions).toBe(0);
    for (let i = 0; i < 5; i++) await sample();
    await sample([1, 1, 1]); await sample();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.completedActions).toBe(0);
  });
  it('confirma start apenas depois de o ESP informar que aplicou a saída', async () => {
    await sample();
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: {
      waypoints: [{ x: 2, y: 1 }, { x: 3, y: 1 }], initialHeading: 'E',
    }, idem: 'lost-response' });
    const id = r.json.data.missionId;
    await sample();
    await h.api('POST', `/api/missions/${id}/start`, { body: {}, idem: 'lost-start' });
    await sample([0, 1, 0], false); await sample([0, 1, 0], false);
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('ready');
    await sample(); await sample();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('running');
  });
  it('stop recebe confirmação, mantém os motores parados e aceita retomada explícita', async () => {
    const id = await mission();
    await h.api('POST', `/api/missions/${id}/stop`, { body: {}, idem: 'sensor-stop' });
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('paused');
    const resume = await h.api('POST', `/api/missions/${id}/resume`, { body: { blockId: 'operator-pause' }, idem: 'sensor-resume' });
    expect(resume.status).toBe(202);
    await sample(); await sample();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('running');
  });
  it('perda da linha bloqueia; reencontrar a linha aguarda resume', async () => {
    const id = await mission();
    expect(await sample([0, 0, 0])).toMatchObject({ left: 0, right: 0 });
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('blocked');
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    const m = await h.store.get<MissionDoc>(C.missions, id);
    expect(m?.currentBlock?.cleared).toBe(true);
  });
  it('reinício e falha de comunicação não retomam a rota sozinhos', async () => {
    const id = await mission();
    h.clock.advance(1600);
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('paused');
    boot = 'boot-2'; sequence = applied = 0;
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('uncertain');
  });
  it('mantém o controle após trocar a instância do backend e recusa amostras antigas', async () => {
    const id = await mission();
    const second = await buildApp({ cfg: h.cfg, store: h.store, clock: h.clock.now, logger: false });
    try {
      h.clock.advance(50);
      const r = await second.app.inject({ method: 'POST', url: '/device/sensors', headers: {
        'x-device-id': 'RB-01', authorization: `Bearer ${SECRETS['RB-01']}`,
      }, payload: { line: [0, 1, 0], boot, sequence: ++sequence, applied } });
      expect(r.statusCode).toBe(200);
      expect(r.json().data).toMatchObject({ left: 150, right: 150 });
      applied = sequence;
    } finally { await second.app.close(); }
    await segment();
    const replay = await h.app.inject({ method: 'POST', url: '/device/sensors', headers: {
      'x-device-id': 'RB-01', authorization: `Bearer ${SECRETS['RB-01']}`,
    }, payload: { line: [1, 1, 1], boot, sequence: 1, applied: 0 } });
    expect(replay.statusCode).toBe(401);
    expect((await h.store.get<MissionDoc>(C.missions, id))?.completedActions).toBe(1);
  });
  it('curva à direita depende de abandonar a linha antiga e reencontrar a linha central', async () => {
    const id = await mission([{ x: 3, y: 1 }, { x: 3, y: 2 }]);
    for (let i = 0; i < 4; i++) await sample([1, 1, 1]);
    expect(await sample([0, 0, 0])).toMatchObject({ left: 150, right: -150 });
    for (let i = 0; i < 5; i++) await sample([0, 0, 0]);
    for (let i = 0; i < 5; i++) await sample();
    await segment();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('completed');
  });
  it('curva sem reencontrar a linha para e deixa a posição incerta', async () => {
    const id = await mission([{ x: 3, y: 1 }, { x: 3, y: 2 }]);
    for (let i = 0; i < 4; i++) await sample([1, 1, 1]);
    for (let i = 0; i < 51; i++) await sample([0, 0, 0]);
    expect(await sample([0, 0, 0])).toMatchObject({ left: 0, right: 0 });
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('uncertain');
  });
  it('abort só encerra a missão após a aplicação da saída parada', async () => {
    const id = await mission();
    const abort = await h.api('POST', `/api/missions/${id}/abort`, { body: {}, idem: 'sensor-abort' });
    expect(abort.status).toBe(202);
    expect(await sample()).toMatchObject({ left: 0, right: 0 });
    expect((await h.store.get<MissionDoc>(C.missions, id))?.active).toBe(true);
    await sample();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('aborted');
  });
  it('avança a lista no backend sem contar o mesmo cruzamento duas vezes', async () => {
    const id = await mission([{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }]);
    await segment();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.completedActions).toBe(1);
    for (let i = 0; i < 8; i++) await sample([1, 1, 1]);
    expect((await h.store.get<MissionDoc>(C.missions, id))?.completedActions).toBe(1);
    await segment();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('completed');
  });
  it('calcula a curva à esquerda no backend', async () => {
    const id = await mission([{ x: 3, y: 1 }, { x: 3, y: 0 }]);
    for (let i = 0; i < 4; i++) await sample([1, 1, 1]);
    expect(await sample([0, 0, 0])).toMatchObject({ left: -150, right: 150 });
    for (let i = 0; i < 5; i++) await sample([0, 0, 0]);
    for (let i = 0; i < 5; i++) await sample();
    await segment();
    expect((await h.store.get<MissionDoc>(C.missions, id))?.state).toBe('completed');
  });
  it('sensor preso no cruzamento para sem confirmar chegada por tempo', async () => {
    const id = await mission();
    for (let i = 0; i < 62; i++) await sample([1, 1, 1]);
    expect(await sample([1, 1, 1])).toMatchObject({ left: 0, right: 0 });
    expect(await h.store.get<MissionDoc>(C.missions, id)).toMatchObject({ state: 'uncertain', completedActions: 0 });
  });
});
