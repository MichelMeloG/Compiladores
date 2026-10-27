import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, decodePushEnvelope, validateTarget } from '../src/logic.js';
import { createHandler } from '../src/handler.js';

const TARGET = 'projects/compiladores-512823/locations/us-central1/services/roboflow-api';

const envelope = (payload) => ({
  message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') },
});

test('decide: corta quando custo >= orçamento', () => {
  assert.equal(decide({ costAmount: 5, budgetAmount: 5 }).cut, true);
  assert.equal(decide({ costAmount: 7.5, budgetAmount: 5 }).cut, true);
});

test('decide: não corta abaixo do orçamento', () => {
  assert.equal(decide({ costAmount: 2.5, budgetAmount: 5 }).cut, false);
  assert.equal(decide({ costAmount: 0, budgetAmount: 5 }).cut, false);
});

test('decide: dado estranho nunca corta', () => {
  assert.equal(decide({}).cut, false);
  assert.equal(decide({ costAmount: 'x', budgetAmount: 5 }).cut, false);
  assert.equal(decide({ costAmount: 10, budgetAmount: 0 }).cut, false);
  assert.equal(decide(null).cut, false);
});

test('decodePushEnvelope: decodifica e rejeita lixo', () => {
  assert.deepEqual(decodePushEnvelope(envelope({ a: 1 })), { a: 1 });
  assert.throws(() => decodePushEnvelope({}));
  assert.throws(() => decodePushEnvelope({ message: { data: 'não-json' } }));
});

test('validateTarget: aceita o formato esperado e rejeita o resto', () => {
  assert.equal(validateTarget(TARGET), TARGET);
  assert.throws(() => validateTarget('projects/x/services/y'));
  assert.throws(() => validateTarget(undefined));
  assert.throws(() => validateTarget(`${TARGET}/../x`));
});

function makeFetch({ ingress = 'INGRESS_TRAFFIC_ALL', patchStatus = 200 } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body });
    if (!init.method) {
      return { ok: true, status: 200, json: async () => ({ ingress }) };
    }
    return { ok: patchStatus < 400, status: patchStatus, text: async () => 'erro', json: async () => ({}) };
  };
  return { fetchFn, calls };
}

test('handler: abaixo do orçamento não chama a API', async () => {
  const { fetchFn, calls } = makeFetch();
  const h = createHandler({ target: TARGET, dryRun: false, fetchFn, getToken: async () => 't' });
  const r = await h(envelope({ costAmount: 1, budgetAmount: 5 }));
  assert.equal(r.status, 204);
  assert.equal(calls.length, 0);
});

test('handler: orçamento atingido faz PATCH de ingress internal-only', async () => {
  const { fetchFn, calls } = makeFetch();
  const h = createHandler({ target: TARGET, dryRun: false, fetchFn, getToken: async () => 't' });
  const r = await h(envelope({ costAmount: 5, budgetAmount: 5 }));
  assert.equal(r.status, 204);
  const patch = calls.find((c) => c.method === 'PATCH');
  assert.ok(patch);
  assert.match(patch.url, /updateMask=ingress/);
  assert.deepEqual(JSON.parse(patch.body), { ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' });
});

test('handler: idempotente quando já bloqueado', async () => {
  const { fetchFn, calls } = makeFetch({ ingress: 'INGRESS_TRAFFIC_INTERNAL_ONLY' });
  const h = createHandler({ target: TARGET, dryRun: false, fetchFn, getToken: async () => 't' });
  const r = await h(envelope({ costAmount: 9, budgetAmount: 5 }));
  assert.equal(r.status, 204);
  assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
});

test('handler: dry-run não chama a API', async () => {
  const { fetchFn, calls } = makeFetch();
  const h = createHandler({ target: TARGET, dryRun: true, fetchFn, getToken: async () => 't' });
  const r = await h(envelope({ costAmount: 9, budgetAmount: 5 }));
  assert.equal(r.status, 204);
  assert.equal(calls.length, 0);
});

test('handler: falha da API devolve 500 para reentrega', async () => {
  const { fetchFn } = makeFetch({ patchStatus: 403 });
  const h = createHandler({ target: TARGET, dryRun: false, fetchFn, getToken: async () => 't' });
  const r = await h(envelope({ costAmount: 9, budgetAmount: 5 }));
  assert.equal(r.status, 500);
});

test('handler: mensagem ilegível é ignorada (204), sem reentrega infinita', async () => {
  const { fetchFn, calls } = makeFetch();
  const h = createHandler({ target: TARGET, dryRun: false, fetchFn, getToken: async () => 't' });
  const r = await h({ message: {} });
  assert.equal(r.status, 204);
  assert.equal(calls.length, 0);
});
