# Protocolo do dispositivo — visão do firmware

Fonte da verdade: `contracts/src/device.ts`, `contracts/src/signing.ts` (versão 1.1.0) e o comportamento do backend em `backend/src/services/device.ts` e `backend/src/auth/device.ts`. Quando este texto e um documento antigo divergem, vale o código e os ADRs 0001, 0002, 0005 e 0008.

Todos os JSONs de exemplo abaixo estão em [`vetores/mensagens.json`](vetores/mensagens.json) e foram **validados contra os schemas reais**. O segredo usado nos exemplos é fictício.

## 1. Visão geral

O ESP32 **puxa**; a nuvem nunca o chama. Três chamadas HTTPS ao serviço Cloud Run:

| Chamada | Quando | Corpo | Resposta (`data`) |
|---|---|---|---|
| `POST /device/hello` | A cada boot (e ao receber `409 CONFLICT_SESSION`) | `HelloMessage` | `DeviceHelloResponse` |
| `GET /device/poll` | No ritmo de `nextPollMs` | nenhum | `DeviceSyncResponse` |
| `POST /device/events` | Sempre que há evento a relatar | `{ "events": [ ... ] }`, 1 a 16 eventos | `DeviceEventsResponse` |

URL do serviço implantado: `https://roboflow-api-483331439325.us-central1.run.app`. Toda resposta de sucesso vem no envelope `{ "success": true, "data": ... }`; erro vem como `{ "success": false, "message": "...", "error": "CODIGO", "details"?: ... }`. `GET /health` é exceção: devolve `{"status":"ok"}` sem envelope e **sem autenticação**.

As **respostas não são assinadas**. A autenticidade do servidor vem só do TLS com a raiz fixada (ver [PROVISIONAMENTO.md](PROVISIONAMENTO.md)).

## 2. Autenticação: cabeçalhos e string-to-sign

Toda chamada a `/device/*` leva cinco cabeçalhos:

| Cabeçalho | Valor |
|---|---|
| `X-Device-Id` | `deviceId` (ex.: `RB-01`) |
| `X-Session-Id` | `sessionId` do boot atual; só aceita `[A-Za-z0-9._:-]` e 1 a 128 caracteres |
| `X-Sequence` | contador de **requisições** da sessão (inteiro ≥ 1, estritamente crescente) |
| `X-Timestamp` | epoch em **segundos**, inteiro, sem decimais |
| `X-Signature` | HMAC-SHA256 em hexadecimal (o servidor aceita maiúsculas, mas envie minúsculas) |

Para `POST` acrescente `Content-Type: application/json`.

### String-to-sign (extraída de `contracts/src/signing.ts`)

Cinco linhas separadas por `\n` (LF, sem `\r`, **sem `\n` no final**):

```
METHOD                    // em maiúsculas: GET ou POST
PATH_COM_QUERY            // exatamente como enviado na linha de requisição: /device/poll
X-Timestamp               // decimal ASCII
X-Sequence                // decimal ASCII
hex_minusculo(sha256(corpo))
```

`X-Signature = hex_minusculo(HMAC_SHA256(chave = segredo do dispositivo, mensagem = string-to-sign))`. A chave é a string do segredo em ASCII/UTF-8 como está (**não** decodifique de hex).

Regras que costumam dar erro:

- O **corpo** é o conjunto exato de bytes enviados. Serialize o JSON uma vez em um buffer, calcule o SHA-256 desse buffer e envie o mesmo buffer. Não reserialize, não mude espaços, não troque a ordem dos campos depois de assinar.
- **Corpo vazio** (todo `GET`): o hash é o do texto vazio, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. Mesmo assim a quinta linha existe.
- Em `GET /device/poll` o `path` é `/device/poll`, sem query. Se algum dia houver query, ela entra na assinatura.
- `X-Timestamp` e `X-Sequence` precisam caber em inteiro de **64 bits** (o timestamp passa de 2^31 em 2038; use `int64_t`/`time_t` de 64 bits).
- Cada tentativa é uma **requisição nova**: novo `X-Sequence` e novo `X-Timestamp`. Nunca reenvie a mesma assinatura (o servidor responde `REPLAY_DETECTED`).

Os 7 vetores positivos e os 11 negativos em [`vetores/`](vetores/) permitem validar essa implementação sem rede. Veja [VETORES_DE_TESTE.md](VETORES_DE_TESTE.md).

### O que o servidor confere (ordem)

