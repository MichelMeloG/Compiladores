import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  ENDPOINTS,
  ERROR_HTTP_STATUS,
  ErrorCodeSchema,
  MISSION_TRANSITIONS,
  MissionStateSchema,
  POLL_MS,
  TERMINAL_STATES,
  buildError,
  buildPath,
  canTransition,
  deviceEventDocId,
  deviceStateToRoverState,
  isCriticalEvent,
  matchEndpoint,
  projectDeviceEvent,
  publicMissionStatus,
  type DeviceEventMessage,
  type Endpoint,
} from '../src/index.js';
import {
  buildSignedHeaders,
  sha256Hex,
  sign,
  stringToSign,
  verifyRequest,
} from '../src/signing.js';

describe('máquina de estados da missão', () => {
  it('cobre todos os estados e os terminais não têm saída', () => {
    for (const s of MissionStateSchema.options) expect(MISSION_TRANSITIONS[s]).toBeDefined();
    for (const s of TERMINAL_STATES) expect(MISSION_TRANSITIONS[s]).toEqual([]);
  });

  it('transições do README §8', () => {
    expect(canTransition('queued', 'loading')).toBe(true);
    expect(canTransition('loading', 'ready')).toBe(true);
    expect(canTransition('ready', 'running')).toBe(true);
    expect(canTransition('running', 'blocked')).toBe(true);
    expect(canTransition('blocked', 'running')).toBe(true);
    expect(canTransition('running', 'completed')).toBe(true);
  });

  it('extensões aprovadas: abort em movimento/carregamento e reconciliação do incerto', () => {
    expect(canTransition('running', 'aborted')).toBe(true);
    expect(canTransition('loading', 'aborted')).toBe(true);
    expect(canTransition('uncertain', 'completed')).toBe(true);
    expect(canTransition('uncertain', 'blocked')).toBe(true);
    // já existentes na reconciliação
    expect(canTransition('uncertain', 'paused')).toBe(true);
    expect(canTransition('uncertain', 'aborted')).toBe(true);
    expect(canTransition('uncertain', 'failed')).toBe(true);
  });

  it('o incerto jamais volta a running ou ready sozinho; terminais seguem fechados', () => {
    expect(canTransition('uncertain', 'running')).toBe(false);
    expect(canTransition('uncertain', 'ready')).toBe(false);
    expect(canTransition('uncertain', 'loading')).toBe(false);
    expect(canTransition('completed', 'aborted')).toBe(false);
    expect(canTransition('aborted', 'uncertain')).toBe(false);
    expect(canTransition('failed', 'running')).toBe(false);
    expect(canTransition('paused', 'blocked')).toBe(false);
    expect(canTransition('blocked', 'completed')).toBe(false);
  });

  it('transições proibidas', () => {
    expect(canTransition('queued', 'running')).toBe(false);
    expect(canTransition('ready', 'completed')).toBe(false);
    expect(canTransition('completed', 'running')).toBe(false);
    expect(canTransition('uncertain', 'running')).toBe(false); // sem retomada automática
    expect(canTransition('paused', 'completed')).toBe(false);
  });

  it('projeção pública', () => {
    expect(publicMissionStatus('queued')).toBe('in_progress');
    expect(publicMissionStatus('blocked')).toBe('in_progress');
    expect(publicMissionStatus('paused')).toBe('in_progress');
    expect(publicMissionStatus('uncertain')).toBe('indeterminate');
    expect(publicMissionStatus('aborted')).toBe('aborted');
    expect(publicMissionStatus('failed')).toBe('failed');
    expect(publicMissionStatus('completed')).toBe('completed');
  });

  it('estados ativos ocupam o dispositivo e os terminais não', () => {
    for (const s of TERMINAL_STATES) expect(ACTIVE_STATES).not.toContain(s);
    expect(ACTIVE_STATES).toContain('uncertain');
  });
});

