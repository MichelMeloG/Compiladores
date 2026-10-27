# Lacunas, desvios e decisões do backend em relação aos contratos

Registro da Frente B (backend) sobre o que `@roboflow/contracts`, `docs/FIRESTORE_MODEL.md` e `infra/ENV_CONTRACT.md` não definem, ou onde a implementação escolheu diferente. Cada item diz **o que foi feito** e **quem decide**. Itens marcados ⚠ merecem atenção do coordenador.

## 1. Pontos em que a suíte de contrato obrigou a corrigir o backend

A suíte `contracts/scripts/contract-test.ts` (49 testes + 4 que exigem tokens) passa 100% contra o servidor local; ela encontrou, e o backend corrigiu:

- `/device/*` responde no envelope `{ success: true, data }` (a primeira versão devolvia o corpo cru).
- `period=custom` com `startDate == endDate` é um intervalo **vazio válido** (`[t, t)`), não erro; só `start > end` é `400 INVALID_QUERY`.
- Ré (`T`) sem suporte e fila acima da capacidade são `422 CAPABILITY_UNSUPPORTED` (não `200 accepted:false`), avaliadas **antes** do estado do robô.
- O primeiro waypoint da rota **declara** a posição inicial; divergência da última posição conhecida não recusa (ver §3.3).
- `hello` ocupa a sequência de eventos #1 da sessão e é confirmado em `ackedSequence`.

## 2. Contratos que o backend assume sem estarem escritos

| # | Assunção | Onde |
|---|---|---|
| 2.1 | **ADRs 0001–0005 não existiam** em `docs/adr` quando o backend foi escrito (só 0006 e 0007). O comportamento seguiu os comentários de `contracts/src/*.ts`. | — |
| 2.2 | `ackedSequence` = maior sequência de evento **crítico** processada, não "contígua": o firmware deve retransmitir os críticos pendentes do mais antigo ao mais novo **no mesmo lote**, e a telemetria (que pode ser descartada) não participa. Contiguidade estrita travaria a confirmação a cada amostra de telemetria substituída. | `services/device.ts` |
| 2.3 | `X-Sequence` é de **requisição** (anti-replay, instância-local, recuperada de `robot.lastRequestSeq` numa instância fria); a `sequence` do corpo é de **evento**. São contadores distintos. | `auth/device.ts` |
| 2.4 | Um `hello` com `X-Timestamp` anterior ao último `hello` aceito é recusado (`REPLAY_DETECTED`): impede que um hello velho capturado reponha uma sessão antiga. Não está no ADR 0005. | `services/device.ts` |
| 2.5 | `sessionId` do dispositivo só aceita `[A-Za-z0-9._:-]{1,128}` (compõe IDs de documento). Outros valores → `401 SIGNATURE_INVALID`. O firmware precisa respeitar. | `auth/device.ts` |
| 2.6 | Um **stop** aceito deixa a missão `paused`; o bloqueio de motivo `stop_requested` que o firmware pode emitir em seguida só registra `currentBlock`. `resume` exige o `blockId` quando há bloqueio registrado. | `services/device.ts` |
| 2.7 | `block_cleared` não retoma: a missão segue `blocked` até um `resume` aceito. | idem |
| 2.8 | `mission_completed` só conclui se `completedActions` do servidor e do evento forem iguais ao total; senão a missão vira `uncertain` e o servidor pede `snapshot` (`resync:true`). | idem |
| 2.9 | A telemetria **não** vira evento persistido; só sobrescreve `robots/{id}.live` (≤ 1 vez / 5 s ou mudança de estado/bloqueio). | idem |
| 2.10 | `fault` com severidade `critical` encerra a missão (`failed`); `error` só soma `errorCount` e gera alerta; `warning` gera evento sem alerta. | idem |

## 3. Extensões ao contrato (⚠ não estão em `ENDPOINTS`)

3.1 **Transições de estado extras** (a tabela de `mission.ts` não as prevê): `running → aborted`, `loading → aborted` (abort confirmado com o robô em movimento / durante o carregamento) e `uncertain → completed | blocked` (reconciliação por `snapshot`/`hello`). `domain/mission.ts`. **Decisão:** C — acrescentar à tabela ou aceitar o desvio.

3.2 **Endpoints novos**, fora do registro (por isso a suíte de contrato não os cobre; têm teste próprio):
- `POST /api/robots/:id/position` `{x,y,heading}` — operador confirma cruzamento e rumo com o robô sem missão ativa (`409 DEVICE_BUSY` com missão ativa).
- `POST /api/missions/:id/force-close` — só `admin`: encerra missão `uncertain` **sem** confirmação do dispositivo (estado `aborted`, sem `endedAt`, `durationSeconds:null`). Sem isso uma missão incerta e um robô desligado prenderiam a reserva para sempre.

3.3 ⚠ **Posição inicial.** O contrato não tem campo de "confirmo a posição" no envio da rota, e o runner assume que o primeiro waypoint declara onde o robô está (a prévia só avisa com `startMismatch`). Padrão adotado: **aceita**, registra no evento `mission_start` a divergência ("posição inicial declarada (x,y) difere da última conhecida (a,b)") e passa a posição para `confirmed`. `REQUIRE_CONFIRMED_POSITION=true` ativa o modo estrito (recusa divergência e posição `unknown` até `POST …/position`). **Recomendação:** ligar o modo estrito quando a dashboard tiver a tela de confirmação (FE-030); sem ela o operador ficaria preso. **Decisão:** coordenador.

3.4 ⚠ **`Idempotency-Key` é obrigatória** em `POST /robots/:id/route` e nos 4 controles (como no registro). A dashboard atual **não envia** o cabeçalho (FE-023): até o front enviá-lo, o envio de rota responde `400 IDEMPOTENCY_KEY_REQUIRED`. Foi mantido por contrato.

