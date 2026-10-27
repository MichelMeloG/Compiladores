import { describe, expect, it } from 'vitest';
import { AlreadyExistsError } from '../src/errors.js';
import { FirestoreStore } from '../src/store/firestore.js';
import { MemoryStore } from '../src/store/memory.js';
import { C, type Doc, type Store } from '../src/store/types.js';

/**
 * Teste de contrato do Store: a MESMA suíte roda contra o MemoryStore e, se
 * FIRESTORE_EMULATOR_HOST estiver definido, contra o emulador do Firestore
 * (`firebase emulators:start --only firestore`; ver DEV.md).
 */
async function firestoreStore(): Promise<Store> {
  const { getApps, initializeApp } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const app = getApps()[0] ?? initializeApp({ projectId: process.env['STORE_TEST_PROJECT'] ?? 'demo-roboflow-test' });
  const db = getFirestore(app);
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    /* já configurado */
  }
  return new FirestoreStore(db);
}

const suites: [string, () => Promise<Store>][] = [['MemoryStore', async () => new MemoryStore()]];
if (process.env['FIRESTORE_EMULATOR_HOST']) suites.push(['FirestoreStore (emulador)', firestoreStore]);
// Contra um projeto REAL (credenciais padrão do ambiente). Use só com o banco vazio e limpe depois:
// STORE_TEST_PROJECT=meu-projeto npm test -- store.contract
if (process.env['STORE_TEST_PROJECT']) suites.push(['FirestoreStore (projeto real)', firestoreStore]);

