# ADR 0008 — Um `start`/`resume` pendente por vez, por missão

- **Status:** aceito
- **Data:** 26/10/2026
- **Relacionado:** ADR 0002 (perda de comunicação), ADR 0005 (contrato de ordem)

## Contexto

`start` e `resume` fazem o AGV se mover. Com poll HTTPS (ADR 0001) o comando fica `pending` até o dispositivo buscá-lo e confirmar. Nesse intervalo, um clique repetido, uma segunda aba do operador ou um reenvio com outra `Idempotency-Key` poderia criar um segundo comando de movimento. Pior: depois de um `block_started`, um `resume` antigo e um novo poderiam ser entregues em sequência e liberar um bloqueio que o operador não viu.

A idempotência por chave protege o reenvio do **mesmo** pedido, mas não impede pedidos **diferentes** do mesmo tipo.

## Decisão

1. Para cada missão só pode existir **um comando `start` pendente e um `resume` pendente** por vez. Um segundo pedido do mesmo tipo, com chave diferente, recebe **409 `CONFLICT_STATE`** ("já existe um start/resume pendente").
2. Com a **mesma** `Idempotency-Key` e o mesmo corpo, o servidor devolve o mesmo `commandId` (202), como em qualquer comando.
3. A regra vale **só para movimento**. `stop` e `abort` **nunca** são bloqueados por um comando pendente: parar deve ser sempre possível.
4. O comando sai de `pending` por `accepted`, `rejected`, `expired` ou `uncertain`; só então um novo `start`/`resume` é aceito.
5. `resume` continua exigindo o `blockId` atual (`STALE_BLOCK` caso contrário) e a sessão observada (`CONFLICT_SESSION`).

Implementação: a verificação usa `devices/{id}.pendingCommandIds[]` (ver `docs/FIRESTORE_MODEL.md`) dentro da transação de controle, sem leitura extra.

## Consequências

- Duas abas ou um duplo clique não produzem dois movimentos; o segundo operador vê o 409 e o estado pendente em `GET /api/missions/:id/execution`.
- Um comando travado em `pending` bloqueia novos `start`/`resume` até expirar (30 s por padrão), o que é o comportamento seguro.
- A suíte de contrato cobre a regra (`start` repetido com outra chave → 409 `CONFLICT_STATE`) e o mock a implementa.
