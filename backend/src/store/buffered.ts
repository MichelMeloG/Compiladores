import { AlreadyExistsError } from '../errors.js';
import type { Collection, Doc, Tx } from './types.js';

type Op =
  | { kind: 'create'; data: Doc }
  | { kind: 'set'; data: Doc }
  | { kind: 'update'; patch: Record<string, unknown> }
  | { kind: 'delete' };

export interface Reader {
  read(collection: Collection, id: string): Promise<Doc | undefined>;
}

/** Remove `undefined` e desacopla referências (Firestore rejeita undefined). */
export function clean<T>(value: T): T {
  if (value instanceof Date) return new Date(value.getTime()) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => clean(v)) as unknown as T;
  if (value && typeof value === 'object') {
    // Instâncias de classe (ex.: Timestamp do Firestore) não são "achatadas": ao regravar
    // um documento lido, `expireAt` continua sendo Timestamp e o TTL continua valendo.
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = clean(v);
    }
    return out as T;
  }
  return value;
}

export interface FlushOps {
  create(collection: Collection, id: string, data: Doc): void;
  set(collection: Collection, id: string, data: Doc): void;
  update(collection: Collection, id: string, patch: Record<string, unknown>): void;
  delete(collection: Collection, id: string): void;
}

/**
 * Transação com escritas em buffer e leitura-do-que-escrevi.
 * Mesma lógica para os dois stores: o que muda é só `Reader` e `flush`.
 */
export class BufferedTx implements Tx {
  private readonly ops = new Map<string, { collection: Collection; id: string; ops: Op[] }>();
  private readonly cache = new Map<string, Doc | undefined>();

  constructor(private readonly reader: Reader) {}

  private static key(c: Collection, id: string): string {
    return `${c}/${id}`;
  }

  private push(c: Collection, id: string, op: Op): void {
    const k = BufferedTx.key(c, id);
    const entry = this.ops.get(k) ?? { collection: c, id, ops: [] };
    entry.ops.push(op);
    this.ops.set(k, entry);
  }

  private static fold(base: Doc | undefined, ops: Op[]): Doc | undefined {
    let doc = base;
    for (const op of ops) {
      if (op.kind === 'create' || op.kind === 'set') doc = clean(op.data);
      else if (op.kind === 'update') doc = doc ? ({ ...doc, ...clean(op.patch) } as Doc) : doc;
      else doc = undefined;
    }
    return doc;
  }

  async get<T extends Doc>(collection: Collection, id: string): Promise<T | undefined> {
    const k = BufferedTx.key(collection, id);
    if (!this.cache.has(k)) this.cache.set(k, await this.reader.read(collection, id));
    const entry = this.ops.get(k);
    const doc = BufferedTx.fold(this.cache.get(k), entry?.ops ?? []);
    return doc ? (clean(doc) as T) : undefined;
  }

  create(collection: Collection, id: string, data: Doc): void {
    this.push(collection, id, { kind: 'create', data });
  }
  set(collection: Collection, id: string, data: Doc): void {
    this.push(collection, id, { kind: 'set', data });
  }
  update(collection: Collection, id: string, patch: Record<string, unknown>): void {
    this.push(collection, id, { kind: 'update', patch });
  }
  delete(collection: Collection, id: string): void {
    this.push(collection, id, { kind: 'delete' });
  }

  /**
   * Colapsa as operações por documento e entrega ao backend de armazenamento.
   * `exists` permite ao Memory validar create/update antes de aplicar qualquer escrita.
   */
  flush(out: FlushOps, exists?: (c: Collection, id: string) => boolean): void {
    // Validação prévia (tudo-ou-nada) quando o backend sabe responder `exists`.
    if (exists) {
      for (const { collection, id, ops } of this.ops.values()) {
        const first = ops[0] as Op;
        const present = exists(collection, id);
        if (first.kind === 'create' && present) throw new AlreadyExistsError(collection, id);
        if (first.kind === 'update' && !present) {
          throw new Error(`Documento inexistente para update: ${collection}/${id}`);
        }
      }
    }
    for (const { collection, id, ops } of this.ops.values()) {
      const first = ops[0] as Op;
      const last = ops[ops.length - 1] as Op;
      if (last.kind === 'delete') {
        out.delete(collection, id);
        continue;
      }
      let lastWrite = -1;
      for (let i = ops.length - 1; i >= 0; i--) {
        const k = (ops[i] as Op).kind;
        if (k === 'create' || k === 'set') {
          lastWrite = i;
          break;
        }
      }
      if (lastWrite >= 0) {
        const doc = BufferedTx.fold(undefined, ops.slice(lastWrite)) as Doc;
        if (first.kind === 'create' && lastWrite === 0 && ops.length >= 1) out.create(collection, id, doc);
        else if (first.kind === 'create') out.create(collection, id, BufferedTx.fold(undefined, ops) as Doc);
        else out.set(collection, id, doc);
      } else {
        const patch: Record<string, unknown> = {};
        for (const op of ops) if (op.kind === 'update') Object.assign(patch, clean(op.patch));
        out.update(collection, id, patch);
      }
    }
  }
}