1. Cabeçalhos presentes e `X-Sequence`/`X-Timestamp` numéricos → senão `SIGNATURE_INVALID`.
2. Assinatura (comparação em tempo constante) → senão `SIGNATURE_INVALID`. Dispositivo desconhecido e assinatura errada dão a **mesma** resposta.
3. Relógio: `|agora_servidor − X-Timestamp| ≤ tolerância` → senão `CLOCK_SKEW`. A tolerância em produção é **120 s** (`DEVICE_CLOCK_SKEW_MS`, padrão do backend). O padrão da biblioteca de contratos é 60 s; vale o do backend.
4. `X-Sequence` estritamente maior que a última aceita da sessão → senão `REPLAY_DETECTED`.
5. Só `POST /device/hello`: o `X-Timestamp` não pode ser anterior ao do último hello aceito (`REPLAY_DETECTED`).

Por isso o **relógio via NTP precisa estar certo antes do primeiro hello**.

## 3. Sessão e dois contadores

| Contador | Onde | Começa em | Regra |
|---|---|---|---|
| `X-Sequence` | cabeçalho de **toda requisição** | 1 no `hello` | cresce a cada requisição enviada, inclusive as que falharam por rede |
| `sequence` | corpo de cada **evento** | 1 no `hello` (o hello é o evento nº 1) | cresce a cada evento criado; o primeiro evento depois do hello é o 2 |

Não são o mesmo número. O `sessionId` muda a cada boot e **nunca** pode se repetir (ele compõe IDs de documento). Recomendação: `boot-<contador em NVS>-<6 hex de esp_random()>`, por exemplo `boot-7-lq3k9z` (o aleatório protege contra NVS apagada). Ao trocar de sessão, os dois contadores voltam a 1 e o `messageId` dos eventos passa a ser `evt-<sessionId>-<sequence>`.

`uptimeMs` é tempo monotônico desde o boot (`esp_timer_get_time()/1000`, 64 bits). Não é data.

## 4. `POST /device/hello`

Corpo (`HelloMessage`):

```json
{"v":1,"type":"hello","messageId":"hello-boot-7-lq3k9z","deviceId":"RB-01","sessionId":"boot-7-lq3k9z","sequence":1,"uptimeMs":1840,"firmwareVersion":"0.1.0","protocolVersion":1,"capabilities":{"supportsReverse":false,"maxActions":64,"maxMessageBytes":4096},"state":"ready"}
```

- `capabilities` anuncia o que o firmware executa. No POC: `supportsReverse:false` (nenhuma ação `T`), `maxActions:64`, `maxMessageBytes:4096` (limite de corpo que o firmware envia; o servidor impõe 4096 bytes em `/device/*`).
- `state`: um de `initializing | ready | running | blocked | paused | finished | fault`. Depois de um boot normal envie `ready`.
- `lastMission` (opcional) só se o firmware **lembra** de uma missão na mesma sessão (reconexão sem reboot). Depois de um reboot ele é vazio, porque a fila se perdeu.

Resposta (`DeviceHelloResponse`):

```json
{"success":true,"data":{"sessionId":"boot-7-lq3k9z","serverTime":"2026-10-26T21:00:00.000Z","nextPollMs":1500,"ackedSequence":1,"commands":[],"resync":false,"accepted":true,"reconcileRequired":false,"limits":{"supportsReverse":false,"maxActions":64,"maxMessageBytes":4096}}}
```

O servidor faz, no hello de uma sessão **nova** (reboot): invalida comandos entregues à sessão antiga (`uncertain`), e se havia missão ativa ela vira `failed` (ainda sem movimento) ou `uncertain` (já em movimento). Nada retoma sozinho. `ackedSequence` volta como 1 (o próprio hello).

`reconcileRequired:true` indica missão incerta no servidor: envie um `snapshot` logo em seguida.

## 5. `GET /device/poll`

Sem corpo. Resposta (`DeviceSyncResponse`):

```json
{"success":true,"data":{"sessionId":"boot-7-lq3k9z","serverTime":"2026-10-26T21:00:00.000Z","nextPollMs":1500,"ackedSequence":4,"resync":false,"commands":[{"v":1,"type":"start","messageId":"cmd-0002","deviceId":"RB-01","sessionId":"boot-7-lq3k9z","missionId":"RF-0113","validForMs":60000,"routeRevision":1}]}}
```

