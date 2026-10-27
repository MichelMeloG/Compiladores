/**
 * Camada de persistência. Duas implementações com a mesma semântica:
 * `MemoryStore` (dev/teste/mock) e `FirestoreStore` (produção).
 *
 * Regras que o domínio pode assumir:
 * - Todo documento tem `id` (string) dentro do próprio corpo.
 * - Datas são strings ISO 8601 UTC (ordem lexicográfica = ordem cronológica).
 * - `runTransaction` é serializável: leituras antes de escritas, escritas só
 *   aplicadas no commit, e a função pode ser reexecutada (sem efeitos externos).
 */

export type Doc = { id: string } & Record<string, unknown>;

export const C = {
  /** Robô + estado de runtime do dispositivo (um doc lido em todo poll). */
  robots: 'robots',
  routes: 'routes',
  missions: 'missions',
  commands: 'commands',
  /** LogEvent projetado (o que a UI lê). */
  events: 'events',
  /** Evento crítico bruto do dispositivo; ID determinístico = dedupe. TTL 30 dias. */
  deviceEvents: 'deviceEvents',
  alerts: 'alerts',
  rollups: 'rollups',
  idempotency: 'idempotency',
  counters: 'counters',
} as const;

/** Nome de coleção (pode ser caminho aninhado, ex.: `maps/pista-1/versions`). */
export type Collection = string;

/**
 * ID de documento aceito pelo Firestore e seguro para IDs vindos de fora:
 * sem "/", diferente de "." e "..", sem o padrão reservado `__*__`, até 512 bytes.
 */
export function isValidDocId(id: string): boolean {
  return (
    id.length > 0 &&
    Buffer.byteLength(id) <= 512 &&
    !id.includes('/') &&
    id !== '.' &&
    id !== '..' &&
    !/^__.*__$/.test(id)
  );
}

/** Mapas são imutáveis por versão: `maps/{mapId}/versions/{n}`. */
export const mapsCollection = (mapId: string): string => `maps/${mapId}/versions`;

export type FilterOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in';
export interface Filter {
  field: string;
  op: FilterOp;
  value: unknown;
}

export interface Cursor {
  value: unknown;
  id: string;
}

export interface Query {
  filters?: Filter[];
  orderBy?: { field: string; dir?: 'asc' | 'desc' };
  limit?: number;
  startAfter?: Cursor;
}

export interface Tx {
  get<T extends Doc>(collection: Collection, id: string): Promise<T | undefined>;
  /** Falha no commit com AlreadyExistsError se o documento já existir. */
  create(collection: Collection, id: string, data: Doc): void;
  set(collection: Collection, id: string, data: Doc): void;
  /** Mescla campos de primeiro nível. Falha no commit se o documento não existir. */
  update(collection: Collection, id: string, patch: Record<string, unknown>): void;
  delete(collection: Collection, id: string): void;
}

export interface Store {
  readonly kind: 'memory' | 'firestore';
  get<T extends Doc>(collection: Collection, id: string): Promise<T | undefined>;
  query<T extends Doc>(collection: Collection, q: Query): Promise<T[]>;
  /** Contagem agregada (Firestore: ~1 leitura por 1.000 entradas de índice). */
  count(collection: Collection, filters?: Filter[]): Promise<number>;
  set(collection: Collection, id: string, data: Doc): Promise<void>;
  /** Cria apenas o que não existe (importação). Nunca sobrescreve. */
  createManyIfAbsent(collection: Collection, items: Doc[]): Promise<{ created: number; existing: number }>;
  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
