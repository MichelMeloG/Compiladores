import { afterEach, describe, expect, it } from 'vitest';
import type { OperatorVerifier } from '../src/auth/operator.js';
import { C } from '../src/store/types.js';
import { EspSim, SimHttpError } from '../tools/esp-sim/sim.js';
import { SECRETS, ROUTE_RB01, makeHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const inject = (hh: Harness, req: { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body?: string }) =>
  hh.app.inject({ method: req.method, url: req.path, headers: req.headers, ...(req.body !== undefined ? { payload: req.body } : {}) });

describe('dispositivo: HMAC, replay, relógio e limites', () => {
  it('sem cabeçalhos de assinatura => 401 SIGNATURE_INVALID', async () => {
    h = await makeHarness();
    const r = await h.app.inject({ method: 'GET', url: '/device/poll' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('SIGNATURE_INVALID');
  });

  it('corpo adulterado depois de assinado é recusado', async () => {
    h = await makeHarness();
    const sim = h.sim();
    await sim.boot();
    const good = JSON.stringify({ events: [] });
    const tampered = JSON.stringify({ events: [{ ...{}, x: 1 }] });
    const r = await inject(h, sim.signedRaw('POST', '/device/events', good, tampered));
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('SIGNATURE_INVALID');
  });

  it('segredo errado é recusado e dispositivo desconhecido recebe a MESMA resposta (sem enumeração)', async () => {
    h = await makeHarness();
    const wrong = new EspSim({ deviceId: 'RB-01', secret: 'x'.repeat(32), transport: h.transport, now: () => h!.clock.t });
    const unknown = new EspSim({ deviceId: 'RB-99', secret: 'y'.repeat(32), transport: h.transport, now: () => h!.clock.t });
    const e1 = await wrong.boot().catch((e) => e as SimHttpError);
    const e2 = await unknown.boot().catch((e) => e as SimHttpError);
    expect(e1).toBeInstanceOf(SimHttpError);
    expect((e1 as SimHttpError).status).toBe(401);
    expect((e2 as SimHttpError).status).toBe(401);
    expect((e2 as SimHttpError).body).toEqual((e1 as SimHttpError).body);
    expect(await h.store.get(C.robots, 'RB-99')).toBeUndefined();
  });

  it('replay da mesma requisição (mesma X-Sequence) é recusado', async () => {
    h = await makeHarness();
    const sim = h.sim();
    await sim.boot();
    const req = sim.signedRaw('GET', '/device/poll', undefined, undefined, 1);
    const first = await inject(h, req);
    expect(first.statusCode).toBe(200);
    const second = await inject(h, req);
    expect(second.statusCode).toBe(401);
    expect(second.json().error).toBe('REPLAY_DETECTED');
  });

  it('timestamp fora da tolerância de relógio => 401 CLOCK_SKEW', async () => {
    h = await makeHarness();
    const skewed = new EspSim({ deviceId: 'RB-01', secret: SECRETS['RB-01'], transport: h.transport, now: () => h!.clock.t + 10 * 60_000 });
    const err = (await skewed.boot().catch((e) => e)) as SimHttpError;
    expect(err.status).toBe(401);
    expect(err.body.error).toBe('CLOCK_SKEW');
  });

  it('hello capturado e reenviado é recusado; hello velho depois de um novo também', async () => {
    h = await makeHarness();
    const sim = h.sim();
    await sim.boot();
    const hello = (sessionId: string, sequence: number) =>
      JSON.stringify({
        v: 1, type: 'hello', messageId: `h-${sequence}`, deviceId: 'RB-01', sessionId, sequence, uptimeMs: 10,
        firmwareVersion: 'x', protocolVersion: 1, capabilities: { supportsReverse: false, maxActions: 64, maxMessageBytes: 4096 }, state: 'ready',
      });
    // reconexão legítima na mesma sessão...
    const body = hello(sim.sessionId, 50);
    const captured = sim.signedRaw('POST', '/device/hello', body, body, 1);
    expect((await inject(h, captured)).statusCode).toBe(200);
    // ...e o mesmo pacote reenviado por um atacante é replay (X-Sequence já usada)
    const again = await inject(h, captured);
    expect(again.statusCode).toBe(401);
    expect(again.json().error).toBe('REPLAY_DETECTED');
  });

  it('um hello assinado antes do último aceito não derruba a sessão atual', async () => {
    h = await makeHarness();
    const old = new EspSim({ deviceId: 'RB-01', secret: SECRETS['RB-01'], transport: h.transport, now: () => h!.clock.t - 60_000 });
    await old.boot(); // hello da sessão antiga, assinado há 1 min
    const current = h.sim();
    await current.boot(); // hello mais novo
    const err = (await old.reconnect().catch((e) => e)) as SimHttpError; // reenvio do hello velho
    expect(err.status).toBe(401);
    expect(err.body.error).toBe('REPLAY_DETECTED');
    await current.poll(); // a sessão atual segue válida
  });

  it('corpo acima de 4 KB em /device/* => 413 PAYLOAD_TOO_LARGE', async () => {
    h = await makeHarness();
    const sim = h.sim();
    await sim.boot();
    const big = JSON.stringify({ events: [], pad: 'x'.repeat(5000) });
    const r = await inject(h, sim.signedRaw('POST', '/device/events', big, big));
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('PAYLOAD_TOO_LARGE');
  });

  it('poll com sessão antiga (já houve novo boot) => 409 CONFLICT_SESSION', async () => {
    h = await makeHarness();
    const old = h.sim();
    await old.boot();
    h.clock.advance(5000);
    const fresh = h.sim();
    await fresh.boot();
    const err = (await old.poll().catch((e) => e)) as SimHttpError;
    expect(err.status).toBe(409);
    expect(err.body.error).toBe('CONFLICT_SESSION');
  });

  it('eventos de outra sessão são rejeitados no lote, sem efeito', async () => {
    h = await makeHarness();
    const sim = h.sim();
    await sim.boot();
    const body = JSON.stringify({
      events: [{ v: 1, type: 'fault', messageId: 'm1', deviceId: 'RB-01', sessionId: 'outra', sequence: 1, uptimeMs: 1, code: 'X', message: 'y', severity: 'error' }],
    });
    const r = await inject(h, sim.signedRaw('POST', '/device/events', body, body));
    expect(r.statusCode).toBe(200);
    expect(r.json().data.rejected).toEqual([{ sequence: 1, reason: 'SESSION_MISMATCH' }]);
    expect(h.store.size(C.alerts)).toBe(0);
  });

  it('limite de requisições por dispositivo => 429', async () => {
    h = await makeHarness({ env: { RATE_LIMIT_DEVICE_PER_MIN: '5' } });
    const sim = h.sim();
    await sim.boot(); // 1
    for (let i = 0; i < 4; i++) await sim.poll(); // 2..5
    const err = (await sim.poll().catch((e) => e)) as SimHttpError;
    expect(err.status).toBe(429);
    expect(err.body.error).toBe('RATE_LIMITED');
  });

  it('o segredo antigo continua valendo durante a rotação (lista de segredos)', async () => {
    h = await makeHarness({ env: { DEVICE_SECRETS_JSON: JSON.stringify({ 'RB-01': ['novo-segredo-rb01-0123456789abc', SECRETS['RB-01']] }) } });
    await h.sim().boot(); // assina com o segredo antigo
  });
});

describe('operador: Firebase ID token, allowlist e papéis', () => {
  const verifier: OperatorVerifier = {
    async verify(token) {
      const t: Record<string, { uid: string; email?: string; emailVerified?: boolean; claims: Record<string, unknown> }> = {
        admin: { uid: 'u-admin', email: 'Admin@Ex.com', emailVerified: true, claims: { role: 'admin' } },
        op: { uid: 'u-op', email: 'op@ex.com', emailVerified: true, claims: { role: 'operator' } },
        viewer: { uid: 'u-v', email: 'v@ex.com', emailVerified: true, claims: { role: 'viewer' } },
        norole: { uid: 'u-n', email: 'v@ex.com', emailVerified: true, claims: {} },
        unverified: { uid: 'u-u', email: 'op@ex.com', emailVerified: false, claims: { role: 'operator' } },
        stranger: { uid: 'u-s', email: 'intruso@ex.com', emailVerified: true, claims: { role: 'admin' } },
        badrole: { uid: 'u-b', email: 'op@ex.com', emailVerified: true, claims: { role: 'superuser' } },
      };
      const hit = t[token];
      if (!hit) throw new Error('token inválido');
      return hit;
    },
  };
  const env = { AUTH_MODE: 'firebase', ALLOWED_OPERATOR_EMAILS: 'admin@ex.com,op@ex.com,v@ex.com' };

  it('sem token ou token inválido => 401; e-mail não verificado ou fora da lista => 403', async () => {
    h = await makeHarness({ env, operatorVerifier: verifier });
    const get = (token?: string) => h!.api('GET', '/api/robots', { ...(token ? { token } : {}), headers: { 'x-dev-role': '' } });
    expect((await get()).status).toBe(401);
    expect((await get('lixo')).status).toBe(401);
    expect((await get('unverified')).status).toBe(403);
    expect((await get('stranger')).status).toBe(403); // admin no token, mas fora da allowlist
    expect((await get('viewer')).status).toBe(200);
  });

  it('o cabeçalho x-dev-role é IGNORADO fora de AUTH_MODE=off', async () => {
    h = await makeHarness({ env, operatorVerifier: verifier });
    const r = await h.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem: 'k', token: 'viewer', role: 'admin' });
    expect(r.status).toBe(403);
  });

  it('allowlist vazia = ninguém entra (falha fechada)', async () => {
    h = await makeHarness({ env: { AUTH_MODE: 'firebase', ALLOWED_OPERATOR_EMAILS: '' }, operatorVerifier: verifier });
    expect((await h.api('GET', '/api/robots', { token: 'admin' })).status).toBe(403);
  });

  it('papéis: viewer só lê; operator comanda; só admin encerra à força; claim desconhecido vira viewer', async () => {
    h = await makeHarness({ env, operatorVerifier: verifier });
    await h.sim().boot();
    const route = (token: string, idem: string) =>
      h!.api('POST', '/api/robots/RB-01/route', { body: { waypoints: ROUTE_RB01 }, idem, token });
    expect((await route('viewer', 'a')).status).toBe(403);
    expect((await route('norole', 'b')).status).toBe(403);
    expect((await route('badrole', 'c')).status).toBe(403);
    const preview = await h.api('POST', '/api/robots/RB-01/route/preview', { body: { waypoints: ROUTE_RB01 }, token: 'viewer' });
    expect(preview.status).toBe(403);
    expect((await h.api('PATCH', '/api/alerts/x/acknowledge', { token: 'viewer' })).status).toBe(403);
    const ok = await route('op', 'd');
    expect(ok.status).toBe(201);
    expect(ok.json.data.accepted).toBe(true);
    const id = ok.json.data.missionId;
    expect((await h.api('POST', `/api/missions/${id}/force-close`, { token: 'op' })).status).toBe(403);
    // operator registra o uid de quem pediu
    const m = (await h.store.get(C.missions, id)) as { operatorUid?: string } | undefined;
    expect(m?.operatorUid).toBe('u-op');
  });

  it('limite de requisições por usuário => 429 com Retry-After', async () => {
    h = await makeHarness({ env: { RATE_LIMIT_USER_PER_MIN: '3' } });
    for (let i = 0; i < 3; i++) expect((await h.api('GET', '/api/robots')).status).toBe(200);
    const r = await h.api('GET', '/api/robots');
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('RATE_LIMITED');
    expect(r.headers['retry-after']).toBe('60');
  });
});

describe('HTTP: CORS, limites e erros', () => {
  it('CORS restrito à origem configurada; nunca "*"', async () => {
    h = await makeHarness();
    const ok = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/robots',
      headers: { origin: 'https://michelmelog.github.io', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,idempotency-key' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('https://michelmelog.github.io');
    expect(String(ok.headers['access-control-allow-headers']).toLowerCase()).toContain('idempotency-key');
    const evil = await h.app.inject({
      method: 'OPTIONS',
      url: '/api/robots',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sem CORS_ORIGINS nenhuma origem é liberada', async () => {
    h = await makeHarness({ env: { CORS_ORIGINS: '' } });
    const r = await h.app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://x.com' } });
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('importação acima de 2 MB => 413; JSON inválido => 400; rota inexistente => 404 no envelope', async () => {
    h = await makeHarness();
    const huge = JSON.stringify({ events: [{ pad: 'x'.repeat(2.2 * 1024 * 1024) }] });
    const big = await h.app.inject({ method: 'POST', url: '/api/logs/import', headers: { 'content-type': 'application/json', 'x-dev-role': 'admin' }, payload: huge });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('PAYLOAD_TOO_LARGE');
    const bad = await h.app.inject({ method: 'POST', url: '/api/logs/import', headers: { 'content-type': 'application/json', 'x-dev-role': 'admin' }, payload: '{nao-json' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ success: false, error: 'INVALID_BODY' });
    const nf = await h.api('GET', '/api/nao-existe');
    expect(nf.status).toBe(404);
    expect(nf.json).toMatchObject({ success: false, error: 'NOT_FOUND' });
  });

  it('erros internos não vazam detalhes', async () => {
    h = await makeHarness();
    h.store.get = async () => {
      throw new Error('segredo-interno-do-banco');
    };
    const r = await h.api('GET', '/api/robots/RB-01');
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.json)).not.toContain('segredo-interno');
    expect(r.json.error).toBe('INTERNAL');
  });
});
