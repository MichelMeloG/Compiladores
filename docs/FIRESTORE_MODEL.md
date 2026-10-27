# Modelo de dados no Firestore — RoboFlow

Atualizado em 26/10/2026. Complementa o [ADR 0003](adr/0003-firestore-no-lugar-de-sql.md). Os tipos de cada documento vêm de `@roboflow/contracts` (`contracts/src`); este arquivo descreve **onde** ficam, **como** são acessados e **quanto custam** na cota gratuita.

Banco: `(default)`, modo nativo, edição Standard, `us-central1`. A localização não pode ser mudada depois.

## 1. Coleções

Convenções: IDs em maiúsculas dos robôs (`RB-01`); datas ISO 8601 UTC em string (o front as consome assim) mais, quando há TTL, um campo `expireAt` do tipo `Timestamp`; documentos de versão **nunca são atualizados**.

| Coleção / ID do doc | Conteúdo (schema) | Escrita | Observações |
|---|---|---|---|
| `robots/{robotId}` | Campos públicos de `Robot` (`name`, `area`, `model`, `status`, `roverState`, `currentMissionId`, `batteryPercent`, `currentPoint`, `firmwareVersion`, `lastSeenAt`, `activeAlertsCount`) | Operador (cadastro), ingest (estado) | `GET /robots` lê a coleção inteira (poucos robôs) |
| `devices/{deviceId}` | `DeviceRecord` (`robotId`, `mapId`, `mapVersion`, `lastConfirmedHeading`, `capabilities`, `secretName`) + runtime: `sessionId`, `lastRequestSequence`, `ackedSequence`, `state`, `sensors` (último snapshot), `blockId`, `blockReasons`, `lastSeenAt`, **`activeMissionId`**, **`pendingCommandIds[]`** | Ingest, controle | Doc "quente": é lido em todo poll. `deviceId == robotId` no POC |
| `maps/{mapId}/versions/{n}` | `RobotMap` (`cols`, `rows`, `points`, `closedEdges`) | Seed/admin | **Imutável** por versão |
| `routeTemplates/{id}@{version}` | `RouteTemplate` | Seed/admin | Imutável. Dados de apoio (sem endpoint na v1) |
| `missions/{missionId}` | `Mission` público + interno: `state` (`MissionState`), `deviceId`, `routeRevision`, `routeId`, `snapshot` {`waypoints`, `actions`, `expectedNodes`, `startNode`, `initialHeading`, `mapId`, `mapVersion`}, `completedActions`, `blockId`, `blockReasons`, `sessionId`, `operatorUid`, `updatedAt` | Criação (operador), ingest | `status` público é a **projeção** de `state` (`publicMissionStatus`) |
| `events/{eventId}` | `LogEvent` + `source` (`device` \| `import` \| `system`) + `expireAt` | Ingest, importação | `missionId` pode faltar (diagnóstico). `/logs` filtra por `missionId` quando pedido |
| `deviceEvents/{deviceId}_{sessionId}_{sequence}` | Evento bruto **crítico** do dispositivo + `receivedAt`, `processed` | Ingest | **ID determinístico = dedupe** (`create()` falha se já existe). TTL 30 dias |
| `commands/{commandId}` | `DeviceCommand` (`type`, `status`, `attempts`, `expiresAt`, `deliveredAt`, `blockId`, `operatorUid`…) | Controle, ingest | TTL 7 dias após resolvido |
| `idempotency/{sha256(escopo+chave)}` | `requestHash`, `status`, `responseBody`, `createdAt`, `expireAt` | Controle | TTL 24 h |
| `alerts/{alertId}` | `Alert` | Consumidor Pub/Sub, ack do operador | `activeAlertsCount` do robô é mantido junto |
| `rollups/{robotId}_{yyyymmdd}` e `rollups/{robotId}_all` | Contadores: missões por status, `stopCount`, `presenceStops`, `otherStops`, `unknownStops`, `errorCount`, `durations[]` (limite 1.000, só concluídas) | Consumidor Pub/Sub | Alimentam `/dashboard/metrics` e `/fleet/metrics`; mediana, mín e máx saem de `durations[]` |
| `counters/{name}` | `next` (inteiro) | Transação | IDs sequenciais `RF-0113`, `RT-0042`, `cmd-0001` |

> **Decisão final — `devices/{id}.pendingCommandIds[]` no documento quente.** Os IDs dos comandos ainda `pending` ficam no próprio doc do dispositivo, mantidos nas mesmas transações que criam/resolvem comandos. Assim o **poll custa 1 leitura** (o doc do dispositivo) em vez de doc + query em `commands`; a mesma lista sustenta a regra de um `start`/`resume` pendente por vez ([ADR 0008](adr/0008-um-start-resume-pendente-por-vez.md)). `commands` continua sendo a fonte do detalhe (`GET /commands/:id`). Não usar query em `commands` no caminho do poll.

