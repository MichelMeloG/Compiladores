import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import type { OidcVerifier } from '../src/auth/internal.js';
import type { OperatorVerifier } from '../src/auth/operator.js';
import { loadConfig } from '../src/config.js';
import { seedStore } from '../src/seed.js';
import { buildApp } from '../src/server.js';
import { MemoryStore } from '../src/store/memory.js';

const run = promisify(execFile);
const contracts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts');
const tsxCli = join(contracts, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runner = join(contracts, 'scripts', 'contract-test.ts');
const available = existsSync(tsxCli) && existsSync(runner);

const SECRET = 'secret-rb02-0123456789abcdef0123';

const operators: OperatorVerifier = {
  async verify(token) {
    const t: Record<string, { uid: string; email: string; claims: Record<string, unknown> }> = {
      'tok-operator': { uid: 'u-op', email: 'op@ex.com', claims: { role: 'operator' } },
      'tok-viewer': { uid: 'u-v', email: 'v@ex.com', claims: { role: 'viewer' } },
    };
    const hit = t[token];
    if (!hit) throw new Error('token inválido');
    return { ...hit, emailVerified: true };
  },
};
const oidc: OidcVerifier = {
  async verify(token) {
    if (token !== 'tok-scheduler') throw new Error('token inválido');
    return { email: 'scheduler@ex.iam', emailVerified: true };
  },
};

/**
 * Porta de entrada do contrato: sobe o servidor de verdade (HTTP, autenticação
 * Firebase/OIDC simulada) e executa contra ele a suíte `contracts/scripts/contract-test.ts`,
 * a MESMA que roda no smoke de produção. Qualquer divergência de contrato quebra aqui.
 */
describe.skipIf(!available)('suíte de contrato (contracts) contra o servidor real', () => {
  it('todos os testes passam, inclusive autenticação, papéis e /internal', async () => {
    const cfg = loadConfig({
      STORE: 'memory',
      AUTH_MODE: 'firebase',
      ALLOWED_OPERATOR_EMAILS: 'op@ex.com,v@ex.com',
      DEVICE_SECRETS_JSON: JSON.stringify({ 'RB-02': SECRET }),
      CORS_ORIGINS: 'http://localhost:3000',
      INTERNAL_AUDIENCE: 'https://api.test',
      PUBSUB_PUSH_SA: 'pubsub@ex.iam',
      SCHEDULER_SA: 'scheduler@ex.iam',
      SEED_ON_BOOT: 'false',
      LOG_LEVEL: 'silent',
      RATE_LIMIT_USER_PER_MIN: '100000',
      RATE_LIMIT_DEVICE_PER_MIN: '100000',
    } as NodeJS.ProcessEnv);
    const store = new MemoryStore();
    const { app, deps } = await buildApp({ cfg, store, operatorVerifier: operators, oidcVerifier: oidc, logger: false });
    await seedStore(deps, 'demo');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;

    try {
      const { stdout } = await run(
        process.execPath,
        [
          tsxCli, runner,
          '--base-url', `http://127.0.0.1:${port}`,
          '--auth-token', 'tok-operator',
          '--viewer-token', 'tok-viewer',
          '--internal-token', 'tok-scheduler',
          '--device-secret', SECRET,
          '--device-id', 'RB-02',
          '--allow-mutations',
          '--json',
        ],
        { cwd: contracts, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
      ).catch((e: { stdout?: string; stderr?: string }) => {
        throw new Error(`Suíte de contrato falhou:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`);
      });
      const report = JSON.parse(stdout.slice(stdout.indexOf('{')));
      const failed = (report.results ?? []).filter((r: { status?: string; ok?: boolean }) => r.status === 'fail' || r.ok === false);
      console.info(`suíte de contrato: ${report.passed} passaram, ${report.failed} falharam, ${report.skipped} pulados`);
      expect(failed.map((r: { name: string }) => r.name)).toEqual([]);
      expect(report.failed ?? failed.length).toBe(0);
      expect(report.passed ?? 1).toBeGreaterThan(40);
    } finally {
      await app.close();
    }
  }, 150_000);
});