3.5 Recusas de negócio guardadas pela idempotência: a resposta `accepted:false` também fica associada à chave (reenviar com a mesma chave devolve a mesma recusa). Para tentar de novo depois de corrigir o problema, o cliente usa **outra chave**.

3.6 `GET /api/health` (contrato, lê robôs) e `GET /health` (sonda, sem banco) coexistem.

3.7 `Cache-Control: private, max-age=5` só em métricas, listas de missões/logs, grade e eventos do robô; o resto é `no-store`. (`FIRESTORE_MODEL.md` §6.2 pede `max-age=5` nos GETs de leitura; estado operacional não pode ficar velho.)

## 4. Desvios de `docs/FIRESTORE_MODEL.md`

| Modelo | Implementado | Motivo |
|---|---|---|
| `robots/{id}` (público) **e** `devices/{id}` (runtime) | **um** documento `robots/{id}` com campos públicos + runtime (`sessionId`, `lastRequestSeq`, `ackedSeq`, `activeMissionId`, `pendingCommandIds`, `live`…) | Cada poll lê 1 documento de qualquer forma; separar exigiria 2 leituras em `GET /robots` e 2 escritas a cada mudança. `status`/`roverState` são **derivados na leitura** (não gravados). |
| `missions.snapshot {…}` aninhado | campos planos (`waypoints`, `actions`, `expectedNodes`…) | simplicidade das transações; documentos internos |
| `deviceEvents/{id}.processed` | sem `processed` | O consumidor é idempotente pelo **estado** (`mission.rolledUp`, IDs de alerta determinísticos), não por marca. |
| `rollups/{robotId}_{yyyymmdd}` e `_all` | igual; acrescenta `scope` (`day`/`all`) e `day` | filtros de consulta sem `startsWith` |
| `events.source ∈ {device,import,system}` | igual | — |
| `counters/{name}` | `mission` (RF-), `route` (RT-), `command` (cmd-) | criação de missão serializa pelos contadores (aceito; 1 operador) |
| `maps/{mapId}/versions/{n}` | igual (coleção aninhada) | — |
| `alerts` com `activeAlertsCount` mantido no robô | **`count()` agregado** por robô (1 leitura / 1.000 entradas) | evita contador duplicado e divergente |
| lista de robôs em cache de 30 s | **sem** cache (robôs); só mapas (imutáveis) | `status` e `busy` precisam ser atuais |
| `lastSeenAt` a cada 120 s | 10 s **com missão**, 120 s em repouso; limiar de offline 45 s / 180 s | offline preciso durante a missão sem estourar a cota em repouso |

**Para a infra (`firestore.tf`):** índices e TTL estão em [`firestore.indexes.json`](firestore.indexes.json). TTL em `expireAt` (**Timestamp**) nas coleções `idempotency` (24 h), `deviceEvents` (30 d), `commands` (8 d desde a criação) e `events` (180 d). Os rollups e o `FirestoreStore` **não** foram testados contra Firestore real (ver `DEV.md`).

## 5. Contratos de ambiente (`infra/ENV_CONTRACT.md`)

- Variáveis obrigatórias do contrato: todas lidas com os nomes combinados.
- `AUTH_MODE=off` + `STORE=firestore` **não inicia** (pedido da infra); também não inicia com `NODE_ENV=production`, nem `STORE=memory` em produção.
- Variáveis **opcionais novas** (padrão seguro, não precisam estar no Terraform): `POLL_ACTIVE_MS`, `POLL_IDLE_MS`, `OFFLINE_AFTER_MS`, `OFFLINE_AFTER_IDLE_MS`, `LAST_SEEN_WRITE_MS`, `LAST_SEEN_WRITE_IDLE_MS`, `COMMAND_TTL_MS`, `LOAD_COMMAND_TTL_MS`, `DEVICE_CLOCK_SKEW_MS`, `RATE_LIMIT_USER_PER_MIN`, `RATE_LIMIT_DEVICE_PER_MIN`, `SEED_ON_BOOT`, `SEED_PROFILE`, `REQUIRE_CONFIRMED_POSITION`.
- `GET /health` responde sem tocar o banco (sonda de inicialização).
- **Escrita no banco com poll de 30 s / 1,5 s:** a cota gratuita (20 mil escritas/dia) suporta ~4 AGVs em repouso (≈ 2.900/dia) + algumas centenas de missões/dia; ver estimativa em `FIRESTORE_MODEL.md` §6.

## 6. Limitações conhecidas (não são bugs ocultos)

- **Latência de entrega de comando = `nextPollMs`** (até 30 s em repouso). Aceito para o POC; `POLL_IDLE_MS` é ajustável. Stop/abort remoto é "melhor esforço" (ADR de perda de comunicação).
- **Rate limit e anti-replay são por instância** (máx. 2 instâncias); o teto real de abuso é `max-instances` + orçamento.
- **Busca textual (`search`)** é feita em memória sobre no máximo 500 documentos lidos por requisição.
- **Métricas:** `totalErrors` soma `errorCount` das missões (não eventos de severidade `error` fora de missão). A mediana vem de até 1.000 durações por rollup.
- **Faltam testes** do `FirestoreStore` contra o emulador, de `PubSubPublisher` real e de `FirebaseVerifier`/`GoogleOidcVerifier` reais (cobertos só por verificadores falsos).
- Um `hello` na **mesma sessão** só reconcilia se o firmware enviar `lastMission`; sem isso a missão incerta aguarda `snapshot` ou `force-close`.
- O log de requisição é próprio (hook `onResponse`) e desliga o padrão do Fastify via `LogController`, que existe a partir do Fastify 5.12.
