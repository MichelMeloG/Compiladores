import { afterEach, describe, expect, it } from 'vitest';
import { clean } from '../src/store/buffered.js';
import { isValidDocId } from '../src/store/types.js';
import { EspSim, SimHttpError } from '../tools/esp-sim/sim.js';
import { SECRETS, makeHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('clean(): preserva tipos que não são objetos planos', () => {
  it('Date é copiada e instâncias de classe (ex.: Timestamp) passam intactas', () => {
    class FakeTimestamp {
      constructor(public seconds: number) {}
    }
    const ts = new FakeTimestamp(10);
    const d = new Date('2026-01-01T00:00:00Z');
    const out = clean({ a: 1, gone: undefined, when: d, ttl: ts, nested: { x: [1, { y: undefined, z: 2 }] } });
    expect(out.ttl).toBe(ts);
    expect(out.when).toEqual(d);
    expect(out.when).not.toBe(d);
    expect(out).toEqual({ a: 1, when: d, ttl: ts, nested: { x: [1, { z: 2 }] } });
  });
});

describe('IDs vindos de fora nunca viram caminho inválido', () => {
  it('isValidDocId', () => {
    for (const ok of ['RB-01', 'RF-0112', 'a_b.c', 'evt-1']) expect(isValidDocId(ok)).toBe(true);
    for (const bad of ['', 'a/b', '.', '..', '__x__', 'x'.repeat(600)]) expect(isValidDocId(bad)).toBe(false);
  });

  it('sessionId com "/" no cabeçalho assinado é recusado (não compõe ID de documento)', async () => {
    h = await makeHarness();
    const sim = new EspSim({ deviceId: 'RB-01', secret: SECRETS['RB-01'], transport: h.transport, now: () => h!.clock.t });
    // força um sessionId malicioso: o simulador gera "boot-N-xxxx"; sobrescrevemos o cabeçalho assinado
    (sim as any).sessionId = 'boot/../../alerts/x';
    const req = sim.signedRaw('GET', '/device/poll', undefined, undefined, 1);
    const r = await h.app.inject({ method: 'GET', url: '/device/poll', headers: req.headers });
    expect(r.statusCode).toBe(401);
  });

  it('importação recusa id de evento com "/" ou "..", sem gravar nada', async () => {
    h = await makeHarness();
    const ev = (id: string) => ({ id, missionId: 'M', robotId: 'RB-01', timestamp: '2026-10-20T10:00:00.000Z', eventType: 'command', severity: 'info', message: 'x' });
    for (const id of ['a/b', '..', '__reservado__']) {
      const r = await h.api('POST', '/api/logs/import', { body: { events: [ev('ok-1'), ev(id)] } });
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('INVALID_BODY');
    }
    expect(h.store.size('events')).toBe(0);
  });

  it('GET com id estranho na URL é 404, não 500', async () => {
    h = await makeHarness();
    for (const id of ['..', '__x__', '%2e%2e']) {
      expect((await h.api('GET', `/api/missions/${id}`)).status).toBe(404);
    }
  });

  it('SimHttpError carrega status e corpo do envelope', async () => {
    h = await makeHarness();
    const sim = new EspSim({ deviceId: 'RB-01', secret: 'x'.repeat(32), transport: h.transport, now: () => h!.clock.t });
    const err = (await sim.boot().catch((e) => e)) as SimHttpError;
    expect(err).toBeInstanceOf(SimHttpError);
    expect(err.body).toMatchObject({ success: false, error: 'SIGNATURE_INVALID' });
  });
});

describe('proteção de custo e abuso', () => {
  it('/device/sensors fica desligado por padrão (produção)', async () => {
    h = await makeHarness({ env: { ENABLE_LEGACY_SENSORS: 'false' } });
    const r = await h.app.inject({ method: 'POST', url: '/device/sensors', headers: {
      'x-device-id': 'RB-01', authorization: `Bearer ${SECRETS['RB-01']}`,
    }, payload: { boot: 'b', sequence: 1, applied: 0, line: [0, 1, 0] } });
    expect(r.statusCode).toBe(404);
  });

  it('flood por IP vira 429 antes de autenticar ou ler o banco', async () => {
    h = await makeHarness({ env: { RATE_LIMIT_IP_PER_MIN: '5', RATE_LIMIT_AUTHFAIL_PER_MIN: '1000' } });
    let reads = 0;
    const original = h.store.get.bind(h.store);
    h.store.get = (async (...a: Parameters<typeof original>) => { reads++; return original(...a); }) as typeof h.store.get;
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await h.app.inject({ method: 'GET', url: '/device/poll', headers: { 'x-device-id': 'RB-01', 'x-signature': 'x' } });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 5).every((c) => c === 401)).toBe(true);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    expect(reads).toBeLessThanOrEqual(5);
  });

  it('falhas repetidas de assinatura bloqueiam o IP sem tocar no banco', async () => {
    h = await makeHarness({ env: { RATE_LIMIT_AUTHFAIL_PER_MIN: '3' } });
    let reads = 0;
    const original = h.store.get.bind(h.store);
    h.store.get = (async (...a: Parameters<typeof original>) => { reads++; return original(...a); }) as typeof h.store.get;
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await h.app.inject({ method: 'GET', url: '/device/poll', headers: { 'x-device-id': 'RB-01', 'x-signature': 'x' } });
      codes.push(r.statusCode);
    }
    expect(codes.filter((c) => c === 429).length).toBeGreaterThanOrEqual(4);
    expect(reads).toBeLessThanOrEqual(3);
  });
});