| Campo | O que o firmware faz |
|---|---|
| `nextPollMs` | agenda o próximo poll (limites 1000 a 60000). O servidor devolve 1500 com missão ou comando pendente e 30000 em repouso |
| `ackedSequence` | descarta os eventos **críticos** com `sequence ≤ ackedSequence` (ver §7) |
| `commands` | lista de comandos (ver §6), possivelmente vazia |
| `resync:true` | gere um `snapshot` e envie-o |
| `serverTime` | só para diagnóstico/sanidade do relógio; não use para assinar |

Toda resposta de `/device/events` tem os mesmos campos (`DeviceSyncResponse` + `rejected`). **Trate qualquer resposta de sincronização bem-sucedida como um poll**: aplique `nextPollMs`, `ackedSequence`, `commands` e `resync`, e reinicie o temporizador do poll. Isso economiza requisições.

## 6. Comandos (nuvem → dispositivo)

Todos têm `v`, `type`, `messageId` (= `commandId`, use em `replyTo`), `deviceId`, `sessionId`, `missionId` e `validForMs`.

| `type` | Campos extras | O que fazer |
|---|---|---|
| `load_route` | `routeRevision`, `actions[]` (`F`/`D`/`E`/`T`), `expectedNodes[]` (`"x,y"`), `startNode`, `initialHeading` (`N/E/S/W`) | Valida e guarda a fila. **Não move os motores.** Responde `ack` ou `reject` |
| `start` | `routeRevision` | Começa a executar a fila carregada |
| `stop` | — | Para os motores, estado `paused` |
| `resume` | `routeRevision`, `blockId` | Retoma, se as condições locais permitirem |
| `abort` | — | Para os motores, descarta a fila, estado `ready` |

`validForMs` é **relativo ao recebimento**: guarde `millis()` no recebimento e descarte (`reject` com `EXPIRED`) se já passou. O ESP32 não precisa de data UTC para isso.

Regras de validação local (todas rejeitam com `reject`; `replyTo` = `messageId` do comando):

| Situação | `reason` |
|---|---|
| `sessionId` do comando diferente da sessão atual | `INVALID_SESSION` |
| `load_route` com missão em `running`/`blocked` | `BUSY` |
| `load_route` com alguma ação `T` e `supportsReverse=false` | `UNSUPPORTED_ACTION` |
| `load_route` com mais ações que `maxActions` | `QUEUE_TOO_LARGE` |
| `actions` e `expectedNodes` com comprimentos diferentes, JSON inválido ou campo faltando | `MALFORMED` |
| `start` sem fila carregada ou fora do estado `ready` | `NO_ROUTE_LOADED` |
| `resume` com `blockId` diferente do bloqueio atual | `STALE_BLOCK` |
| `resume` com algum bloqueio ainda ativo (obstáculo, linha, sensor) | `BLOCKED` |
| `resume` fora de `blocked`/`paused` | `INVALID_STATE` |
| comando vencido (`validForMs`) | `EXPIRED` |

Idempotência: o servidor repete a entrega de um comando enquanto não receber o `ack`. Guarde os últimos ~16 `messageId` tratados e ignore repetições (não execute de novo). O `ack` original já está na fila de eventos críticos e será retransmitido sozinho.

Ordem de execução: processe `commands` na ordem recebida. O servidor garante um `start` e um `resume` pendentes por vez (ADR 0008); `stop` e `abort` podem chegar a qualquer momento e têm prioridade prática.

Um `stop` não é um sinal de segurança: chega com atraso de até `nextPollMs`. Veja o aviso em [PLANO_DE_BANCADA.md](PLANO_DE_BANCADA.md).

## 7. Eventos (dispositivo → nuvem)

Todo evento tem `v:1`, `type`, `messageId` (`evt-<sessionId>-<sequence>`), `deviceId`, `sessionId`, `sequence`, `uptimeMs`.