describe('erros e registro de endpoints', () => {
  it('todo código de erro tem status HTTP', () => {
    for (const c of ErrorCodeSchema.options) expect(ERROR_HTTP_STATUS[c]).toBeGreaterThanOrEqual(400);
  });

  it('buildError produz o envelope esperado', () => {
    expect(buildError('NOT_FOUND', 'Robô RB-9 não encontrado.')).toEqual({
      success: false,
      message: 'Robô RB-9 não encontrado.',
      error: 'NOT_FOUND',
    });
  });

  it('IDs e (método, caminho) são únicos', () => {
    const ids = ENDPOINTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const keys = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cobre todos os endpoints do BACKEND_INTEGRATION.md', () => {
    const required = [
      'GET /api/health',
      'GET /api/robots',
      'GET /api/robots/:id',
      'GET /api/fleet/metrics',
      'GET /api/dashboard/metrics',
      'GET /api/missions',
      'GET /api/missions/:id',
      'GET /api/logs',
      'POST /api/logs/import',
      'GET /api/alerts',
      'PATCH /api/alerts/:id/acknowledge',
      'GET /api/robots/:id/grid',
      'GET /api/robots/:id/route',
      'POST /api/robots/:id/route',
      'POST /api/robots/:id/position',
      'POST /api/missions/:id/force-close',
    ];
    const have = new Set(ENDPOINTS.map((e) => `${e.method} ${e.path}`));
    for (const r of required) expect(have.has(r), r).toBe(true);
  });

  it('mutações de operador exigem Idempotency-Key e papel de escrita', () => {
    for (const e of ENDPOINTS as readonly Endpoint[]) {
      if (e.auth === 'operator' && e.method !== 'GET' && !['importLogs', 'previewRoute', 'acknowledgeAlert', 'confirmPosition', 'forceCloseMission'].includes(e.id)) {
        expect(e.idempotency, e.id).toBe('required');
      }
      if (e.auth === 'operator' && e.method !== 'GET') {
        expect(e.roles, e.id).not.toContain('viewer');
      }
    }
  });

  it('position (operador/admin) e force-close (somente admin)', () => {
    const pos = ENDPOINTS.find((e) => e.id === 'confirmPosition')!;
    const fc = ENDPOINTS.find((e) => e.id === 'forceCloseMission')!;
    expect(pos.roles).toEqual(['operator', 'admin']);
    expect(pos.errors).toContain('DEVICE_BUSY');
    expect(fc.roles).toEqual(['admin']);
    expect(fc.errors).toEqual(expect.arrayContaining(['CONFLICT_STATE', 'FORBIDDEN']));
    expect(ENDPOINTS).toHaveLength(30);
  });

  it('matchEndpoint resolve parâmetros e buildPath os recompõe', () => {
    const m = matchEndpoint('POST', '/api/missions/RF-0113/resume');
    expect(m?.endpoint.id).toBe('resumeMission');
    expect(m?.params).toEqual({ id: 'RF-0113' });
    expect(buildPath('/api/robots/:id/grid', { id: 'RB 01' })).toBe('/api/robots/RB%2001/grid');
    expect(matchEndpoint('GET', '/api/nada')).toBeNull();
  });
});

