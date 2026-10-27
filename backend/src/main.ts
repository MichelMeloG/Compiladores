import { FirebaseVerifier } from './auth/operator.js';
import { GoogleOidcVerifier } from './auth/internal.js';
import { loadConfig } from './config.js';
import { buildApp } from './server.js';
import { isSeeded, seedStore } from './seed.js';
import { createStore } from './store/factory.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const store = await createStore(cfg);
  const { app, deps } = await buildApp({
    cfg,
    store,
    operatorVerifier: cfg.authMode === 'firebase' ? new FirebaseVerifier(cfg.gcpProject) : undefined,
    oidcVerifier: new GoogleOidcVerifier(),
  } as never);

  if (cfg.seedOnBoot && !(await isSeeded(deps))) {
    const r = await seedStore(deps, cfg.seedProfile);
    app.log.info({ ...r, profile: cfg.seedProfile }, 'seed aplicado');
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'encerrando');
    await app.close();
    await store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: '0.0.0.0', port: cfg.port });
}

main().catch((err: unknown) => {
  // Falha de configuração insegura/inválida: nunca inicia.
  console.error(JSON.stringify({ severity: 'CRITICAL', message: 'falha ao iniciar', error: String(err) }));
  process.exit(1);
});
