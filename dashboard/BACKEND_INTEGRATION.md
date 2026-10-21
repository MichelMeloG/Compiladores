# Rover Monitor — Contrato de Integração com o Backend

Este documento é a especificação que a equipe de backend precisa implementar para
que o dashboard **Rover Monitor** funcione.

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

Os tipos de dados (`Mission`, `LogEvent`, `Alert`, `DashboardMetrics`) estão em
`src/types/index.ts` e são o espelho exato do que o backend deve devolver.

### Divisão de responsabilidades

- **O backend agrega.** Médias, medianas, taxas de conclusão e contagens de parada
  são calculadas no servidor e entregues prontas em `/dashboard/metrics`. O frontend
  apenas formata números para exibição.
- **O backend filtra por período.** Os parâmetros `period` / `startDate` / `endDate`
  são enviados nas consultas; a resposta deve vir já restrita ao intervalo.
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
{ "status": "ok", "version": "1.0.0", "roverConnected": true }
```

Implementar primeiro é recomendado, mas não é requisito para o dashboard funcionar.

---

### 3.2 Indicadores agregados

```
GET /dashboard/metrics?period=&startDate=&endDate=&origin=&destination=
```

`period`: `24h` | `7d` | `30d` | `all` | `custom`
(`startDate`/`endDate` em ISO 8601, enviados quando `period=custom`)

Alimenta os cartões de KPI da Visão Geral e da página de Desempenho.

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
GET /missions?period=&startDate=&endDate=&origin=&destination=&status=&search=
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
GET /logs?period=&startDate=&endDate=&missionId=&eventType=&severity=&search=
```

Retorna um array de eventos, **ordenado do mais recente para o mais antigo**.

```json
{
  "success": true,
  "data": [
    {
      "id": "evt-104",
      "missionId": "MS-2026-081",
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

Campos obrigatórios por evento: `id`, `missionId`, `timestamp`, `eventType`,
`severity`, `message`. Os campos `command`, `roverState`, `payload` e `raw` são
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
GET   /alerts?severity=&status=&missionId=&search=
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

## 4. Normalização de arquivos importados

O parser do frontend (`src/utils/logParser.ts`) aceita variações de nome de coluna
nos arquivos JSON/CSV enviados pelo sistema embarcado, e converte tudo para o
formato canônico antes de chamar `POST /logs/import`:

| Campo canônico | Nomes alternativos aceitos |
| :--- | :--- |
| `timestamp` | `time`, `datetime`, `event_time`, `date`, `data_hora`, `horario`, `ts` |
| `missionId` | `mission_id`, `id_missao`, `missao`, `mission`, `trip_id`, `run_id` |
| `eventType` | `event_type`, `tipo_evento`, `tipo`, `type`, `event`, `action`, `category` |
| `command` | `comando`, `cmd`, `instruction`, `instrucao` |
| `roverState` | `rover_state`, `estado`, `state`, `status_carrinho` |
| `severity` | `severidade`, `level`, `nivel`, `grau`, `log_level` |
| `message` | `mensagem`, `msg`, `description`, `descricao`, `detail` |

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
2. `GET /logs` — a fonte bruta; alimenta a página de Logs.
3. `GET /missions` — agregação de eventos em missões; alimenta Missões e os gráficos.
4. `GET /dashboard/metrics` — KPIs; alimenta Visão Geral e Desempenho.
5. `GET /missions/:id` — linha do tempo no modal de detalhe.
6. `GET /alerts` + `PATCH /alerts/:id/acknowledge` — central de alertas.
7. `POST /logs/import` — ingestão de arquivos.

Após o passo 4 o dashboard já fica utilizável de ponta a ponta.

---

## 8. Checklist de implementação

- [ ] `GET /dashboard/metrics`
- [ ] `GET /missions`
- [ ] `GET /missions/:id` (com `events`)
- [ ] `GET /logs` (ordenado do mais recente para o mais antigo)
- [ ] `POST /logs/import`
- [ ] `GET /alerts`
- [ ] `PATCH /alerts/:id/acknowledge`
- [ ] CORS liberado para a origem do frontend
- [ ] Envelope `{ "success": true, "data": ... }` em todas as respostas
- [ ] Datas em ISO 8601 (UTC)
- [ ] Erros com status HTTP adequado e `message` no corpo
- [ ] *(opcional)* `GET /health` para diagnóstico
