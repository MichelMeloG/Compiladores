# Firmware do ESP32 — o que construir

Este documento descreve o projeto original do firmware. A implementação para Arduino IDE está em [`firmware/roboflow_esp32`](../../firmware/roboflow_esp32/README.md), com compilação e testes do núcleo C++ contra o backend. Curvas e cruzamentos ainda exigem calibração física. O simulador de referência permanece em [`backend/tools/esp-sim/sim.ts`](../../backend/tools/esp-sim/sim.ts).

**Ajuste solicitado em 28/10/2026:** no firmware implementado, o ultrassônico é **opcional**. Leitura válida pode bloquear por obstáculo; ausência de eco ou leitura vencida não veta movimento. Isso substitui, para essa implementação, os vetos por ultrassônico inválido/antigo descritos abaixo. Liberação de bloqueio não retoma a missão automaticamente. As demais tabelas e pseudocódigos abaixo são referências de projeto, não uma descrição integral de tudo que foi implementado; consulte o README do firmware para os limites e diferenças.

Hardware de referência (pinagem completa em [`../ARQUITETURA_DOS_COMPONENTES.md`](../ARQUITETURA_DOS_COMPONENTES.md)): ESP32 clássico, ponte H HW-095/L298N (ENA 25, IN1 26, IN2 27, IN3 14, IN4 23, ENB 13), sensores de linha esquerdo 32, central 34, direito 33, **infravermelho adicional 35** (acrescentado ao documento de hardware; papel ainda não definido, ver [PENDENCIAS_DE_HARDWARE.md](PENDENCIAS_DE_HARDWARE.md)), HC-SR04 TRIG 18 e ECHO 19 (com divisor de tensão).

## 1. Princípios (não negociáveis)

1. **A autoridade de movimento é local** (ADR 0002). Nenhuma mensagem da nuvem remove um veto.
2. **Motores desligados por padrão**: no reset, enquanto não houver `start` aceito, e em qualquer dúvida. Os pull-downs de 10 kΩ em ENA/ENB cobrem o reset; o software mantém a mesma regra.
3. **Uma única função de saída** para os motores. Todo pedido de velocidade passa por ela, e ela consulta o supervisor.
4. **Rede nunca bloqueia o controle.** TLS e HTTP rodam em outra tarefa, em outro núcleo.
5. **Nunca presumir progresso.** Uma ação só termina quando o sensor confirma o cruzamento.

## 2. Módulos

| Módulo | Responsabilidade | Entradas / saídas |
|---|---|---|
| `config` | Lê a NVS (Wi-Fi, `deviceId`, segredo, host, contador de boots); parâmetros calibráveis | NVS → estrutura imutável |
| `wifi` | Conecta e reconecta (2,4 GHz); expõe `online()` | — |
| `clock` | SNTP; só libera o TLS depois de `time() > 1700000000`; devolve `epochSeconds()` (64 bits) | — |
| `tls` | `WiFiClientSecure` com as raízes GTS R1 a R4 fixadas ([PROVISIONAMENTO.md](PROVISIONAMENTO.md) §3); mantém a conexão aberta | — |
| `http` | Cliente HTTP/1.1 com **keep-alive**; timeouts (conexão 10 s, leitura 15 s); limite de 8 KB de resposta | corpo → status + corpo |
| `sign` | HMAC-SHA256 (mbedtls) conforme [PROTOCOLO_DISPOSITIVO.md](PROTOCOLO_DISPOSITIVO.md) §2; valida contra [VETORES_DE_TESTE.md](VETORES_DE_TESTE.md) | bytes do corpo → 64 hex |
| `proto` | Serializa eventos (ArduinoJson, buffer fixo de 4096 B); interpreta respostas e comandos | JSON ↔ estruturas |
| `evtq` | Fila de eventos: críticos retidos até `ackedSequence`; não críticos descartáveis | ver §5 |
| `session` | `sessionId`, contador `X-Sequence`, contador de `sequence` de evento | — |
| `sensors` | Linha (3 canais + IR extra), ultrassom sem bloqueio (ISR ou RMT), idade da leitura | amostras com carimbo de tempo |
| `crossing` | Detector de cruzamento com filtro e rearme | amostras → `ChegouAoCruzamento` |
| `executor` | Fila de ações, fases por ação, contador de ações concluídas | comandos → eventos |
| `supervisor` | Vetos, liberação, bloqueios (um `blockId` por episódio) | amostras + estado → permissão |
| `motor` | Única função de saída; PWM por LEDC; `disableAll()` | — |
| `fsm` | Estado do dispositivo e política de perda de comunicação | — |
| `watchdog` | Task WDT + guarda de hardware que corta ENA/ENB | — |