describe('assinatura HMAC do dispositivo', () => {
  const secret = 'segredo-de-teste-nao-usar-em-producao';
  const ids = { deviceId: 'RB-01', sessionId: 'boot-7' };
  const now = 1_790_000_000;
  const base = { method: 'POST', path: '/device/events', timestamp: now, sequence: 5, body: '{"events":[]}' };

  const headersLower = (h: Record<string, string>) =>
    Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

  it('assina e verifica', () => {
    const h = headersLower(buildSignedHeaders(secret, ids, base));
    const r = verifyRequest({ method: 'POST', path: '/device/events', headers: h, body: base.body, secret, nowSeconds: now });
    expect(r).toEqual({ ok: true, deviceId: 'RB-01', sessionId: 'boot-7', sequence: 5 });
  });

  it('string a assinar é estável e inclui o hash do corpo', () => {
    expect(stringToSign(base)).toBe(
      ['POST', '/device/events', String(now), '5', sha256Hex('{"events":[]}')].join('\n')
    );
    expect(sign(secret, base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('corpo adulterado, caminho ou segredo errado => SIGNATURE_INVALID', () => {
    const h = headersLower(buildSignedHeaders(secret, ids, base));
    const common = { headers: h, secret, nowSeconds: now, method: 'POST', path: '/device/events' };
    expect(verifyRequest({ ...common, body: '{"events":[1]}' })).toMatchObject({ ok: false, error: 'SIGNATURE_INVALID' });
    expect(verifyRequest({ ...common, path: '/device/hello', body: base.body })).toMatchObject({ ok: false, error: 'SIGNATURE_INVALID' });
    expect(verifyRequest({ ...common, secret: 'outro', body: base.body })).toMatchObject({ ok: false, error: 'SIGNATURE_INVALID' });
  });

  it('relógio fora da tolerância => CLOCK_SKEW', () => {
    const h = headersLower(buildSignedHeaders(secret, ids, base));
    const r = verifyRequest({ method: 'POST', path: '/device/events', headers: h, body: base.body, secret, nowSeconds: now + 61 });
    expect(r).toMatchObject({ ok: false, error: 'CLOCK_SKEW' });
    const ok = verifyRequest({ method: 'POST', path: '/device/events', headers: h, body: base.body, secret, nowSeconds: now + 60 });
    expect(ok.ok).toBe(true);
  });

  it('sequência repetida ou menor => REPLAY_DETECTED', () => {
    const h = headersLower(buildSignedHeaders(secret, ids, base));
    const args = { method: 'POST', path: '/device/events', headers: h, body: base.body, secret, nowSeconds: now };
    expect(verifyRequest({ ...args, lastAcceptedSequence: 5 })).toMatchObject({ ok: false, error: 'REPLAY_DETECTED' });
    expect(verifyRequest({ ...args, lastAcceptedSequence: 9 })).toMatchObject({ ok: false, error: 'REPLAY_DETECTED' });
    expect(verifyRequest({ ...args, lastAcceptedSequence: 4 }).ok).toBe(true);
  });

  it('cabeçalhos ausentes ou malformados => SIGNATURE_INVALID', () => {
    expect(verifyRequest({ method: 'GET', path: '/device/poll', headers: {}, secret, nowSeconds: now })).toMatchObject({ ok: false, error: 'SIGNATURE_INVALID' });
    const h = headersLower(buildSignedHeaders(secret, ids, { ...base, body: undefined }));
    h['x-sequence'] = 'abc';
    expect(verifyRequest({ method: 'POST', path: '/device/events', headers: h, secret, nowSeconds: now })).toMatchObject({ ok: false, error: 'SIGNATURE_INVALID' });
  });

  it('poll (GET sem corpo) assina com o hash da string vazia', () => {
    const input = { method: 'GET', path: '/device/poll', timestamp: now, sequence: 6 };
    const h = headersLower(buildSignedHeaders(secret, ids, input));
    expect(verifyRequest({ method: 'GET', path: '/device/poll', headers: h, secret, nowSeconds: now }).ok).toBe(true);
  });
});

describe('protocolo do dispositivo', () => {
  it('eventos críticos exigem confirmação; telemetria não', () => {
    for (const t of ['action_completed', 'mission_completed', 'block_started', 'block_cleared', 'fault', 'ack', 'reject', 'snapshot', 'hello']) {
      expect(isCriticalEvent(t), t).toBe(true);
    }
    expect(isCriticalEvent('telemetry')).toBe(false);
    expect(isCriticalEvent('action_started')).toBe(false);
  });

  it('ID determinístico de evento (dedupe por create())', () => {
    expect(deviceEventDocId('RB-01', 'boot-7', 33)).toBe('RB-01_boot-7_33');
  });

  it('intervalos de poll respeitam os limites do contrato', () => {
    expect(POLL_MS.activeMission).toBeGreaterThanOrEqual(POLL_MS.min);
    expect(POLL_MS.idle).toBeLessThanOrEqual(POLL_MS.max);
  });

  it('estado do firmware -> RoverState público', () => {
    expect(deviceStateToRoverState('running')).toBe('moving');
    expect(deviceStateToRoverState('blocked', ['obstacle'])).toBe('obstacle_hold');
    expect(deviceStateToRoverState('blocked', ['line_lost'])).toBe('stopped');
    expect(deviceStateToRoverState('finished')).toBe('completed');
    expect(deviceStateToRoverState('fault')).toBe('error');
    expect(deviceStateToRoverState('ready')).toBe('idle');
  });
});

describe('projeção de eventos do dispositivo -> enums públicos', () => {
  const up = { v: 1 as const, deviceId: 'RB-01', sessionId: 'boot-7', uptimeMs: 1000 };

  it('bloqueio por obstáculo gera presença + parada preventiva (uma parada)', () => {
    const e: DeviceEventMessage = { ...up, type: 'block_started', messageId: 'e1', sequence: 3, blockId: 'b1', reasons: ['obstacle', 'sensor_stale'], distanceCm: 18.2 };
    const out = projectDeviceEvent(e);
    expect(out.map((x) => x.eventType)).toEqual(['presence_detected', 'stop_preventive']);
    expect(out.filter((x) => x.eventType === 'stop_preventive')).toHaveLength(1);
  });

  it('bloqueio sem obstáculo só gera parada preventiva', () => {
    const e: DeviceEventMessage = { ...up, type: 'block_started', messageId: 'e1', sequence: 3, blockId: 'b1', reasons: ['line_lost'] };
    expect(projectDeviceEvent(e).map((x) => x.eventType)).toEqual(['stop_preventive']);
  });

  it('resume só quando o ack responde a um resume', () => {
    const ack: DeviceEventMessage = { ...up, type: 'ack', messageId: 'e2', sequence: 4, replyTo: 'c1', result: 'accepted' };
    expect(projectDeviceEvent(ack, { ackedCommandType: 'resume' })[0]?.eventType).toBe('resume');
    expect(projectDeviceEvent(ack, { ackedCommandType: 'load_route' })).toEqual([]);
  });

  it('conclusão gera destination_reached + mission_end; telemetria nada', () => {
    const done: DeviceEventMessage = { ...up, type: 'mission_completed', messageId: 'e3', sequence: 9, missionId: 'M', routeRevision: 1, completedActions: 6 };
    expect(projectDeviceEvent(done).map((x) => x.eventType)).toEqual(['destination_reached', 'mission_end']);
    const tele: DeviceEventMessage = { ...up, type: 'telemetry', messageId: 'e4', sequence: 10, state: 'running', line: [0, 1, 0], distanceCm: null, distanceValid: false, distanceAgeMs: null };
    expect(projectDeviceEvent(tele)).toEqual([]);
  });

  it('chegada intermediária vira state_change; a última é coberta por mission_completed', () => {
    const mid: DeviceEventMessage = { ...up, type: 'action_completed', messageId: 'e5', sequence: 11, missionId: 'M', routeRevision: 1, actionIndex: 2, expectedNode: '2,1' };
    expect(projectDeviceEvent(mid, { totalActions: 6 })[0]?.eventType).toBe('state_change');
    const last = { ...mid, actionIndex: 5 };
    expect(projectDeviceEvent(last, { totalActions: 6 })).toEqual([]);
  });

  it('falha vira error (ou warning) mantendo a severidade', () => {
    const f: DeviceEventMessage = { ...up, type: 'fault', messageId: 'e6', sequence: 12, code: 'ULTRASONIC_TIMEOUT', message: 'Sem eco', severity: 'critical' };
    expect(projectDeviceEvent(f)[0]).toMatchObject({ eventType: 'error', severity: 'critical' });
    expect(projectDeviceEvent({ ...f, severity: 'warning' })[0]).toMatchObject({ eventType: 'warning' });
  });
});
