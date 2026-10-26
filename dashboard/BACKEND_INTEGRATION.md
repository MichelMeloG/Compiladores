# Rover Monitor — Contrato de Integração com o Backend

Este documento é a especificação que a equipe de backend precisa implementar para
que o dashboard **Rover Monitor** funcione.

O painel opera uma **frota**: a tela inicial agrega os dados de todos os robôs
conectados, e a barra lateral permite abrir um robô específico, que tem o mesmo
painel restrito aos seus dados e uma tela de **definição de rota**. Por isso
quase todo endereço aceita o parâmetro `robotId`, e os registros de telemetria
carregam o campo `robotId`.

O frontend está **pronto e não possui dados próprios**: não há banco local, modo de
demonstração nem dados de exemplo. Toda informação exibida vem de requisições HTTP
ao backend descrito aqui. Enquanto os endpoints não existirem, a interface mostra o
estado "Backend indisponível" com a mensagem de erro — esse é o comportamento
esperado, não um defeito.

> **Para quem vai implementar:** o que importa é a seção [§3 Endpoints](#3-endpoints)
> e o [checklist final](#8-checklist-de-implementação). Os formatos de resposta são
> normativos — os campos listados são exatamente os que a interface consome.

---

## 1. Configuração

Única variável de ambiente, em `.env` (copie de `.env.example`):

```env
# URL base do backend. Todos os endpoints são relativos a ela.
VITE_API_URL="http://localhost:8080/api"
```

Com o valor acima, o dashboard chamará `http://localhost:8080/api/missions`, e assim
por diante. Use `/api` caso o backend seja servido na mesma origem do frontend
(proxy reverso, ou `server.proxy` no `vite.config.ts`).

**CORS:** em desenvolvimento o frontend roda em `http://localhost:3000` e o backend
em outra porta. O backend precisa responder com
`Access-Control-Allow-Origin: http://localhost:3000` e permitir os métodos
`GET, POST, PATCH, OPTIONS` e o header `Content-Type`. Sem isso, o navegador bloqueia
as chamadas e o dashboard aparece vazio.

---

## 2. Arquitetura do lado do frontend

Toda a rede está concentrada em `src/services/` — nenhum componente de tela chama
`fetch` diretamente:

| Arquivo | Responsabilidade |
| :--- | :--- |
| `src/services/api.ts` | Único ponto que usa `fetch`. Timeout de 10s, header `application/json` e normalização de erros (`ApiError`). |
| `src/services/missionsService.ts` | `GET /missions`, `GET /missions/:id` |
| `src/services/logsService.ts` | `GET /logs`, `POST /logs/import` |
| `src/services/alertsService.ts` | `GET /alerts`, `PATCH /alerts/:id/acknowledge` |
| `src/services/metricsService.ts` | `GET /dashboard/metrics` |
| `src/services/robotsService.ts` | `GET /robots`, `GET /robots/:id`, `GET /fleet/metrics` |
| `src/services/routesService.ts` | `GET /robots/:id/grid`, `GET`/`POST /robots/:id/route` |

Os tipos de dados (`Robot`, `Mission`, `LogEvent`, `Alert`, `DashboardMetrics`,
`FleetMetrics`, `RobotGrid`) estão em `src/types/index.ts` e são o espelho exato
do que o backend deve devolver.

A geometria da malha e a validação de rota estão em `src/utils/routeGrid.ts` —
leia esse arquivo antes de implementar §3.11 e §3.13: é ele que define o que a
interface considera uma rota percorrível.

### Divisão de responsabilidades

- **O backend agrega.** Médias, medianas, taxas de conclusão e contagens de parada
  são calculadas no servidor e entregues prontas em `/dashboard/metrics`. O frontend
  apenas formata números para exibição.
- **O backend filtra por período.** Os parâmetros `period` / `startDate` / `endDate`
  são enviados nas consultas; a resposta deve vir já restrita ao intervalo.
- **O backend filtra por robô.** Quando `robotId` chega na query, a resposta deve
  conter apenas os registros daquele robô. Sem o parâmetro, a resposta é da frota
  inteira. Vale para `/dashboard/metrics`, `/missions`, `/logs` e `/alerts`.
- **O frontend refina localmente.** Busca textual, ordenação de colunas e paginação
  das tabelas acontecem no navegador, sobre o conjunto já recebido. Os demais
  parâmetros de query são enviados quando o usuário os utiliza e devem ser
  respeitados, mas não precisam ser otimizados em uma primeira versão.

---

## 3. Endpoints

Envelope de resposta esperado em todos os casos (`data` é o que a interface lê):

```json
{ "success": true, "data": <carga> }
```

O cliente também aceita a carga crua (sem envelope) — mas o envelope é o padrão
recomendado, por permitir `message` em caso de erro.

**Erros:** responda com o status HTTP adequado (4xx/5xx) e, se possível, um corpo
JSON com `message`. Essa mensagem é exibida diretamente ao operador na tela.

---

### 3.1 Health check *(opcional — não consumido pela interface)*

```
GET /health
```

A interface **não** chama este endpoint. Ele está aqui como ferramenta de
diagnóstico: é a forma mais rápida de verificar, com um `curl`, se o servidor
subiu e se o CORS está liberado, antes de implementar o resto.

```json
{ "status": "ok", "version": "1.0.0", "robotsConnected": 4 }
```

Implementar primeiro é recomendado, mas não é requisito para o dashboard funcionar.

---

### 3.2 Indicadores agregados

```
GET /dashboard/metrics?period=&startDate=&endDate=&origin=&destination=&robotId=
```

`period`: `24h` | `7d` | `30d` | `all` | `custom`
(`startDate`/`endDate` em ISO 8601, enviados quando `period=custom`)

`robotId`: presente quando o operador está dentro de um robô; ausente no escopo
da frota. Para o painel da frota a interface usa `GET /fleet/metrics` (§3.10),
que traz estes mesmos campos mais o recorte por robô.

Alimenta os cartões de KPI do painel de um robô e da página de Desempenho.

```json
{
  "success": true,
  "data": {
    "totalMissions": 18,
    "completedMissions": 15,
    "inProgressMissions": 1,
    "failedMissions": 1,
    "abortedMissions": 1,
    "indeterminateMissions": 0,
    "avgDurationSeconds": 112,
    "medianDurationSeconds": 110,
    "minDurationSeconds": 85,
    "maxDurationSeconds": 165,
    "totalStops": 12,
    "presenceStops": 8,
    "otherStops": 3,
    "unknownStops": 1,
    "completionRate": 83.3,
    "activeAlertsCount": 2,
    "totalErrors": 2
  }
}
```

Notas:
- `completionRate` é percentual de 0 a 100 (não fração).
- Campos de duração aceitam `null` quando não houver missão concluída no período.
- `totalStops` deve ser a soma de `presenceStops + otherStops + unknownStops`.

---

### 3.3 Listagem de missões

```
GET /missions?period=&startDate=&endDate=&origin=&destination=&status=&search=&robotId=
```

`status`: `completed` | `in_progress` | `aborted` | `failed` | `indeterminate`
(omitido quando o filtro está em "todos")

Retorna um **array** de missões. O campo `events` é **opcional aqui** — omita-o para
manter a resposta leve; a interface busca a linha do tempo sob demanda (§3.4).

```json
{
  "success": true,
  "data": [
    {
      "id": "MS-2026-081",
      "robotId": "RB-01",
      "origin": "Ponto A",
      "destination": "Ponto B",
      "status": "completed",
      "startedAt": "2026-10-19T08:15:00.000Z",
      "endedAt": "2026-10-19T08:16:48.000Z",
      "durationSeconds": 108,
      "stopCount": 1,
      "presenceStopCount": 1,
      "errorCount": 0,
      "eventCount": 7,
      "stopReasons": [{ "reason": "Presença detectada", "count": 1 }]
    }
  ]
}
```

| Campo | Tipo | Observação |
| :--- | :--- | :--- |
| `id` | string | Identificador exibido e usado em `/missions/:id` |
| `robotId` | string | Robô que executou o percurso. Obrigatório |
| `status` | enum | Ver lista acima |
| `startedAt` | ISO 8601 | Obrigatório |
| `endedAt` | ISO 8601 \| ausente | Ausente em missões em andamento |
| `durationSeconds` | number \| null | `null` quando indeterminada |
| `stopReasons` | array | Agrupamento de motivos de parada, para o modal de detalhe |

---

### 3.4 Detalhe de uma missão

```
GET /missions/:id
```

Chamado quando o operador abre o modal de uma missão. Mesma estrutura de §3.3,
**com `events` preenchido** — é a linha do tempo exibida no modal.

```json
{
  "success": true,
  "data": {
    "id": "MS-2026-081",
    "robotId": "RB-01",
    "origin": "Ponto A",
    "destination": "Ponto B",
    "status": "completed",
    "startedAt": "2026-10-19T08:15:00.000Z",
    "endedAt": "2026-10-19T08:16:48.000Z",
    "durationSeconds": 108,
    "stopCount": 1,
    "presenceStopCount": 1,
    "errorCount": 0,
    "eventCount": 7,
    "stopReasons": [{ "reason": "Presença detectada", "count": 1 }],
    "events": [
      {
        "id": "evt-101",
        "missionId": "MS-2026-081",
        "robotId": "RB-01",
        "timestamp": "2026-10-19T08:15:00.000Z",
        "eventType": "mission_start",
        "command": "INIT \"Ponto A\"",
        "roverState": "idle",
        "severity": "info",
        "message": "Missão iniciada de Ponto A para Ponto B."
      }
    ]
  }
}
```

---

### 3.5 Listagem de logs e telemetria

```
GET /logs?period=&startDate=&endDate=&missionId=&eventType=&severity=&search=&robotId=
```

Retorna um array de eventos, **ordenado do mais recente para o mais antigo**.

```json
{
  "success": true,
  "data": [
    {
      "id": "evt-104",
      "missionId": "MS-2026-081",
      "robotId": "RB-01",
      "timestamp": "2026-10-19T08:15:46.000Z",
      "eventType": "stop_preventive",
      "command": "STOP",
      "roverState": "stopped",
      "severity": "warning",
      "message": "Parada preventiva realizada. Aguardando liberação."
    }
  ]
}
```

Valores aceitos (definidos em `src/types/index.ts`):

| Campo | Valores |
| :--- | :--- |
| `eventType` | `mission_start`, `command`, `state_change`, `presence_detected`, `stop_preventive`, `resume`, `destination_reached`, `mission_end`, `error`, `warning`, `unknown` |
| `roverState` | `idle`, `moving`, `stopped`, `obstacle_hold`, `navigating`, `completed`, `error`, `unknown` |
| `severity` | `info`, `warning`, `error`, `critical` |

Campos obrigatórios por evento: `id`, `missionId`, `robotId`, `timestamp`,
`eventType`, `severity`, `message`. Os campos `command`, `roverState`, `payload` e `raw` são
opcionais.

---

### 3.6 Importação de logs em lote

```
POST /logs/import
Content-Type: application/json
```

A página "Importar dados" lê o arquivo `.json`/`.csv` no navegador, normaliza os
campos (§4) e envia os eventos válidos já no formato canônico. O backend é quem
persiste.

Corpo da requisição:

```json
{
  "events": [
    {
      "id": "evt-901",
      "missionId": "MS-2026-089",
      "robotId": "RB-01",
      "timestamp": "2026-10-19T18:30:00.000Z",
      "eventType": "mission_start",
      "command": "INIT \"Ponto A\"",
      "roverState": "idle",
      "severity": "info",
      "message": "Início de percurso Ponto A -> Ponto B"
    }
  ]
}
```

Resposta (`200 OK` ou `201 Created`):

```json
{
  "success": true,
  "data": { "importedCount": 1, "ignoredCount": 0 }
}
```

`ignoredCount` é opcional e deve contar eventos descartados por duplicidade
(recomenda-se deduplicar por `id`). Ambos os números são exibidos ao operador.

---

### 3.7 Alertas

```
GET   /alerts?severity=&status=&missionId=&search=&robotId=
PATCH /alerts/:id/acknowledge
```

`status`: `unacknowledged` | `acknowledged` (omitido quando "todos")

Listagem:

```json
{
  "success": true,
  "data": [
    {
      "id": "alt-1",
      "title": "Paradas recorrentes por presença",
      "description": "3 paradas preventivas no mesmo trecho.",
      "severity": "warning",
      "timestamp": "2026-10-19T08:16:00.000Z",
      "missionId": "MS-2026-081",
      "robotId": "RB-01",
      "occurrenceCount": 3,
      "acknowledged": false,
      "relatedEventIds": ["evt-103", "evt-104"]
    }
  ]
}
```

Reconhecimento — o estado é **persistido no backend**, não no navegador. A interface
só marca o alerta como reconhecido após resposta de sucesso:

```json
{
  "success": true,
  "data": {
    "id": "alt-1",
    "acknowledged": true,
    "acknowledgedAt": "2026-10-19T18:05:00.000Z"
  }
}
```

O campo lido pela interface é `data.acknowledged`.

O contador do menu lateral usa `GET /alerts?status=unacknowledged`.

---

### 3.8 Listagem de robôs

```
GET /robots
```

Alimenta o seletor "Robôs conectados" da barra lateral e os cartões da tela
inicial. É o primeiro endpoint que a interface chama: sem ele, a navegação por
robô fica vazia.

```json
{
  "success": true,
  "data": [
    {
      "id": "RB-01",
      "name": "Carregador Norte",
      "area": "Linha de montagem A",
      "model": "RoboFlow AGV v2",
      "status": "busy",
      "roverState": "moving",
      "currentMissionId": "RF-0112",
      "batteryPercent": 78,
      "currentPoint": "2,1",
      "firmwareVersion": "1.4.2",
      "lastSeenAt": "2026-10-21T08:15:00.000Z",
      "activeAlertsCount": 0
    }
  ]
}
```

| Campo | Tipo | Observação |
| :--- | :--- | :--- |
| `id` | string | Identificador usado em todos os `robotId` e nas rotas `/robots/:id` |
| `name` | string | Nome exibido ao operador |
| `area` | string \| ausente | Setor ou linha de produção |
| `status` | enum | `online`, `busy`, `idle`, `offline`, `error`, `maintenance` |
| `roverState` | enum \| ausente | Mesmos valores de `roverState` em §3.5 |
| `batteryPercent` | number \| null | 0 a 100, ou `null` se o robô não reporta |
| `currentPoint` | string \| null | Vértice atual na malha, no formato `"x,y"` |
| `lastSeenAt` | ISO 8601 | Último contato; a interface exibe como tempo decorrido |
| `activeAlertsCount` | number | Alertas não reconhecidos deste robô |

---

### 3.9 Detalhe de um robô

```
GET /robots/:id
```

Mesma estrutura de §3.8, para um único robô. Responda `404` quando o id não
existir. Alimenta o cartão de identificação no topo das telas do robô.

---

### 3.10 Indicadores da frota

```
GET /fleet/metrics?period=&startDate=&endDate=
```

É o `/dashboard/metrics` da frota inteira, acrescido da contagem de robôs por
estado e do recorte por robô. Alimenta a tela inicial.

```json
{
  "success": true,
  "data": {
    "totalMissions": 10,
    "completedMissions": 7,
    "inProgressMissions": 1,
    "failedMissions": 1,
    "abortedMissions": 1,
    "indeterminateMissions": 0,
    "avgDurationSeconds": 105,
    "medianDurationSeconds": 101,
    "minDurationSeconds": 69,
    "maxDurationSeconds": 159,
    "totalStops": 4,
    "presenceStops": 2,
    "otherStops": 2,
    "unknownStops": 0,
    "completionRate": 70,
    "activeAlertsCount": 3,
    "totalErrors": 3,
    "totalRobots": 4,
    "onlineRobots": 2,
    "offlineRobots": 1,
    "errorRobots": 1,
    "perRobot": [
      {
        "robotId": "RB-01",
        "robotName": "Carregador Norte",
        "totalMissions": 3,
        "completedMissions": 2,
        "totalStops": 1,
        "totalErrors": 0,
        "completionRate": 66.7,
        "avgDurationSeconds": 91
      }
    ]
  }
}
```

Notas:
- Os campos herdados de `DashboardMetrics` (§3.2) têm o mesmo significado, agora
  somados sobre todos os robôs.
- `perRobot` alimenta o gráfico "Comparativo entre robôs". Inclua uma entrada por
  robô conectado, mesmo que ele não tenha missões no período (com zeros).
- `onlineRobots` conta os robôs em `online`, `busy` ou `idle`.

---

### 3.11 Malha de navegação de um robô

```
GET /robots/:id/grid
```

A malha percorrível do robô: uma grade de vértices ligados por trilhos
ortogonais. O robô anda **apenas sobre as linhas**, um vértice por vez, sem
diagonal. É o backend que define o tamanho da grade e os pontos especiais — a
interface só desenha o que recebe.

As coordenadas são **0-indexadas**, com a origem `(0, 0)` no canto superior
esquerdo: `x` cresce para a direita, `y` para baixo.

```json
{
  "success": true,
  "data": {
    "cols": 5,
    "rows": 4,
    "points": [
      { "x": 0, "y": 0, "kind": "station", "label": "carga" },
      { "x": 4, "y": 0, "kind": "station", "label": "descarga" },
      { "x": 2, "y": 2, "kind": "blocked" }
    ]
  }
}
```

| Campo | Tipo | Observação |
| :--- | :--- | :--- |
| `cols` / `rows` | number | Quantidade de vértices em cada eixo (não de células) |
| `points` | array \| ausente | Apenas os vértices com característica própria |
| `points[].kind` | enum | `free` (padrão), `station`, `blocked` |
| `points[].label` | string \| ausente | Nome da estação, exibido junto ao vértice |

Vértices omitidos de `points` são livres. Um vértice `blocked` não pode ser
selecionado e o planejador traça o caminho em volta dele.

---

### 3.12 Rota atual de um robô

```
GET /robots/:id/route
```

A rota carregada no robô, exibida ao abrir a tela de rota. Responda `404`
quando o robô não tiver rota — é situação normal, e a interface a trata como
"nenhuma rota definida", não como falha de comunicação.

```json
{
  "success": true,
  "data": {
    "routeId": "RT-0041",
    "robotId": "RB-01",
    "waypoints": [
      { "x": 0, "y": 0 },
      { "x": 1, "y": 0 },
      { "x": 2, "y": 0 },
      { "x": 2, "y": 1 }
    ],
    "createdAt": "2026-10-21T08:10:00.000Z",
    "status": "running",
    "currentWaypointIndex": 2
  }
}
```

`status`: `queued` | `running` | `completed` | `cancelled`.
`currentWaypointIndex` é o índice do último waypoint alcançado, ou `null` se o
robô ainda não iniciou.

---

### 3.13 Envio de rota ao robô

```
POST /robots/:id/route
Content-Type: application/json
```

**Este é o endpoint que recebe a rota montada pelo operador** — na malha
clicável, na lista editável, ou nas duas.

O corpo é a **sequência ordenada de vértices**, do primeiro ao último:

```json
{
  "waypoints": [
    { "x": 0, "y": 2 },
    { "x": 0, "y": 1 },
    { "x": 0, "y": 0 },
    { "x": 1, "y": 0 },
    { "x": 2, "y": 0 }
  ]
}
```

Garantias que a interface já aplica antes de enviar (validadas em
`src/utils/routeGrid.ts`):

- Pelo menos **dois** waypoints.
- Todos dentro da malha devolvida por §3.11, e nenhum em vértice `blocked`.
- Vértices consecutivos são sempre **adjacentes** — diferem em exatamente uma
  unidade, em um único eixo. Quando o operador clica dois pontos distantes, a
  interface preenche o caminho mais curto entre eles, contornando bloqueios.

Ou seja: o backend recebe a rota já expandida passo a passo, pronta para ser
traduzida em comandos de tração pelo compilador. **A interface não envia
direções** (`FRENTE`, `ESQUERDA`…) — a conversão de pontos em movimento é
responsabilidade do backend / do compilador DSL, que conhece a orientação atual
do robô.

Resposta (`200 OK` ou `201 Created`):

```json
{
  "success": true,
  "data": {
    "routeId": "RT-0042",
    "accepted": true,
    "waypointCount": 5,
    "message": "Rota aceita e enfileirada no robô."
  }
}
```

| Campo | Tipo | Observação |
| :--- | :--- | :--- |
| `accepted` | boolean | `false` recusa a rota; `message` é exibida ao operador |
| `routeId` | string | Identificador da rota criada |
| `waypointCount` | number | Confirmação de quantos pontos foram aceitos |
| `message` | string \| ausente | Motivo da recusa, ou confirmação |

**Recusa não é erro HTTP.** Um robô offline, em falha ou já executando uma rota
deve responder `200` com `accepted: false` e o motivo em `message` — a interface
mostra o aviso e mantém a rota montada, para o operador corrigi-la. Reserve os
status 4xx/5xx para corpo inválido (`422` para menos de dois waypoints) e falhas
do próprio servidor.

---

## 4. Normalização de arquivos importados

O parser do frontend (`src/utils/logParser.ts`) aceita variações de nome de coluna
nos arquivos JSON/CSV enviados pelo sistema embarcado, e converte tudo para o
formato canônico antes de chamar `POST /logs/import`:

| Campo canônico | Nomes alternativos aceitos |
| :--- | :--- |
| `timestamp` | `time`, `datetime`, `event_time`, `date`, `data_hora`, `horario`, `ts` |
| `missionId` | `mission_id`, `id_missao`, `missao`, `mission`, `trip_id`, `run_id` |
| `robotId` | `robot_id`, `robot`, `robo`, `id_robo`, `agv`, `agv_id`, `carrinho`, `veiculo`, `vehicle_id`, `device_id` |
| `eventType` | `event_type`, `tipo_evento`, `tipo`, `type`, `event`, `action`, `category` |
| `command` | `comando`, `cmd`, `instruction`, `instrucao` |
| `roverState` | `rover_state`, `estado`, `state`, `status_carrinho` |
| `severity` | `severidade`, `level`, `nivel`, `grau`, `log_level` |
| `message` | `mensagem`, `msg`, `description`, `descricao`, `detail` |

Quando a coluna do robô não existe no arquivo, o evento entra com
`robotId: "unassigned"` em vez de ser descartado — cabe ao backend atribuí-lo,
do mesmo modo que já acontece com `missionId`.

A página de importação oferece download de modelos de formato
(`src/utils/logFormatTemplate.ts`) — são apenas referências de estrutura, com
marcadores `EXEMPLO-*`, sem dados operacionais.

---

## 5. Comportamento da interface sem backend

| Situação | O que o operador vê |
| :--- | :--- |
| Backend fora do ar / CORS bloqueado | "Não foi possível carregar os dados — Sem resposta do servidor de dados" + botão "Tentar novamente" |
| Timeout (>10s) | A mesma tela, com "O servidor demorou mais de 10s para responder" |
| Erro HTTP (4xx/5xx) | A mesma tela, com o `message` devolvido pelo backend (ou "O servidor respondeu com erro NNN") |
| Backend respondeu, sem registros | Estado vazio neutro ("Nenhuma missão encontrada") |

A distinção entre "erro" e "vazio" é intencional: um dashboard vazio nunca deve ser
confundido com um desconectado.

**A tela é de operador, não de desenvolvedor.** A falha é comunicada em **um** só
lugar — onde os dados apareceriam — em linguagem simples, sem URL, sem jargão de
rede e sem indicadores de status espalhados pelo layout. O diagnóstico técnico
(URL chamada, status HTTP, corpo da resposta) fica onde pertence: no DevTools.

Ao mexer nessas telas, não reintroduza avisos de conexão em outros pontos: o
`message` do `ApiError` já chega pronto para ser exibido pelo `ErrorState`.

> Nota: a aplicação busca dados ao abrir a página, ao trocar filtros e ao clicar em
> "Atualizar" — não há polling. Portanto não existe, hoje, indicador de conexão
> "ao vivo": um dado na tela é sempre do último carregamento. Se for preciso
> detectar queda do servidor sem ação do usuário, isso exige implementar polling.

---

## 6. Executando o frontend

```bash
npm install          # sem flags
npm run dev          # http://localhost:3000
npm run lint         # checagem de tipos (tsc --noEmit)
npm run build        # build de produção (gera dist/)
```

Sem backend configurado, a aplicação sobe normalmente e exibe o estado de
desconexão — útil para validar o layout antes da API existir.

---

## 7. Sugestão de ordem de implementação

1. `GET /health` *(opcional)* — a forma mais rápida de confirmar que o servidor
   subiu e que o CORS está liberado.
2. `GET /robots` — **comece por aqui.** Sem a lista de robôs não há navegação:
   a barra lateral fica vazia e não há como abrir o painel de um robô.
3. `GET /logs` — a fonte bruta; alimenta a página de Logs.
4. `GET /missions` — agregação de eventos em missões; alimenta Missões e os gráficos.
5. `GET /fleet/metrics` — KPIs da tela inicial, com `perRobot`.
6. `GET /dashboard/metrics` (com `robotId`) — os mesmos KPIs dentro de um robô.
7. `GET /robots/:id` — cartão de identificação no topo das telas do robô.
8. `GET /missions/:id` — linha do tempo no modal de detalhe.
9. `GET /alerts` + `PATCH /alerts/:id/acknowledge` — central de alertas.
10. `GET /robots/:id/grid` + `POST /robots/:id/route` — tela de definição de rota.
11. `GET /robots/:id/route` — rota já carregada no robô.
12. `POST /logs/import` — ingestão de arquivos.

Após o passo 6 o dashboard já fica utilizável de ponta a ponta. Os passos 10 e 11
podem ser feitos em paralelo: a tela de rota é independente das de telemetria.

---

## 8. Checklist de implementação

- [ ] `GET /robots`
- [ ] `GET /robots/:id`
- [ ] `GET /fleet/metrics` (com `perRobot`)
- [ ] `GET /dashboard/metrics`
- [ ] `GET /missions`
- [ ] `GET /missions/:id` (com `events`)
- [ ] `GET /logs` (ordenado do mais recente para o mais antigo)
- [ ] `POST /logs/import`
- [ ] `GET /alerts`
- [ ] `PATCH /alerts/:id/acknowledge`
- [ ] `GET /robots/:id/grid`
- [ ] `GET /robots/:id/route` (404 quando não houver rota)
- [ ] `POST /robots/:id/route` (recusa com `accepted: false`, não com 4xx)
- [ ] `robotId` respeitado em `/dashboard/metrics`, `/missions`, `/logs`, `/alerts`
- [ ] `robotId` presente em cada evento de `/logs` e em cada missão de `/missions`
- [ ] CORS liberado para a origem do frontend
- [ ] Envelope `{ "success": true, "data": ... }` em todas as respostas
- [ ] Datas em ISO 8601 (UTC)
- [ ] Erros com status HTTP adequado e `message` no corpo
- [ ] *(opcional)* `GET /health` para diagnóstico