| `type` | Crítico? | Campos específicos | Quando |
|---|---|---|---|
| `ack` | sim | `replyTo`, `result:"accepted"`, `missionId?`, `routeRevision?` | comando aceito |
| `reject` | sim | `replyTo`, `reason`, `detail?` (≤ 200 caracteres) | comando recusado |
| `action_started` | não | `missionId`, `routeRevision`, `actionIndex`, `command?` | início de cada ação |
| `action_completed` | **sim** | `missionId`, `routeRevision`, `actionIndex`, `expectedNode` (`"x,y"`) | chegada **confirmada** ao cruzamento |
| `mission_completed` | **sim** | `missionId`, `routeRevision`, `completedActions` | última ação confirmada e motores desligados |
| `block_started` | **sim** | `missionId?`, `blockId`, `reasons[]` (≥ 1), `distanceCm?`, `actionIndex?` | início de **um** episódio de bloqueio |
| `block_cleared` | **sim** | `missionId?`, `blockId` | condições locais liberadas (não retoma sozinho) |
| `fault` | **sim** | `code` (≤ 64), `message` (≤ 200), `severity` (`warning`/`error`/`critical`), `missionId?` | falha |
| `snapshot` | **sim** | `state`, `missionId?`, `routeRevision?`, `completedActions?`, `actionIndex?`, `blockId?` | reconciliação |
| `telemetry` | não | `state`, `line:[0\|1,0\|1,0\|1]`, `distanceCm` (`null` se inválida), `distanceValid`, `distanceAgeMs`, `phase?`, `actionIndex?`, `missionId?`, `blockId?`, `blockReasons?` | periódica |

`reasons` de bloqueio: `obstacle`, `line_lost`, `sensor_invalid`, `sensor_stale`, `stop_requested`, `fault`. `phase` da telemetria: `aligning`, `leaving_node`, `following_segment`, `confirming_node`, `idle`.

### Regras de conteúdo que o servidor faz valer

- `action_completed` só é aceito para o **próximo índice esperado**. Duplicata (índice menor) é ignorada; salto de índice ou `expectedNode` diferente do planejado deixa a missão `uncertain` e o servidor responde `resync:true`. **Nunca presuma uma conclusão que o sensor não confirmou.**
- `mission_completed` só conclui se `completedActions` for igual ao total; caso contrário a missão fica `uncertain`.
- Um episódio de bloqueio é **um** `block_started` (uma parada contada), mesmo que surjam novos motivos: motivos novos no mesmo bloqueio vão em `block_started` repetido com o **mesmo** `blockId`. Troque o `blockId` só em episódio novo (`block-<sessionId>-<n>`).
- `block_cleared` não retoma a missão; só um `resume` aceito retoma.
- `fault` com `critical` encerra a missão como `failed`; `error` gera alerta; `warning` apenas registra.
- Distância inválida é `null` com `distanceValid:false`. **Nunca** envie um número artificial como "caminho livre".
- A telemetria **não** é persistida: só atualiza o estado "ao vivo" (no máximo uma vez a cada 5 s ou na mudança de estado/bloqueio). Mais que isso é desperdício de cota.

### `ackedSequence` e a retransmissão (regra do código, não do ADR 0002 item 8)

`ackedSequence` é a **maior `sequence` de evento crítico já processada na sessão**. Não é "a maior sequência contígua entre todos os eventos" (o ADR 0002, item 8, fala em contígua; o código e `contracts/src/device.ts` valem). Telemetria e `action_started` são descartáveis e não participam.

O firmware mantém uma fila dos críticos ainda não confirmados e, **a cada requisição de eventos**:

1. descarta da fila os críticos com `sequence ≤ ackedSequence` recebido;
2. envia **todos** os restantes, do mais antigo ao mais novo, **no mesmo lote** (até 16 e até 4096 bytes), com o `messageId` e a `sequence` originais;
3. completa o lote com eventos não críticos novos, se couber.

Reenviar é seguro: o servidor deduplica por `sequence`. Telemetria nunca é retransmitida. Se a fila crítica passar de 16 eventos, envie os 16 mais antigos e continue no próximo ciclo (sem pular).

O limite de **4096 bytes** do corpo vale para o lote inteiro. Dimensione o lote pelos bytes serializados (alvo ≤ 3800), não só pelo número de eventos; uma telemetria sozinha ocupa ~300 bytes. Acima disso o servidor responde `413 PAYLOAD_TOO_LARGE`.

Resposta (`DeviceEventsResponse`) acrescenta `rejected: [{ sequence, reason }]`, com motivos como `SESSION_MISMATCH`, `UNKNOWN_COMMAND`, `STALE_COMMAND_SESSION`. Um evento rejeitado nunca será aceito se reenviado igual: pare de retransmiti-lo e registre localmente.

## 8. Reboot, reconexão e reconciliação