## 3. Tarefas FreeRTOS e prioridades

O Wi-Fi do ESP32 clássico roda no núcleo 0 (PRO_CPU) e o `loop()` do Arduino no núcleo 1 (APP_CPU). Um handshake TLS pode ocupar a CPU por centenas de milissegundos a mais de 1 s; **não** pode atrasar o controle.

| Tarefa | Núcleo | Prioridade | Período | Faz |
|---|---|---:|---|---|
| `control` | 1 | alta (10) | 10 ms (100 Hz) | Lê sensores, roda `crossing`, `executor`, `supervisor`, chama `motor`; alimenta o watchdog |
| ISR / RMT do ECHO | 1 | — | — | Mede o pulso do HC-SR04 sem bloquear; o disparo ocorre a cada 70 ms dentro de `control` |
| `net` | 0 | média (5) | dirigida por eventos | NTP, TLS, HTTP, assinatura, ciclo poll → comando → ack → eventos |
| `housekeeping` | 0 | baixa (1) | 1 s | Estatísticas de heap, LED de estado, logs |
| Guarda de hardware (timer de 50 ms) | — | ISR | 50 ms | Se `control` não atualizou o carimbo em > 200 ms, desabilita ENA/ENB direto nos pinos |

Comunicação entre tarefas **sem memória compartilhada mutável solta**:

- `net → control`: fila `cmdQueue` (comandos já validados em formato compacto: tipo, `messageId` curto, `missionId`, `validUntilMs`, ações). Aplicação de `abort`/`stop` é lida pelo `control` a cada tick.
- `control → net`: fila `evtQueue` com eventos em estrutura compacta (não JSON). O `net` os serializa e assina.
- Estado para telemetria: cópia atômica (ou protegida por mutex curto) feita pelo `control` a cada 100 ms.

## 4. Máquina de estados do dispositivo

Estados do protocolo (`DeviceState`) e a correspondência com os nomes do documento de hardware:

| Estado no protocolo | Nome em `ARQUITETURA_DOS_COMPONENTES.md` §9.1 | Motores | Entra por | Sai por |
|---|---|---|---|---|
| `initializing` | INICIALIZANDO | desligados | boot | autoteste e relógio OK |
| `ready` | PRONTO / FINALIZADO sem missão | desligados | autoteste, `abort`, fim de missão consumido | `load_route` aceito (continua `ready` com fila) → `start` |
| `running` | SEGUINDO_LINHA | ligados via `motor` | `start` ou `resume` aceitos | veto, `stop`, fim da fila, perda de comunicação |
| `blocked` | PARADO_OBSTACULO, LINHA_PERDIDA, FALHA_SENSOR | desligados | veto local | `resume` aceito com tudo liberado, `abort` |
| `paused` | (parada solicitada) | desligados | `stop` aceito, perda de comunicação | `resume` aceito, `abort` |
| `finished` | FINALIZADO | desligados | `mission_completed` enviado | `load_route` novo, `abort` |
| `fault` | (falha crítica) | desligados | falha não recuperável | reinício |

`AGUARDANDO_ESTACAO` da linguagem RoboFlow (`wait_signal`) **não tem estado equivalente no protocolo**. Está em aberto em [RELACAO_COM_A_LINGUAGEM.md](RELACAO_COM_A_LINGUAGEM.md).

