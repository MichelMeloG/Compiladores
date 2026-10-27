import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * O mock é a especificação executável: a suíte de contrato (a MESMA que o
 * backend real precisa passar) roda contra ele em todo `npm test`.
 */
describe('suíte de contrato contra o servidor mock', () => {
  let close: () => void = () => undefined;
  let port = 0;

  beforeAll(async () => {
    process.env.MOCK_NO_LISTEN = '1';
    const { server } = await import('../mock/server.js');
    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as AddressInfo).port;
    close = () => server.close();
  });

  afterAll(() => close());

  it('passa integralmente (leitura, rotas, dispositivo, mutações)', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'scripts/contract-test.ts',
          '--base-url',
          `http://127.0.0.1:${port}`,
          '--auth-token',
          'dev-token',
          '--viewer-token',
          'viewer-token',
          '--admin-token',
          'admin-token',
          '--internal-token',
          'internal-token',
          '--device-secret',
          'mock-device-secret',
          '--allow-mutations',
          '--json',
        ],
        { cwd: import.meta.dirname + '/..' }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', reject);
      child.on('close', () => (stdout ? resolve(stdout) : reject(new Error(stderr || 'sem saída'))));
    });

    const report = JSON.parse(out) as {
      passed: number;
      failed: number;
      skipped: number;
      results: Array<{ name: string; status: string; detail?: string }>;
    };
    const failures = report.results.filter((x) => x.status === 'fail');
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
    expect(report.passed).toBeGreaterThanOrEqual(56);
  }, 60_000);
});
