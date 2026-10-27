import type { Firestore, Query as FsQuery, Transaction } from 'firebase-admin/firestore';
import { FieldPath } from 'firebase-admin/firestore';
import { AlreadyExistsError } from '../errors.js';
import { BufferedTx, clean } from './buffered.js';
import { isValidDocId, type Collection, type Doc, type Query, type Store, type Tx } from './types.js';

const ALREADY_EXISTS = 6; // gRPC status code

function isAlreadyExists(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === ALREADY_EXISTS;
}

/**
 * Implementação Firestore (modo nativo). Sem estado local: tudo no banco.
 * Contra o emulador funciona definindo FIRESTORE_EMULATOR_HOST.
 *
 * Observações de custo (cota gratuita): cada `get` é 1 leitura, cada
 * documento retornado por `query` é 1 leitura, cada escrita no commit é
 * 1 escrita. O domínio evita queries em caminhos quentes (poll usa só `get`).
 */
export class FirestoreStore implements Store {
  readonly kind = 'firestore' as const;

  constructor(private readonly db: Firestore) {}

  private ref(c: Collection, id: string) {
    return this.db.collection(c).doc(id);
  }

  async get<T extends Doc>(collection: Collection, id: string): Promise<T | undefined> {
    if (!isValidDocId(id)) return undefined; // ex.: GET /missions/.. não pode virar erro 500
    const snap = await this.ref(collection, id).get();
    return snap.exists ? (snap.data() as T) : undefined;
  }

  async query<T extends Doc>(collection: Collection, q: Query): Promise<T[]> {
    let ref: FsQuery = this.db.collection(collection);
    for (const f of q.filters ?? []) {
      ref = ref.where(f.field, f.op === 'in' ? 'in' : f.op, f.value);
    }
    if (q.orderBy) {
      const dir = q.orderBy.dir ?? 'asc';
      ref = ref.orderBy(q.orderBy.field, dir).orderBy(FieldPath.documentId(), dir);
      if (q.startAfter) ref = ref.startAfter(q.startAfter.value, q.startAfter.id);
    }
    if (q.limit !== undefined) ref = ref.limit(q.limit);
    const snap = await ref.get();
    return snap.docs.map((d) => d.data() as T);
  }

  async count(collection: Collection, filters: NonNullable<Query['filters']> = []): Promise<number> {
    let ref: FsQuery = this.db.collection(collection);
    for (const f of filters) ref = ref.where(f.field, f.op, f.value);
    const snap = await ref.count().get();
    return snap.data().count;
  }

  async set(collection: Collection, id: string, data: Doc): Promise<void> {
    await this.ref(collection, id).set(clean(data));
  }

  async createManyIfAbsent(collection: Collection, items: Doc[]): Promise<{ created: number; existing: number }> {
    const writer = this.db.bulkWriter();
    let created = 0;
    let existing = 0;
    writer.onWriteError((err) => {
      if (err.code === ALREADY_EXISTS) return false;
      return err.failedAttempts < 3;
    });
    const pending: Promise<void>[] = [];
    for (const item of items) {
      pending.push(
        writer.create(this.ref(collection, item.id), clean(item)).then(
          () => {
            created++;
          },
          (e: unknown) => {
            if (isAlreadyExists(e)) existing++;
            else throw e;
          },
        ),
      );
    }
    await writer.close();
    await Promise.all(pending);
    return { created, existing };
  }

  async runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.db.runTransaction(async (t: Transaction) => {
        const tx = new BufferedTx({
          read: async (c, id) => {
            if (!isValidDocId(id)) return undefined;
            const snap = await t.get(this.ref(c, id));
            return snap.exists ? (snap.data() as Doc) : undefined;
          },
        });
        const result = await fn(tx);
        tx.flush({
          create: (c, id, d) => void t.create(this.ref(c, id), clean(d)),
          set: (c, id, d) => void t.set(this.ref(c, id), clean(d)),
          update: (c, id, patch) => void t.update(this.ref(c, id), clean(patch)),
          delete: (c, id) => void t.delete(this.ref(c, id)),
        });
        return result;
      });
    } catch (err) {
      if (isAlreadyExists(err)) throw new AlreadyExistsError('unknown', 'unknown');
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.db.terminate();
  }
}