## 5. Fila de eventos e retransmissão

Regras (ver [PROTOCOLO_DISPOSITIVO.md](PROTOCOLO_DISPOSITIVO.md) §7):

- Cada evento recebe `sequence` ao ser **criado** (o hello foi o 1). `messageId = "evt-" + sessionId + "-" + sequence`.
- **Críticos** (`ack`, `reject`, `action_completed`, `mission_completed`, `block_started`, `block_cleared`, `fault`, `snapshot`) ficam num anel de **64 posições** até `sequence ≤ ackedSequence`. Cada posição é uma estrutura compacta de cerca de 64 B (≈ 4 KB no total), não o JSON.
- **Não críticos** (`telemetry`, `action_started`) nunca são retidos: se não couberem no lote, são descartados; a telemetria nova substitui a antiga.
- A cada envio, monte o lote nesta ordem: críticos pendentes do mais antigo ao mais novo, depois não críticos novos, parando em **16 eventos ou ~3.800 bytes serializados**.
- Se o anel de críticos encher (rede fora por muito tempo): descarte primeiro tudo que não for `snapshot`/`fault`, **substitua** o histórico por um `snapshot` atual e um `fault` `EVENT_QUEUE_OVERFLOW`. O servidor reconcilia pelo `snapshot`.
- Depois de um 400 do servidor, não reenvie o mesmo lote em laço: divida e isole o evento inválido.

## 6. Ciclo de rede (tarefa `net`)

Pseudocódigo, não é código final:

```
net_task():
  loop forever:
    if !wifi.online():          wifi.connect(); backoff(); continue
    if !clock.synced():         clock.sync();  continue          // NTP antes de qualquer TLS
    if !session.open:
        session.new_id()                                         // boot-<n>-<6 hex>, X-Seq=1, evt-seq=1
        r = http.post("/device/hello", hello_body())             // sequence do evento = 1
        if ok(r): apply_sync(r); session.open = true
        else:     backoff(r); continue

    // Um ciclo = enviar eventos pendentes OU consultar (poll)
    if evtq.has_pending() or now >= next_poll_at:
        if evtq.has_pending(): r = http.post("/device/events", batch_from(evtq))
        else:                  r = http.get("/device/poll")
        switch status(r):
          200: apply_sync(r)                                     // ver abaixo; reinicia o temporizador
          409 CONFLICT_SESSION: session.open = false; (re-hello, depois snapshot)
          401 CLOCK_SKEW: clock.resync()
          401 REPLAY_DETECTED: session.xseq += 1000
          401 SIGNATURE_INVALID: backoff_longo()
          413: reduzir lote
          429 / 5xx / timeout: backoff com jitter; net.lastOkMs não muda
    sleep_until(min(next_poll_at, evtq.wake_time))

apply_sync(r):
    net.lastOkMs   = millis()
    evtq.drop_critical_up_to(r.ackedSequence)
    next_poll_at   = millis() + clamp(r.nextPollMs, 1000, 60000)
    if r.resync: evtq.push(snapshot())
    for cmd in r.commands: cmdQueue.push(validate_and_translate(cmd))   // rejeita com reject() se inválido
    // eventos "reject"/"ack" são empurrados em evtq e viajam no próximo ciclo
```

Comportamentos importantes:

- Cada requisição incrementa `X-Sequence` **antes** de enviar, também quando falha por rede.
- Toda resposta 200 de `/device/events` é tratada como um poll. Assim, durante a missão, o `action_completed` já traz o próximo comando e reinicia o temporizador.
- Reutilize a conexão TLS. Se `connected()` for falso, abra de novo. Conte quantas conexões novas por hora (limite de saída de rede da nuvem; ver [PROTOCOLO_DISPOSITIVO.md](PROTOCOLO_DISPOSITIVO.md) §11).
- Assine sempre o buffer que será enviado, byte a byte, e envie `Content-Length`.
- Cold start do Cloud Run: o primeiro request depois de ociosidade pode demorar vários segundos. Isso não é falha de segurança.