### Chaves de ordenação e filtros

IDs sequenciais usam `counters` e o prefixo (`RF-`, `RT-`, `cmd-`). Isso custa 1 escrita a mais por missão e evita IDs aleatórios no que o operador lê.

## 2. Índices compostos necessários

Os índices de campo único são automáticos. Os compostos abaixo precisam estar em `firestore.indexes.json`:

| Coleção | Campos | Usado por |
|---|---|---|
| `missions` | `robotId` ASC, `startedAt` DESC | `GET /missions?robotId=` |
| `missions` | `status` ASC, `startedAt` DESC | `GET /missions?status=` |
| `missions` | `robotId` ASC, `status` ASC, `startedAt` DESC | filtros combinados |
| `events` | `missionId` ASC, `timestamp` ASC | linha do tempo da missão |
| `events` | `robotId` ASC, `timestamp` DESC | `GET /logs?robotId=`, `GET /robots/:id/events` |
| `events` | `robotId` ASC, `severity` ASC, `timestamp` DESC | filtro de severidade por robô |
| `events` | `robotId` ASC, `eventType` ASC, `timestamp` DESC | filtro de tipo por robô |
| `alerts` | `robotId` ASC, `acknowledged` ASC, `timestamp` DESC | `GET /alerts?robotId=&status=` |
| `alerts` | `acknowledged` ASC, `timestamp` DESC | contador do menu (sem robô) |
| `commands` | `missionId` ASC, `createdAt` DESC | comandos pendentes de uma missão |

Busca textual (`search`) **não é suportada pelo Firestore**: em v1 é feita em memória sobre a página já lida (aceitável para o POC; documentar o limite).

## 3. Transações e invariantes

| Operação | Leituras na transação | Escritas |
|---|---|---|
| Criar missão (`POST .../route`) | `devices/{id}`, `idempotency/{h}`, `counters/mission`, `counters/route`, `counters/command` | `missions/{id}`, `commands/{id}` (`load_route`), `idempotency/{h}`, `devices/{id}` (`activeMissionId`, `pendingCommandIds`), `robots/{id}`, `counters/*` |
| Start / stop / resume / abort | `missions/{id}`, `devices/{id}`, `idempotency/{h}` | `commands/{id}`, `idempotency/{h}`, `devices/{id}` |
| Ingest de evento crítico | `deviceEvents/{id}` (via `create()`), `missions/{id}`, `commands/{id}` quando é ack | `deviceEvents/{id}`, `missions/{id}`, `commands/{id}`, `events/{id}` (projeção), `devices/{id}` |
| Fim de missão | `missions/{id}`, `devices/{id}` | `missions/{id}` (`completed`), `devices/{id}` (`activeMissionId = null`), `robots/{id}`, `events/{id}` × 2 |

Transições extras aprovadas (contracts 1.1.0): `loading/running → aborted` e `uncertain → completed/blocked`. `force-close` (admin) grava `closedWithoutConfirmation = true`, mantém `endedAt` ausente e `durationSeconds = null`, expira os comandos pendentes (`reason: FORCE_CLOSED`) e zera `activeMissionId`. `POST .../position` só grava `currentPoint`, rumo e `positionConfidence = confirmed` quando não há missão ativa. `ackedSequence` guarda o maior `sequence` de evento **crítico** processado.

Invariantes: `devices.activeMissionId` é `null` ou aponta para uma missão **ativa ou `uncertain`** (nunca terminal); `completedActions` só incrementa de 1 em 1 e só quando `actionIndex === completedActions`; uma missão em estado terminal nunca é reaberta.

## 4. Pub/Sub e consumidores

Após a transação do ingest, o servidor publica o evento no tópico `agv-events` (atributos `deviceId`, `type`). A entrega é *at-least-once*: o consumidor `/internal/events` é **idempotente**, porque aplica o efeito dentro de uma transação que lê `deviceEvents/{id}.processed` e só então atualiza rollups e alertas. Mensagens que falham vão para a DLQ após o limite de tentativas. O caminho crítico (estado da missão, ack de comando) **não** depende do Pub/Sub.

## 5. TTL

| Coleção | Campo | Prazo |
|---|---|---|
| `idempotency` | `expireAt` | 24 h |
| `deviceEvents` | `expireAt` | 30 dias |
| `commands` | `expireAt` | 7 dias após resolvido |
| `events` | `expireAt` | 180 dias (opcional; o seed não define) |

TTL exige faturamento habilitado (já está). Exclusões por TTL contam como exclusões (cota de 20.000 por dia); confirmar na prática no teste de carga (OBS-004).

