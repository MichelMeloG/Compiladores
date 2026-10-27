import type { Config } from '../config.js';
import { FirestoreStore } from './firestore.js';
import { MemoryStore } from './memory.js';
import type { Store } from './types.js';

/**
 * `STORE=firestore` usa as credenciais padrão do ambiente (no Cloud Run, a
 * service account `roboflow-api`; com FIRESTORE_EMULATOR_HOST, o emulador).
 */
export async function createStore(cfg: Pick<Config, 'store' | 'gcpProject'>): Promise<Store> {
  if (cfg.store === 'memory') return new MemoryStore();
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp({ projectId: cfg.gcpProject });
  const db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: true });
  return new FirestoreStore(db);
}
