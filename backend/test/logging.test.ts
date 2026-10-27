import { afterEach, describe, expect, it } from 'vitest';
import { loggerOptions, traceField } from '../src/lib/logging.js';
import { makeHarness, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('logging estruturado para o Cloud Logging', () => {
  it('traceField converte X-Cloud-Trace-Context e ignora valores inválidos', () => {
    const id = 'a'.repeat(32);
    expect(traceField(`${id}/123;o=1`, 'proj')).toEqual({ 'logging.googleapis.com/trace': `projects/proj/traces/${id}` });
    expect(traceField('curto/1', 'proj')).toEqual({});
    expect(traceField(undefined, 'proj')).toEqual({});
    expect(traceField(`${id}/1`, '')).toEqual({});
  });

  it('saída JSON com severity/message/timestamp, trace e labels; sem segredos', async () => {
    const lines: string[] = [];
    const stream = { write: (s: string) => void lines.push(s) };
    h = await makeHarness({
      env: { GCP_PROJECT: 'proj-x', LOG_LEVEL: 'info' },
      logger: { ...(loggerOptions({ logLevel: 'info' }) as object), stream },
    });
    const trace = 'b'.repeat(32);
    await h.api('GET', '/api/robots', { headers: { 'x-cloud-trace-context': `${trace}/9;o=1`, authorization: 'Bearer token-secreto-123' } });
    const sim = h.sim();
    await sim.boot();
    await h.api('GET', '/api/robots/NAO-EXISTE');

    const parsed = lines.map((l) => JSON.parse(l) as Record<string, any>);
    const req = parsed.find((l) => l['message'] === 'requisição' && l['path'] === '/api/robots')!;
    expect(req).toMatchObject({ severity: 'INFO', status: 200, method: 'GET' });
    expect(req['logging.googleapis.com/trace']).toBe(`projects/proj-x/traces/${trace}`);
    expect(req['timestamp']).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(req['level']).toBeUndefined();
    expect(req['msg']).toBeUndefined();

    const hello = parsed.find((l) => l['message'] === 'hello')!;
    expect(hello['logging.googleapis.com/labels']).toMatchObject({ deviceId: 'RB-01', sessionId: sim.sessionId });
    expect(hello['deviceId']).toBe('RB-01');

    const notFound = parsed.find((l) => l['status'] === 404)!;
    expect(notFound['severity']).toBe('WARNING');

    const text = lines.join('\n');
    expect(text).not.toContain('token-secreto-123');
    expect(text).not.toMatch(/x-signature/i);
  });
});