| Situação | Comportamento do firmware | Efeito no servidor |
|---|---|---|
| Boot | Motores desligados, fila perdida, **nova** sessão, `hello` | Missão ativa vira `uncertain` (ou `failed` se ainda sem movimento). Nenhum `start`/`resume` automático |
| Perda de Wi-Fi/servidor sem reboot | Continua a política da §10; guarda eventos críticos | Nada muda até a reconexão |
| Reconexão sem reboot | Retoma `poll`/`events` com a mesma sessão; se a sessão for desconhecida (`409 CONFLICT_SESSION`), refaz `hello` | Reenvio dos críticos converge a missão |
| `resync:true` ou `reconcileRequired:true` | Envia um `snapshot` | O servidor alinha a missão ao dispositivo, **sem retomar o movimento** |
| `hello` na mesma sessão com `lastMission` | O servidor reconcilia `completedActions` | Lacuna vira `uncertain` e depois converge |

O `snapshot` descreve o que o **dispositivo** sabe: `state`, `missionId`, `routeRevision`, `completedActions`, `actionIndex` e `blockId`. O dispositivo é a verdade sobre o seu estado físico.

Recomendação: depois de **qualquer** `hello`, se o firmware tiver fila carregada ou progresso, envie um `snapshot` (o simulador só o faz quando o servidor pede, mas um snapshot extra é barato e evita missões presas em `uncertain`).

## 9. Erros HTTP e o que fazer

Corpo de erro: `{ "success": false, "message": "...", "error": "CODIGO" }`.

| HTTP | `error` | Causa provável | Ação do firmware |
|---|---|---|---|
| 400 | `INVALID_BODY` | Lote ou mensagem fora do schema | Bug do firmware. Divida o lote para achar o evento inválido; descarte o não crítico; para crítico, registre local e envie `fault` (`MALFORMED_EVENT`). **Não** repita o mesmo lote para sempre |
| 401 | `SIGNATURE_INVALID` | Segredo errado, `sessionId` com caracteres inválidos, corpo diferente do assinado, `X-Timestamp` decimal | Não insista rápido. Backoff exponencial até 60 s; após 5 falhas seguidas, estado de falha local visível (LED/serial). Confira o segredo e o corpo assinado |
| 401 | `CLOCK_SKEW` | Relógio fora de ±120 s | Re-sincronize NTP e tente de novo (nova requisição) |
| 401 | `REPLAY_DETECTED` | `X-Sequence` repetido/antigo, ou hello com timestamp anterior | Avance o `X-Sequence` (ex.: +1000; o servidor só exige "maior") e tente uma vez. Se repetir, trate como falha de configuração (dois aparelhos com o mesmo `deviceId`?) |
| 404 | `NOT_FOUND` | Dispositivo ausente do banco | Falha de provisionamento; avise o operador |
| 409 | `CONFLICT_SESSION` | O servidor não conhece a sessão (instância fria sem hello, banco recriado) | Refaça `hello` e depois um `snapshot` |
| 413 | `PAYLOAD_TOO_LARGE` | Corpo > 4096 bytes | Reduza o lote |
| 429 | `RATE_LIMITED` | Mais de ~240 requisições por minuto por dispositivo | Pare por ≥ 5 s com backoff; revise o ritmo (o normal é < 60/min) |
| 5xx / 503 | `INTERNAL` / `DEVICE_UNAVAILABLE` | Falha no servidor, cold start longo | Backoff exponencial de 1,5 s até 60 s, com jitter. Mantenha a fila de críticos |
| timeout / TLS | — | Rede, Wi-Fi, certificado | Timeout de conexão 10 s e de leitura 15 s; backoff; veja a política de perda de comunicação |

Cada tentativa consome um `X-Sequence` novo, tenha chegado ao servidor ou não.

Cold start do Cloud Run: a primeira resposta após ociosidade pode levar vários segundos. Use timeout de leitura ≥ 15 s e não trate isso como falha de segurança.

## 10. Perda de comunicação (ADR 0002)

- **Vetos locais são soberanos** e não dependem da nuvem: obstáculo ≤ 20 cm, leitura de distância inválida ou vencida, perda de linha fora de manobra válida, falha de sensor.
- **Nenhum poll/eventos bem-sucedido por 30 s** (valor inicial, parâmetro configurável) com missão em `running`: conclua o **trecho em andamento**, segure no **próximo cruzamento confirmado** com os motores desligados, estado `paused`, e registre `fault` `warning` com `code:"COMM_LOST_HOLD"` na fila de críticos.
- Ao reconectar **não retome sozinho**. Envie `snapshot`; o operador decide com `resume`.
- `start` e `resume` sem conexão nunca chegam (o servidor os rejeita com `503`); `stop` e `abort` são "melhor esforço" com latência ≈ `nextPollMs`.

> `COMM_LOST_HOLD` é uma convenção deste documento; o enum de `reasons` de bloqueio não tem um motivo "comunicação". Está na lista de dúvidas abertas.