## 7. Ciclo de controle (tarefa `control`)

```
control_task():  // a cada 10 ms
    s = sensors.read()                         // linha[3] (+IR 35), distância (idade em ms)
    cmd = cmdQueue.pop_nonblocking()
    if cmd: fsm.apply(cmd)                     // load_route, start, stop, resume, abort

    veto = supervisor.evaluate(s, fsm.state, executor.phase)
    //  veto: distancia<=20cm | invalida | idade>200ms | linha perdida fora de manobra | falha | stop | comm_lost
    if veto.new_episode: evtq.push(block_started(newBlockId, veto.reasons)); fsm.to(blocked)
    if supervisor.cleared(s):                  // 3 leituras >=25 cm, linha valida
        evtq.push(block_cleared(blockId))      // NAO retoma

    if fsm.state == running and !veto.any:
        out = executor.step(s)                 // fases: ALINHAR, SAIR_DO_NO, SEGUIR, CONFIRMAR
        if out.arrived_at_node:                // detector com filtro+rearme
            evtq.push(action_completed(idx, expectedNodes[idx]))
            if last_action: motor.disable(); fsm.to(finished); evtq.push(mission_completed())
    motor.set(out.left, out.right)             // UNICA saida: consulta supervisor de novo
    watchdog.kick()
```

### Executor por fases (cada ação termina no próximo cruzamento)

| Fase | Faz | Saída para a próxima | Se estourar o tempo |
|---|---|---|---|
| `aligning` | Em D/E: gira no cruzamento atual até o sensor central encontrar a linha de saída; em F: confirma o alinhamento | Linha de saída válida | `fault` `ALIGN_TIMEOUT` e bloqueio |
| `leaving_node` | Avança até sair da região do cruzamento atual; **só então** rearma a detecção | Padrão de linha simples estável por N amostras | `fault` `LEAVE_TIMEOUT` |
| `following_segment` | Segue a linha com correção; supervisor ativo | Padrão de cruzamento candidato | `fault` `ACTION_TIMEOUT` (nunca vira sucesso) |
| `confirming_node` | Exige o padrão de cruzamento estável por N amostras e tempo mínimo desde o rearme | `ChegouAoCruzamento` | `fault` `NODE_UNCONFIRMED` |

`T` (ré) não é executada: o firmware anuncia `supportsReverse:false` e rejeita `load_route` com `T` (`UNSUPPORTED_ACTION`).

Parar no meio de uma ação **não incrementa o índice**. Ao retomar, só continue a fase se a referência de linha for confiável; caso contrário, `fault` `POSITION_UNCERTAIN` e exija reposicionamento (`abort` e nova missão).

### Detector de cruzamento (parâmetros iniciais, a calibrar)

Uma leitura isolada `101` ou `111` **não prova** cruzamento (documento de hardware). Regra inicial proposta:

| Parâmetro | Valor inicial | Observação |
|---|---|---|
| Taxa de amostragem | 100 Hz | período do `control` |
| Amostras estáveis para candidato | 4 consecutivas | ~40 ms |
| Tempo mínimo desde o rearme | a medir | evita contar o cruzamento de saída de novo |
| Rearme | só depois de `leaving_node` concluída | |
| Papel do sensor IR do GPIO 35 | **indefinido** | pode virar o sensor do eixo transversal; depende da medição |

## 8. Política de perda de comunicação (ADR 0002)

- `net.lastOkMs` é atualizado a cada 200 recebida.
- Se `millis() − lastOkMs > 30000` com `running`: o executor conclui o trecho em andamento, segura no **próximo cruzamento confirmado** com motores desligados, estado `paused`, e enfileira `fault` `warning` `COMM_LOST_HOLD`.
- Ao reconectar: envia `snapshot`. **Não retoma.** Só um `resume` aceito retoma.
- `stop`/`abort` recebidos têm efeito imediato (o `control` os lê a cada tick), mas só chegam a cada `nextPollMs`.
- Vetos locais continuam valendo durante a perda de comunicação.

