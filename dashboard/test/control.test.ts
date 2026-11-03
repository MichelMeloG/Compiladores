import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { confirmPosition, getActiveRoute, previewRoute, submitRoute } from '../src/services/routesService';
import { controlMission } from '../src/services/controlService';
import type { ExecutionState } from '../src/types';

const originalFetch = globalThis.fetch;
let requests: { url: string; headers: Headers; body: any }[];
let status: number;
let response: unknown;
beforeEach(() => {
  requests = []; status = 200; response = {};
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify({ success: status < 400, data: response, message: 'Falha do servidor' }),
      { status, headers: { 'content-type': 'application/json' } });
  };
});
afterEach(() => { globalThis.fetch = originalFetch; });

test('rota envia orientação e uma chave de idempotência nova por intenção', async () => {
  const points = [{ x: 2, y: 1 }, { x: 3, y: 1 }];
  response = { accepted: true, missionId: 'RF-0001', commandId: 'cmd-0001', waypointCount: 2, routeId: 'RT-0001' };
  assert.equal((await submitRoute('RB-01', points, 'E')).missionId, 'RF-0001');
  await submitRoute('RB-01', points, 'E');
  assert.deepEqual(requests[0].body, { waypoints: points, initialHeading: 'E' });
  assert.ok(requests[0].headers.get('Idempotency-Key'));
  assert.notEqual(requests[0].headers.get('Idempotency-Key'), requests[1].headers.get('Idempotency-Key'));
});

test('somente 404 significa ausência de rota; erro de rede/servidor é apresentado', async () => {
  status = 404;
  assert.equal(await getActiveRoute('RB-01'), null);
  status = 503;
  await assert.rejects(getActiveRoute('RB-01'), /Falha do servidor/);
  globalThis.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(getActiveRoute('RB-01'), /Sem resposta/);
});

test('confirma posição e prévia usam os endpoints reais sem iniciar movimento', async () => {
  await confirmPosition('RB-01', { x: 2, y: 1 }, 'N');
  assert.deepEqual(requests[0].body, { x: 2, y: 1, heading: 'N' });
  response = { executable: false, actions: ['T'], errors: [{ message: 'Ré não suportada' }] };
  assert.equal((await previewRoute('RB-01', [{ x: 2, y: 1 }, { x: 2, y: 2 }], 'N')).executable, false);
  assert.match(requests[1].url, /route\/preview$/);
  assert.equal(requests.some(r => r.url.endsWith('/start')), false);
});

test('start/stop/resume/abort incluem a sessão e resume referencia o bloqueio atual', async () => {
  const execution = { missionId: 'RF-0001', sessionId: 'boot-1', blockId: 'block-7' } as ExecutionState;
  response = { commandId: 'cmd-0002' };
  for (const action of ['start', 'stop', 'resume', 'abort'] as const) await controlMission(execution, action);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests[2].body, { sessionId: 'boot-1', blockId: 'block-7' });
  assert.deepEqual(requests[1].body, { sessionId: 'boot-1' });
  for (const req of requests) assert.ok(req.headers.get('Idempotency-Key'));
  assert.equal(new Set(requests.map(r => r.headers.get('Idempotency-Key'))).size, 4);
});

test('pausa solicitada pelo operador usa a referência de retomada prevista no backend', async () => {
  await controlMission({ missionId: 'RF-1', sessionId: 'boot-1', blockId: null } as ExecutionState, 'resume');
  assert.equal(requests[0].body.blockId, 'operator-pause');
});

test('comando recusado não é apresentado como aplicado', async () => {
  status = 409;
  await assert.rejects(controlMission({ missionId: 'RF-1' } as ExecutionState, 'start'), /Falha do servidor/);
});