## 11. Orçamento de requisições e de banda

Cota gratuita de referência (conferir em `infra/COST_ZERO.md`): Cloud Run 2 milhões de requisições por mês; Firestore 50 mil leituras e 20 mil escritas por dia; egress de rede 1 GiB por mês. **Estimativas minhas a validar com o teste de carga (OBS-004).**

Cadência-base: poll de 30 s em repouso (2.880 por dia) e 1,5 s com missão (2.400 por hora), mais telemetria a cada 5 s e uns poucos eventos.

| Cenário | Requisições/dia | por mês | % de 2 M |
|---|---:|---:|---:|
| 1 AGV, 1 h de missão por dia | ~6 mil | ~180 mil | 9 % |
| 4 AGVs, 2 h de missão por dia cada | ~36 mil | ~1,1 milhão | 54 % |

| Cenário | Leituras Firestore/dia (1 por poll + eventos) | % de 50 mil |
|---|---:|---:|
| 1 AGV, 1 h de missão por dia | ~5,4 mil | 11 % |
| 4 AGVs, 2 h de missão por dia cada | ~32 mil | 64 % (sobra pouco para o dashboard) |

**Risco que não estava nos documentos de custo: o handshake TLS.** A cadeia de certificados do `run.app` pesa ~6,5 KB (a folha sozinha tem 3,9 KB, porque o certificado cobre dezenas de domínios regionais). Cada nova conexão TLS faz o servidor enviar isso. Sem reutilizar a conexão, um poll de repouso a cada 30 s custa ~8 KB de saída da nuvem:

| Estratégia | Saída por AGV em repouso | Cabe em 1 GiB/mês? |
|---|---:|---|
| Nova conexão a cada poll | ~23 MB/dia ≈ 0,7 GB/mês | 1 AGV usa ~70 %; 2 AGVs estouram |
| Conexão reutilizada (keep-alive) entre os polls | desprezível (cada resposta ~0,5 KB) | sim |

Portanto o firmware **deve reutilizar a conexão TLS** (HTTP/1.1 keep-alive) e medir quantos handshakes faz por hora (contador local e log). Se o servidor fechar a conexão ociosa antes de 30 s, use poll de repouso de 60 s (máximo permitido) até medir. Esta é a primeira coisa a verificar no marco M3.

## 12. Limites de tamanho que o firmware precisa respeitar

| Item | Limite | Origem |
|---|---|---|
| Corpo enviado | ≤ 4096 bytes | `LIMITS.deviceBodyMaxBytes`, `capabilities.maxMessageBytes` |
| Eventos por lote | 1 a 16 | `DeviceEventsRequestSchema` |
| Ações por fila | 64 anunciadas (o schema aceita até 256) | `capabilities.maxActions` |
| `messageId` / `sessionId` / `deviceId` | 1 a 128 caracteres | `IdSchema` |
| `fault.code` / `fault.message` / `reject.detail` | 64 / 200 / 200 | schemas |
| Corpo de resposta a bufferizar | reserve 8 KB e rejeite acima | estimativa: `load_route` de 64 ações ≈ 1,3 KB de JSON; com vários comandos, bem abaixo de 8 KB |

## 13. Diferenças em relação à documentação antiga

| Documento antigo | Dizia | Vale |
|---|---|---|
| `backend/README.md` §11.1, §11.3 | Serial USB, `heartbeat` a cada 250 ms, parada após 1 s | HTTPS por poll, sem `heartbeat`, `validForMs` relativo (ADR 0001, 0002) |
| `docs/ARQUITETURA_DOS_COMPONENTES.md` §11 | Linhas de texto na serial (`STATE ...`, `LINE 0 1 0`) | Só como log de depuração; o protocolo é JSON sobre HTTPS |
| ADR 0002 item 8 | `ackedSequence` = maior sequência **contígua** | Maior sequência **crítica** processada (código e contratos) |
| `contracts/src/signing.ts` | Tolerância padrão 60 s | O backend usa 120 s (`DEVICE_CLOCK_SKEW_MS`) |
| `backend/README.md` (original) | Mensagem `heartbeat` e `mission_completed`/`fault` sem `block_*` | `block_started`/`block_cleared`/`snapshot` existem; não há `heartbeat` |
| `contracts/seed/devices.json` | Campo `secretName: "device-secret-RB-01"` | Resquício do Secret Manager, que não é mais usado. O segredo vem de `DEVICE_SECRETS_JSON` |
