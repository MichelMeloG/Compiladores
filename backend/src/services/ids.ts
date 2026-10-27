import { C, type Doc, type Tx } from '../store/types.js';

export type CounterName = 'mission' | 'route' | 'command';

const PREFIX: Record<CounterName, string> = { mission: 'RF', route: 'RT', command: 'cmd' };

interface CounterDoc extends Doc {
  next: number;
}

/**
 * Próximo ID sequencial legível (`RF-0113`, `RT-0042`, `cmd-0001`), dentro da
 * transação do chamador: custa 1 leitura + 1 escrita e serializa a criação
 * (docs/FIRESTORE_MODEL.md, coleção `counters`). IDs aleatórios seriam mais
 * baratos, mas o operador lê estes IDs na tela.
 */
export async function nextId(tx: Tx, name: CounterName): Promise<string> {
  const cur = await tx.get<CounterDoc>(C.counters, name);
  const n = cur?.next ?? 1;
  tx.set(C.counters, name, { id: name, next: n + 1 });
  return `${PREFIX[name]}-${String(n).padStart(4, '0')}`;
}

/** Garante que o contador esteja além de um número já usado (carga do seed). */
export function counterFloor(name: CounterName, used: number): CounterDoc {
  return { id: name, next: used + 1 };
}
