# ADR 0003 — Firestore nativo no lugar de banco relacional

- **Status:** aceito
- **Data:** 26/10/2026
- **Detalhe do modelo:** [docs/FIRESTORE_MODEL.md](../FIRESTORE_MODEL.md)

## Contexto

O objetivo é ficar na cota gratuita do GCP. Cloud SQL (e qualquer Postgres gerenciado) cobra desde que a instância existe. O backend em Cloud Run não guarda estado, então a persistência precisa ser externa e escalar a zero em custo.

Cotas do Firestore (edição Standard) confirmadas em 26/10/2026 em [cloud.google.com/firestore/pricing](https://cloud.google.com/firestore/pricing) e [docs.cloud.google.com/firestore/quotas](https://docs.cloud.google.com/firestore/quotas):

| Item | Cota gratuita |
|---|---|
| Armazenamento | 1 GiB |
| Leituras de documento | 50.000 por dia |
| Escritas | 20.000 por dia |
| Exclusões | 20.000 por dia |
| Saída de dados | 10 GiB por mês |
| Escopo | **um banco por projeto**; reinício diário à meia-noite do Pacífico |
| Observação | TTL, PITR, backup e restauração exigem faturamento habilitado |

## Decisão

Usar **Firestore em modo nativo, edição Standard, região `us-central1`**, um único banco `(default)`. A região de um banco **não pode ser alterada** depois de criado.

As garantias que o plano esperava de um banco relacional ficam assim:

| Garantia | Como no Firestore |
|---|---|
| Uma missão ativa por dispositivo | Transação sobre `devices/{id}`: lê `activeMissionId`, cria a missão e o comando e grava o novo `activeMissionId` na mesma transação. Duas criações simultâneas: a segunda reexecuta, vê o campo preenchido e recusa. |
| Criação de missão + ordem de envio atômicas | Mesma transação (limite de 500 escritas, usamos < 10). |
| Idempotência HTTP | Documento `idempotency/{sha256(escopo + chave)}` criado com `create()` dentro da transação; guarda hash do corpo e a resposta. Mesma chave e mesmo corpo devolve a resposta guardada; corpo diferente gera 409. TTL de 24 h. |
| Deduplicação de evento do dispositivo | Documento com **ID determinístico** `{deviceId}_{sessionId}_{sequence}` criado com `create()`. Se já existir, o evento é duplicata e nada é reaplicado. |
| Versões imutáveis de mapa e rota | Documentos por versão (`maps/{id}/versions/{n}`) que nunca são atualizados. A missão **embute uma cópia** da rota, dos nós esperados e da versão do mapa usados. |
| Ordem e contagem de ações | `completedActions` na missão, atualizado em transação que confere `actionIndex === completedActions`. |
| Agregações | **Rollups** por dia e por robô, mantidos por consumidor idempotente do Pub/Sub. O dashboard lê poucos documentos em vez de varrer missões e eventos. |

## Alternativas rejeitadas

- **Cloud SQL / AlloyDB:** custo fixo desde o primeiro minuto.
- **SQLite em disco do Cloud Run:** disco efêmero; perde dados e não serve a múltiplas instâncias.
- **BigQuery como banco operacional:** latência e custo por consulta inadequados; fica como destino opcional de análise.
- **Cloud Storage com JSON:** sem transações nem consultas.

## Consequências

- **O gargalo é a cota diária de leituras.** Telas não podem varrer coleções; listas têm `limit`, e métricas vêm de rollups (ver estimativas no modelo).
- Sem JOIN: dados que a UI precisa juntos ficam desnormalizados (ex.: nome do robô na missão).
- Consultas compostas exigem índices declarados (`firestore.indexes.json`).
- O Firestore não calcula mediana, mínimo e máximo; os rollups guardam as durações necessárias.
- Mudar de banco no futuro exige reescrever apenas a camada de repositório; os contratos (`@roboflow/contracts`) não mudam.
