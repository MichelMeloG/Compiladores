/**
 * Carrega o seed no store configurado (STORE=memory|firestore).
 *
 *   STORE=firestore GCP_PROJECT=compiladores-512823 npm run seed -- --profile clean
 *
 * `clean`: só mapas, robôs e contadores (o necessário para operar de verdade).
 * `demo` : também missões, eventos, alertas e rollups de exemplo (só para dev/demonstração).
 *
 * É idempotente: se já houver robôs, não faz nada (use --force para repopular;
 * documentos existentes com os mesmos IDs são sobrescritos). Com Firestore real
 * exige --yes, para evitar semear produção por engano.
 */
import { loadConfig } from '../src/config.js';
import { systemClock } from '../src/lib/ids.js';
import { isSeeded, seedStore, type SeedProfile } from '../src/seed.js';
import type { Deps } from '../src/services/common.js';
import { createStore } from '../src/store/factory.js';

const argv = process.argv.slice(2);
const opt = (n: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const profile = (opt('profile') ?? 'clean') as SeedProfile;

async function main(): Promise<void> {
  if (profile !== 'clean' && profile !== 'demo') throw new Error('--profile deve ser clean ou demo');
  const cfg = loadConfig({ ...process.env, AUTH_MODE: process.env['AUTH_MODE'] ?? 'off' });
  if (cfg.store === 'firestore' && !argv.includes('--yes')) {
    throw new Error(`Isto escreve no Firestore do projeto ${cfg.gcpProject}. Repita com --yes para confirmar.`);
  }
  if (cfg.store === 'firestore' && profile === 'demo' && !argv.includes('--allow-demo-in-firestore')) {
    throw new Error('O perfil demo escreve dados fictícios no Firestore. Use --allow-demo-in-firestore se for isso mesmo.');
  }
  const store = await createStore(cfg);
  const deps = { store, cfg, clock: systemClock, mapCache: new Map(), log: console as never, publisher: { publish: async () => undefined } } as unknown as Deps;
  if (!argv.includes('--force') && (await isSeeded(deps))) {
    console.log('Já existem robôs; nada a fazer (use --force para repopular).');
  } else {
    const r = await seedStore(deps, profile);
    console.log(`Seed "${profile}" aplicado: ${r.robots} robôs, ${r.missions} missões.`);
  }
  await store.close();
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