## 6. Estimativa de consumo (um AGV, um operador)

Cotas gratuitas diárias (Standard): **50.000 leituras, 20.000 escritas, 20.000 exclusões**, 1 GiB, reinício à meia-noite do Pacífico. Números abaixo são **estimativas de projeto**, a validar no teste de carga.

### 6.1 Escritas por missão de 6 ações

| Origem | Escritas |
|---|---|
| Criação (missão, comando, idempotência, device, robô, contadores) | ~8 |
| Cada ação concluída: doc bruto + projeção `events` + missão + robô/rota (×6) | ~24 |
| Início/fim, acks de `load_route` e `start`, conclusão (docs brutos, comandos, missão) | ~14 |
| Bloqueio com retomada (2 críticos + 2 comandos + estados) | ~10 |
| Snapshot "ao vivo" do sensor, no máximo 1 a cada 5 s (missão de 2 min) | ~24 |
| Rollup (por consumidor, 2 docs) | ~4 |
| **Total** | **~85** |

Limite de escrita diário ≈ 20.000 / 85 ≈ **230 missões por dia**, antes de contar o consumo em repouso.

Em repouso: `lastSeenAt` do dispositivo persistido no máximo a cada 120 s → ~720 escritas por dia por AGV. Com 4 AGVs ≈ 2.900/dia.

### 6.2 Leituras

| Ação | Leituras (aprox.) |
|---|---|
| Poll do dispositivo (lê `devices/{id}`; os comandos pendentes ficam no próprio doc) | 1 |
| Repouso: 1 poll a cada 30 s | ~2.900 por dia por AGV |
| Missão ativa: poll a cada 1,5 s | ~2.400 por hora de missão |
| Ingest de lote (device + missão + comando) | ~3 |
| Abrir o painel da frota (robôs + rollups + 50 missões + 6 logs + alertas) | ~120 |
| Abrir o painel de um robô | ~100 |
| Polling da UI em missão (execução + status do dispositivo), a cada 3 s | ~2 por poll → ~2.400 por hora |
| `GET /logs` ou `GET /missions` (página de 50) | 50 |

Com 4 AGVs em repouso (~11.600/dia) mais, por exemplo, 100 aberturas de tela (~12.000) e 2 horas de missão com operador (~10.000), o consumo fica na faixa de **35.000 a 40.000 leituras por dia**: dentro da cota, mas sem folga grande. Daí as regras:

1. **Cache em memória por instância** (1 s) do doc do dispositivo e (30 s) da lista de robôs, mapas e grades.
2. **Todas as listas têm `limit`** (padrão 50, teto 500) e `nextCursor`.
3. **Métricas vêm de rollups**, nunca de varrer `missions`/`events`.
4. **Polling da UI só com a aba visível** e missão ativa.
5. **`Cache-Control` curto** (`max-age=5`) em GETs de leitura para o navegador não repetir pedidos.
6. Alerta de orçamento de leituras (OBS-003) a 70% da cota diária.

### 6.3 Armazenamento

Evento de log ≈ 0,5 KB; missão com snapshot ≈ 2 KB. 100.000 eventos ≈ 50 MB. Longe de 1 GiB; TTL mantém assim.

## 7. Segurança (regras)

O backend (service account `datastore.user`) é o **único** cliente do Firestore em v1. As regras de segurança do Firestore negam todo acesso direto de clientes (`allow read, write: if false`). Se o front passar a ouvir documentos em tempo real (v2), liberar apenas leitura de `robots/{id}` e `devices/{id}` filtrada por claims de papel; nunca escrita.

## 8. Carga do seed

`contracts/seed/*.json` → coleções, nesta ordem: `maps/*/versions`, `devices`, `robots`, `missions` (com `snapshot` e `state` vindos de `mission-states.json`), `events`, `alerts`, `routeTemplates`. IDs: os do próprio arquivo. As datas do seed são fixas (`seedNow = 2026-10-26T18:00:00Z`); o mock as reancora para "agora", o carregador do Firestore em ambiente de desenvolvimento pode fazer o mesmo.

## 9. Fontes das cotas

- [Firestore pricing](https://cloud.google.com/firestore/pricing) e [Firestore quotas and limits](https://docs.cloud.google.com/firestore/quotas) — confirmado em 26/10/2026.
- [Cloud Run pricing](https://cloud.google.com/run/pricing) — 2 milhões de requisições, 180.000 vCPU-s e 360.000 GiB-s por mês no nível 1 (inclui `us-central1`); regiões do nível 2 têm cotas menores (confirmado por resultado de busca, valores exatos de `southamerica-east1` não verificados).
- Pub/Sub (10 GiB/mês) e Secret Manager (6 versões ativas) **não foram confirmados em fonte oficial** nesta consulta; conferir antes de citar.