## 9. Watchdogs e falhas

| Falha | Reação |
|---|---|
| `control` travou (> 200 ms sem atualizar) | Guarda de hardware corta ENA/ENB; Task WDT reinicia em ~1 s; nova sessão |
| `net` travou | Não afeta o controle; a perda de comunicação chega aos 30 s |
| Falta de heap (`getMinFreeHeap()` baixo) | Log e `fault` `LOW_MEMORY`; reconectar o TLS libera memória |
| Reinício do ESP32 (qualquer causa) | Nova sessão, nenhuma retomada, motores desligados |
| Brownout (power bank) | Reinicia; ver [PENDENCIAS_DE_HARDWARE.md](PENDENCIAS_DE_HARDWARE.md) |

## 10. Orçamento de memória (estimativas a medir)

Nenhum número abaixo foi medido; **registre os reais em cada marco** (`ESP.getFreeHeap()`, `ESP.getMinFreeHeap()`, `ESP.getFreeSketchSpace()`, tamanho do binário).

| Recurso | Estimativa | Observação |
|---|---|---|
| Flash do binário (Wi-Fi + TLS + ArduinoJson + lógica) | ~1,0 a 1,2 MB | O esquema de partição padrão de 4 MB dá cerca de 1,3 MB para o app. **Escolha um esquema com mais espaço** (ex.: "Minimal SPIFFS" ou "No OTA", ~2 MB) |
| Raízes TLS | 5,3 KB (PEM, 4 raízes) | [PROVISIONAMENTO.md](PROVISIONAMENTO.md) §3 |
| RAM estática (Wi-Fi/lwIP/FreeRTOS) | dezenas de KB | Wi-Fi do ESP32 é o maior consumidor |
| Heap do TLS durante o handshake | 40 a 60 KB de pico | Não reduzir o buffer de entrada abaixo de ~8 KB (a cadeia do servidor tem 6,5 KB) |
| Raízes interpretadas (conexão aberta) | ~8 a 10 KB | |
| Buffer de envio | 4 KB fixo | corpo ≤ 4096 B |
| Buffer de resposta | 8 KB | rejeitar acima disso |
| `JsonDocument` para o `load_route` de 64 ações | ~3 a 4 KB | JSON de ~1,3 KB; filtre os campos que usa |
| Anel de críticos | ~4 KB | 64 × ~64 B |
| Pilhas | `control` 4 KB, `net` 12 a 16 KB (TLS é pesado), `housekeeping` 3 KB | |
| Folga mínima de heap desejada em operação | ≥ 60 KB livres no pico | |

## 11. Bibliotecas sugeridas

| Biblioteca | Uso | Observação |
|---|---|---|
| Arduino-ESP32 (core 3.x) | base | Confirme a versão do mbedtls embutida; verifique se há TLS 1.2 com `ECDHE-ECDSA-AES128-GCM-SHA256` |
| `WiFiClientSecure` (do core) | TLS | `setCACert(raízes)`; **nunca** `setInsecure()` |
| `HTTPClient` (do core) ou `esp_http_client` | HTTP | Habilitar reutilização de conexão; ver o contador de conexões novas |
| `mbedtls` (md/sha256) | HMAC e SHA-256 | Já faz parte do SDK |
| `ArduinoJson` 7.x | JSON | Serialize em buffer fixo; use filtros ao interpretar |
| `Preferences` (NVS) | Configuração | |
| `esp_task_wdt`, `esp_timer` | Watchdog e tempo monotônico de 64 bits | |

## 12. Não faz parte do firmware de nuvem

- Planejamento de rota, tradução de coordenadas para F/D/E, métricas e alertas: são do backend.
- Geração do sketch a partir da linguagem RoboFlow: do compilador. Ver [RELACAO_COM_A_LINGUAGEM.md](RELACAO_COM_A_LINGUAGEM.md).
- OTA e criptografia de flash: fora do POC.