for (const [name, make] of suites) {
  describe(`Store: ${name}`, () => {
    // IDs únicos por execução: o emulador mantém dados entre execuções.
    const run = Math.random().toString(36).slice(2, 8);
    const id = (s: string) => `${run}-${s}`;
    const doc = (s: string, extra: Record<string, unknown> = {}): Doc => ({ id: id(s), ...extra });

    it('set/get faz ida e volta e descarta campos undefined', async () => {
      const s = await make();
      await s.set(C.robots, id('a'), doc('a', { name: 'x', gone: undefined, nested: { n: 1 } }));
      const got = await s.get<Doc>(C.robots, id('a'));
      expect(got).toEqual({ id: id('a'), name: 'x', nested: { n: 1 } });
      expect(await s.get(C.robots, id('missing'))).toBeUndefined();
    });

    it('create falha com AlreadyExistsError se o documento existir', async () => {
      const s = await make();
      await s.runTransaction(async (tx) => tx.create(C.idempotency, id('k'), doc('k', { v: 1 })));
      await expect(
        s.runTransaction(async (tx) => tx.create(C.idempotency, id('k'), doc('k', { v: 2 }))),
      ).rejects.toBeInstanceOf(AlreadyExistsError);
      expect((await s.get<Doc>(C.idempotency, id('k')))?.['v']).toBe(1);
    });

    it('transação que lança descarta todas as escritas (tudo-ou-nada)', async () => {
      const s = await make();
      await expect(
        s.runTransaction(async (tx) => {
          tx.set(C.missions, id('m1'), doc('m1'));
          tx.set(C.missions, id('m2'), doc('m2'));
          throw new Error('falha no meio');
        }),
      ).rejects.toThrow('falha no meio');
      expect(await s.get(C.missions, id('m1'))).toBeUndefined();
      expect(await s.get(C.missions, id('m2'))).toBeUndefined();
    });

    it('create que colide no commit não aplica as outras escritas da transação', async () => {
      const s = await make();
      await s.set(C.events, id('e1'), doc('e1'));
      await expect(
        s.runTransaction(async (tx) => {
          tx.set(C.events, id('e2'), doc('e2'));
          tx.create(C.events, id('e1'), doc('e1', { dup: true }));
        }),
      ).rejects.toBeInstanceOf(AlreadyExistsError);
      expect(await s.get(C.events, id('e2'))).toBeUndefined();
    });

    it('lê o que escreveu na própria transação e mescla update', async () => {
      const s = await make();
      await s.set(C.robots, id('r'), doc('r', { a: 1, b: 1 }));
      const seen = await s.runTransaction(async (tx) => {
        const before = await tx.get<Doc>(C.robots, id('r'));
        tx.update(C.robots, id('r'), { b: 2, c: 3 });
        const after = await tx.get<Doc>(C.robots, id('r'));
        tx.create(C.robots, id('new'), doc('new', { z: 1 }));
        const created = await tx.get<Doc>(C.robots, id('new'));
        return { before, after, created };
      });
      expect(seen.before).toMatchObject({ a: 1, b: 1 });
      expect(seen.after).toMatchObject({ a: 1, b: 2, c: 3 });
      expect(seen.created).toMatchObject({ z: 1 });
      expect(await s.get(C.robots, id('r'))).toMatchObject({ a: 1, b: 2, c: 3 });
    });

    it('update em documento inexistente falha no commit', async () => {
      const s = await make();
      await expect(s.runTransaction(async (tx) => tx.update(C.robots, id('ghost'), { a: 1 }))).rejects.toThrow();
    });

    it('delete remove o documento', async () => {
      const s = await make();
      await s.set(C.alerts, id('d'), doc('d'));
      await s.runTransaction(async (tx) => tx.delete(C.alerts, id('d')));
      expect(await s.get(C.alerts, id('d'))).toBeUndefined();
    });

    it('transações concorrentes são serializáveis (contador não perde incremento)', async () => {
      const s = await make();
      await s.set(C.robots, id('counter'), doc('counter', { n: 0 }));
      await Promise.all(
        Array.from({ length: 10 }, () =>
          s.runTransaction(async (tx) => {
            const d = (await tx.get<Doc>(C.robots, id('counter'))) as Doc & { n: number };
            tx.update(C.robots, id('counter'), { n: d.n + 1 });
          }),
        ),
      );
      expect((await s.get<Doc>(C.robots, id('counter')))?.['n']).toBe(10);
    });

    it('query: filtros, ordenação, limite e cursor paginam sem repetir nem pular (inclusive empates)', async () => {
      const s = await make();
      const tag = `q${run}`;
      const rows = Array.from({ length: 7 }, (_, i) => ({
        id: id(`row${i}`),
        tag,
        robotId: i % 2 ? 'A' : 'B',
        // empates deliberados no campo de ordenação
        startedAt: `2026-10-0${1 + Math.floor(i / 2)}T00:00:00.000Z`,
      }));
      for (const r of rows) await s.set(C.missions, r.id, r);

      const eq = await s.query<Doc>(C.missions, { filters: [{ field: 'tag', op: '==', value: tag }, { field: 'robotId', op: '==', value: 'A' }] });
      expect(eq).toHaveLength(3);
      const inn = await s.query<Doc>(C.missions, { filters: [{ field: 'tag', op: '==', value: tag }, { field: 'robotId', op: 'in', value: ['A'] }] });
      expect(inn).toHaveLength(3);
      const range = await s.query<Doc>(C.missions, {
        filters: [
          { field: 'tag', op: '==', value: tag },
          { field: 'startedAt', op: '>=', value: '2026-10-02T00:00:00.000Z' },
          { field: 'startedAt', op: '<', value: '2026-10-04T00:00:00.000Z' },
        ],
      });
      expect(range).toHaveLength(4);

      const seen: string[] = [];
      let cursor: { value: unknown; id: string } | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page = await s.query<Doc>(C.missions, {
          filters: [{ field: 'tag', op: '==', value: tag }],
          orderBy: { field: 'startedAt', dir: 'desc' },
          limit: 3,
          ...(cursor ? { startAfter: cursor } : {}),
        });
        if (page.length === 0) break;
        seen.push(...page.map((d) => d.id));
        const last = page[page.length - 1] as Doc;
        cursor = { value: last['startedAt'], id: last.id };
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      const dates = seen.map((sid) => rows.find((r) => r.id === sid)!.startedAt);
      expect([...dates].sort().reverse()).toEqual(dates);
    });

    it('createManyIfAbsent cria o que falta e nunca sobrescreve', async () => {
      const s = await make();
      await s.set(C.events, id('i1'), doc('i1', { v: 'original' }));
      const r = await s.createManyIfAbsent(C.events, [doc('i1', { v: 'novo' }), doc('i2'), doc('i3')]);
      expect(r).toEqual({ created: 2, existing: 1 });
      expect((await s.get<Doc>(C.events, id('i1')))?.['v']).toBe('original');
    });
  });
}
