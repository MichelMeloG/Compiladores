/** Integra o C++ real do firmware com os contratos e o backend em memória.
 * Compile firmware/tests/bridge.cpp e defina FIRMWARE_TEST_BINARY (README do firmware).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { DeviceEventMessageSchema, HelloMessageSchema } from '@roboflow/contracts';
import { buildSignedHeaders } from '@roboflow/contracts/signing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeHarness, execution, SECRETS, type Harness } from './helpers.js';

class Firmware {
  process: ChildProcessWithoutNullStreams;
  waiting: ((v: any) => void)[] = [];
  constructor() {
    this.process = spawn(process.env.FIRMWARE_TEST_BINARY!, [], { windowsHide: true });
    createInterface({ input: this.process.stdout }).on('line', s => this.waiting.shift()?.(JSON.parse(s)));
    this.process.stderr.on('data', d => process.stderr.write(d));
  }
  call(v: any): Promise<any> {
    return new Promise(resolve => { this.waiting.push(resolve); this.process.stdin.write(`${JSON.stringify(v)}\n`); });
  }
  close() { this.process.kill(); }
}

describe.skipIf(!process.env.FIRMWARE_TEST_BINARY)('firmware C++ real', () => {
  let f: Firmware;
  let h: Harness;
  let reqSeq: number;
  let now: number;
  beforeEach(async () => { f = new Firmware(); h = await makeHarness(); reqSeq = 0; now = 1000; });
  afterEach(async () => { f.close(); await h.close(); });
  const call = (op: string, extra: any = {}) => f.call({ op, now, ...extra });
  const tick = (line = [0, 1, 0], distanceCm: number | null = 80, extra = {}) => {
    now += 10;
    return call('tick', { line, distanceCm, ...extra });
  };
  async function send(path: string, body?: any) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const method = body === undefined ? 'GET' : 'POST';
    const r = await h.app.inject({ method, url: path, payload: raw || undefined, headers: {
      'content-type': 'application/json',
      ...buildSignedHeaders(SECRETS['RB-01'], { deviceId: 'RB-01', sessionId: 'boot-native-1' },
        { method, path, timestamp: Math.floor(h.clock.t / 1000), sequence: ++reqSeq, body: raw }),
    } });
    expect(r.statusCode, r.body).toBe(200);
    const data = r.json().data;
    expect(data.rejected ?? []).toEqual([]);
    await call('sync', { ackedSequence: data.ackedSequence });
    if (data.resync) await call('resync');
    for (const command of data.commands) await call('command', { command });
    return data;
  }
  async function flush(telemetry = false) {
    const batch = await call('batch', { telemetry });
    expect(batch.bytes).toBeLessThanOrEqual(4096);
    for (const e of batch.events) expect(DeviceEventMessageSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
    if (batch.events.length) await send('/device/events', { events: batch.events });
    return batch.events;
  }
  async function load(points = [{ x: 2, y: 1 }, { x: 3, y: 1 }]) {
    await tick();
    const hello = (await call('hello')).hello;
    expect(HelloMessageSchema.safeParse(hello).success).toBe(true);
    await send('/device/hello', hello);
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: points, initialHeading: 'E' }, idem: 'load' });
    expect(r.status).toBe(201);
    const sync = await send('/device/poll');
    await flush();
    expect((await execution(h, r.json.data.missionId)).state).toBe('ready');
    return { missionId: r.json.data.missionId as string, load: sync.commands[0] };
  }
  async function start(missionId: string) {
    const r = await h.api('POST', `/api/missions/${missionId}/start`, { body: {}, idem: 'start' });
    expect(r.status).toBe(202);
    const s = await send('/device/poll');
    await flush();
    return s.commands[0];
  }
  async function segment() {
    for (let i = 0; i < 28; i++) await tick();
    for (let i = 0; i < 4; i++) await tick([1, 1, 1]);
  }

  it('carrega sem mover, ignora cruzamento inicial/ruído, conclui somente após chegada estável', async () => {
    const { missionId } = await load();
    expect(await tick()).toMatchObject({ left: 0, right: 0, state: 'ready' });
    await start(missionId);
    for (let i = 0; i < 30; i++) expect((await tick([1, 1, 1])).completed).toBe(0);
    for (let i = 0; i < 25; i++) await tick();
    expect((await tick([1, 0, 1])).completed).toBe(0);
    await tick();
    for (let i = 0; i < 4; i++) await tick([1, 1, 1]);
    expect(await call('batch')).toMatchObject({ state: 'finished', completed: 1, left: 0, right: 0 });
    await flush(true);
    expect((await execution(h, missionId)).state).toBe('completed');
  });

  it('ultrassônico opcional: sem eco/eco vencido anda, leitura próxima bloqueia, liberação exige resume', async () => {
    const { missionId } = await load();
    await tick([0, 1, 0], null);
    await start(missionId);
    expect(await tick([0, 1, 0], null)).toMatchObject({ state: 'running', left: 200, right: 200 });
    expect(await tick([0, 1, 0], 10, { ageMs: 500 })).toMatchObject({ state: 'running' });
    const blocked = await tick([0, 1, 0], 10);
    expect(blocked).toMatchObject({ state: 'blocked', left: 0, right: 0 });
    await flush(true);
    expect((await execution(h, missionId)).state).toBe('blocked');
    const cleared = await tick([0, 1, 0], null);
    expect(cleared.state).toBe('blocked');
    expect((await flush()).map((e: any) => e.type)).toContain('block_cleared');
    await h.api('POST', `/api/missions/${missionId}/resume`, { body: { blockId: blocked.blockId }, idem: 'resume' });
    await send('/device/poll'); await flush();
    expect(await tick([0, 1, 0], null)).toMatchObject({ state: 'running', left: 200 });
  });

  it('mantém críticos até ack e não repete start após reentrega', async () => {
    const { missionId } = await load();
    const command = await start(missionId);
    await segment();
    const batch1 = await call('batch');
    expect((await call('batch')).events).toEqual(batch1.events);
    await call('command', { command });
    expect((await tick()).state).toBe('finished');
    await flush();
    expect((await call('batch')).events).toEqual([]);
  });

  it('rejeita ré, comando vencido, sessão errada e revisão divergente', async () => {
    const { missionId, load: command } = await load();
    for (const [change, reason] of [
      [{ type: 'start', routeRevision: 2 }, 'INVALID_STATE'],
      [{ type: 'start', sessionId: 'boot-old' }, 'INVALID_SESSION'],
      [{ type: 'start', validForMs: 1 }, 'EXPIRED'],
    ] as const) {
      await call('command', { command: { ...command, ...change, messageId: `test-${reason}` }, receivedAt: now - 5 });
      const b = await call('batch');
      expect(b.events.at(-1).reason).toBe(reason);
      await call('sync', { ackedSequence: b.events.at(-1).sequence });
    }
    // Aborta a fila antes de testar uma carga incompatível.
    await h.api('POST', `/api/missions/${missionId}/abort`, { body: {}, idem: 'abort' });
    await send('/device/poll'); await flush();
    await call('command', { command: { ...command, messageId: 'reverse', actions: ['T'] } });
    expect((await call('batch')).events.at(-1).reason).toBe('UNSUPPORTED_ACTION');
  });

  it('perda de rede segura no próximo cruzamento e reconcilia para paused', async () => {
    const { missionId } = await load([{ x: 2, y: 1 }, { x: 3, y: 1 }, { x: 4, y: 1 }]);
    await start(missionId);
    // Inicia trecho perto do limite de 30 s de comunicação; timeout da ação é independente.
    now += 29900; await tick();
    await segment();
    expect(await call('batch')).toMatchObject({ state: 'paused', completed: 1, left: 0, right: 0 });
    await flush();
    expect((await execution(h, missionId)).state).toBe('paused');
  });

  it('curva exige perder linha antiga e reencontrar a saída', async () => {
    const { missionId } = await load([{ x: 2, y: 1 }, { x: 2, y: 0 }]);
    await start(missionId);
    for (let i = 0; i < 45; i++) await tick([0, 1, 0]);
    expect(await call('batch')).toMatchObject({ phase: 'aligning', completed: 0 });
    await tick([0, 0, 0]);
    for (let i = 0; i < 4; i++) await tick();
    expect((await call('batch')).phase).toBe('leaving_node');
    await segment(); await flush();
    expect((await execution(h, missionId)).state).toBe('completed');
  });

  it('timeout de curva para motores sem fabricar progresso', async () => {
    const { missionId } = await load([{ x: 2, y: 1 }, { x: 2, y: 0 }]);
    await start(missionId); await tick();
    now += 2700;
    expect(await tick()).toMatchObject({ state: 'fault', completed: 0, left: 0, right: 0 });
    expect((await flush()).some((e: any) => e.type === 'action_completed')).toBe(false);
    expect((await execution(h, missionId)).state).toBe('failed');
  });

  it('stop, resume de pausa e abort preservam o contrato e não reiniciam a ação', async () => {
    const { missionId } = await load();
    const startCommand = await start(missionId);
    for (let i = 0; i < 8; i++) await tick();
    await h.api('POST', `/api/missions/${missionId}/stop`, { body: {}, idem: 'stop' });
    await send('/device/poll'); await flush();
    expect(await tick()).toMatchObject({ state: 'paused', left: 0, completed: 0 });
    await call('command', { command: startCommand }); // reentrega antiga não desfaz a pausa
    expect((await tick()).state).toBe('paused');
    await flush();
    // ResumeRequestSchema exige blockId mesmo quando a pausa não tem bloqueio.
    const resume = await h.api('POST', `/api/missions/${missionId}/resume`, { body: { blockId: 'operator-pause' }, idem: 'resume' });
    expect(resume.status).toBe(202);
    await send('/device/poll'); await flush();
    expect(await tick()).toMatchObject({ state: 'running', completed: 0 });
    await h.api('POST', `/api/missions/${missionId}/abort`, { body: {}, idem: 'abort' });
    await send('/device/poll'); await flush();
    expect(await tick()).toMatchObject({ state: 'ready', left: 0, right: 0 });
    expect((await execution(h, missionId)).state).toBe('aborted');
  });

  it('perda de linha bloqueia e lotes grandes respeitam 16 eventos/4096 bytes', async () => {
    const { missionId } = await load();
    const c = await start(missionId);
    expect(await tick([0, 0, 0])).toMatchObject({ state: 'blocked', left: 0, completed: 0 });
    await flush(true);
    for (let i = 0; i < 22; i++) await call('command', { command: c });
    const batch = await call('batch', { telemetry: true });
    expect(batch.bytes).toBeLessThanOrEqual(4096);
    expect(batch.events.length).toBeLessThanOrEqual(16);
    expect(batch.events.length).toBeLessThan(batch.pending);
    while ((await call('batch')).pending) await flush();
    expect((await execution(h, missionId)).state).toBe('blocked');
  });
});
