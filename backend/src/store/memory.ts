import { AlreadyExistsError } from '../errors.js';
import { BufferedTx, clean } from './buffered.js';
import type { Collection, Doc, Query, Store, Tx } from './types.js';

function getField(doc: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((acc, k) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[k];
    return undefined;
  }, doc);
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

export function matches(doc: Doc, filters: NonNullable<Query['filters']>): boolean {
  return filters.every((f) => {
    const v = getField(doc, f.field);
    switch (f.op) {
      case '==':
        return v === f.value;
      case '!=':
        return v !== f.value;
      case '<':
        return v !== undefined && v !== null && compare(v, f.value) < 0;
      case '<=':
        return v !== undefined && v !== null && compare(v, f.value) <= 0;
      case '>':
        return v !== undefined && v !== null && compare(v, f.value) > 0;
      case '>=':
        return v !== undefined && v !== null && compare(v, f.value) >= 0;
      case 'in':
        return Array.isArray(f.value) && f.value.includes(v);
    }
  });
}

/**
 * Store em memória. Transações são serializadas por um mutex (promise chain),
 * então duas criações concorrentes de missão nunca se intercalam.
 */
export class MemoryStore implements Store {
  readonly kind = 'memory' as const;
  private readonly data = new Map<string, Map<string, Doc>>();
  private chain: Promise<unknown> = Promise.resolve();

  private col(c: Collection): Map<string, Doc> {
    let m = this.data.get(c);
    if (!m) {
      m = new Map();
      this.data.set(c, m);
    }
    return m;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  async get<T extends Doc>(collection: Collection, id: string): Promise<T | undefined> {
    const d = this.col(collection).get(id);
    return d ? (clean(d) as T) : undefined;
  }

  async query<T extends Doc>(collection: Collection, q: Query): Promise<T[]> {
    let docs = [...this.col(collection).values()];
    if (q.filters?.length) docs = docs.filter((d) => matches(d, q.filters!));
    if (q.orderBy) {
      const { field, dir = 'asc' } = q.orderBy;
      const sign = dir === 'asc' ? 1 : -1;
      docs.sort((a, b) => sign * compare(getField(a, field), getField(b, field)) || sign * compare(a.id, b.id));
      if (q.startAfter) {
        const cur = q.startAfter;
        docs = docs.filter((d) => {
          const c = sign * compare(getField(d, field), cur.value) || sign * compare(d.id, cur.id);
          return c > 0;
        });
      }
    } else {
      docs.sort((a, b) => compare(a.id, b.id));
    }
    if (q.limit !== undefined) docs = docs.slice(0, q.limit);
    return docs.map((d) => clean(d) as T);
  }

  async count(collection: Collection, filters: NonNullable<Query['filters']> = []): Promise<number> {
    return [...this.col(collection).values()].filter((d) => matches(d, filters)).length;
  }

  set(collection: Collection, id: string, data: Doc): Promise<void> {
    return this.serial(async () => {
      this.col(collection).set(id, clean(data));
    });
  }

  createManyIfAbsent(collection: Collection, items: Doc[]): Promise<{ created: number; existing: number }> {
    return this.serial(async () => {
      let created = 0;
      let existing = 0;
      const col = this.col(collection);
      for (const item of items) {
        if (col.has(item.id)) existing++;
        else {
          col.set(item.id, clean(item));
          created++;
        }
      }
      return { created, existing };
    });
  }

  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const tx = new BufferedTx({ read: async (c, id) => this.col(c).get(id) });
      const result = await fn(tx);
      tx.flush(
        {
          create: (c, id, d) => {
            if (this.col(c).has(id)) throw new AlreadyExistsError(c, id);
            this.col(c).set(id, clean(d));
          },
          set: (c, id, d) => void this.col(c).set(id, clean(d)),
          update: (c, id, patch) => {
            const cur = this.col(c).get(id);
            if (!cur) throw new Error(`Documento inexistente para update: ${c}/${id}`);
            this.col(c).set(id, { ...cur, ...clean(patch) } as Doc);
          },
          delete: (c, id) => void this.col(c).delete(id),
        },
        (c, id) => this.col(c).has(id),
      );
      return result;
    });
  }

  async close(): Promise<void> {
    /* nada a liberar */
  }

  /** Apoio a testes e ao seed. */
  size(collection: Collection): number {
    return this.col(collection).size;
  }
}
