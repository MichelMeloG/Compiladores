# Plano de bancada

Roteiro de testes **progressivos**: cada etapa só começa quando a anterior passou. Nas etapas (a) a (c) **o carrinho não anda**. As etapas (d) e (e) movem as rodas e seguem o checklist de segurança física da §7.

> **Aviso que vale para todo o plano.** `stop` e `abort` vindos da nuvem são **melhor esforço**: chegam com atraso de até `nextPollMs` (≈ 1,5 s em missão) e podem não chegar. Eles **não** são dispositivo de segurança (ADR 0002). A segurança é o **veto local** (sensores no firmware) e a **chave física** de alimentação, sempre ao alcance da mão. Se um teste só passa porque o `stop` da nuvem funcionou, ele **não passou**.

## 0. Pré-requisitos

| Item | Como conferir |
|---|---|
| Vetores HMAC passam no firmware (marco M0) | 7 de 7 positivos ([VETORES_DE_TESTE.md](VETORES_DE_TESTE.md)) |
| Backend local compila e passa nos testes | `cd backend && npm ci && npm run typecheck && npm test` → 120 de 120 |
| Contratos | `cd contracts && npm ci && npm test` → 216 de 216 |
| Serviço na nuvem de pé | `curl -sS https://roboflow-api-483331439325.us-central1.run.app/health` → `{"status":"ok"}` |
| Segredo do dispositivo | no `terraform.tfvars` externo; **não** copie para arquivos do repositório |

## 1. Etapa (a): simulador contra o backend local

Objetivo: confirmar o protocolo e o backend sem hardware. É o modelo do que o firmware precisa reproduzir.

```powershell
# Terminal 1 — backend em memória, sem Firebase
cd contracts;  npm ci; npm run build
cd ..\backend; npm ci
$env:STORE='memory'; $env:AUTH_MODE='off'; $env:CORS_ORIGINS='http://localhost:3000'
$env:DEVICE_SECRETS_JSON='{"RB-02":"um-segredo-com-pelo-menos-16-chars"}'
npm run dev                                   # http://127.0.0.1:8080

# Terminal 2 — o "firmware" simulado
cd backend
npm run esp-sim -- --url http://127.0.0.1:8080 --device RB-02 --secret um-segredo-com-pelo-menos-16-chars --step-ms 2000 --obstacle-at 0 --obstacle-ms 3000

# Terminal 3 — o "operador"
$h = @{ 'Idempotency-Key'='bancada-a-1'; 'x-dev-role'='operator' }
$r = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8080/api/robots/RB-02/route -Headers $h -ContentType 'application/json' -Body '{"waypoints":[{"x":4,"y":0},{"x":3,"y":0},{"x":2,"y":0}],"initialHeading":"W"}'
$r.data.missionId        # espere o simulador carregar a fila (até nextPollMs)
$h = @{ 'Idempotency-Key'='bancada-a-2'; 'x-dev-role'='operator' }
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/missions/$($r.data.missionId)/start" -Headers $h -ContentType 'application/json' -Body '{}'

# O simulador para por obstáculo depois da 1ª ação (--obstacle-at 0) e libera sozinho após 3 s.
# Consulte o bloqueio e retome explicitamente (o blockId aparece no estado de execução):
$x = Invoke-RestMethod -Uri "http://127.0.0.1:8080/api/missions/$($r.data.missionId)/execution" -Headers @{ 'x-dev-role'='operator' }
$x.data.blockId
$h = @{ 'Idempotency-Key'='bancada-a-3'; 'x-dev-role'='operator' }
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8080/api/missions/$($r.data.missionId)/resume" -Headers $h -ContentType 'application/json' -Body (@{ blockId = $x.data.blockId } | ConvertTo-Json)
```

Suíte de contrato contra o servidor local (já documentada em `backend/DEV.md`):

```powershell
npm run contract:test -- --base-url http://127.0.0.1:8080 --device-secret um-segredo-com-pelo-menos-16-chars --device-id RB-02 --allow-mutations
```

| Critério de aceite | Medida |
|---|---|
| Hello, carga da fila, `start`, progresso por cruzamento, obstáculo, `resume`, conclusão | missão termina `completed` com `completedActions = 2` |
| Obstáculo conta **uma** parada | `stopCount = 1` |
| Suíte de contrato | 49 de 49 passam (4 exigem tokens e são pulados) |

**Verificado na redação deste documento (27/10/2026, backend em memória na porta 8091, mesmos comandos, simulador `RB-02` com `--obstacle-at 0`):** rota aceita (`F,F`), `load_route` entregue, `start`, bloqueio por obstáculo (`stopCount = 1`), `resume` com o `blockId` lido de `/execution`, missão `completed` com 14 eventos e 8 s de duração. Em Windows use `127.0.0.1` em vez de `localhost`: o `localhost` resolve para IPv6 (`::1`) primeiro, o servidor só ouve em IPv4 e o PowerShell 5.1 fica esperando.

## 2. Etapa (b): ESP32 sem motores contra o backend local

Objetivo: o **firmware real** reproduz o que o simulador faz, falando com o backend local.

Preparação:

- Rode o backend com `HOST 0.0.0.0` (já é o padrão do `main.ts`). Libere a porta 8080 no firewall do Windows para a rede privada. Use o IP do computador (não `localhost`).
- Para esta etapa o backend local é HTTP simples. Compile o firmware com um **modo de bancada em HTTP** (sem TLS), usado **somente** aqui. O modo de produção sempre valida a cadeia TLS.
- **Desligue a alimentação dos motores** (ou remova os jumpers de ENA/ENB); ESP32 só pela USB.
- Use o ponto de acesso do celular se a rede do local isolar clientes ou bloquear NTP.

| # | Teste | Critério de aceite |
|---|---|---|
| b1 | Wi-Fi + NTP + `hello` | `GET /api/devices/<id>/status` mostra `online`, `sessionId`, `firmwareVersion` em ≤ 15 s depois de ligar |
| b2 | Poll em repouso | `nextPollMs` ≈ 30000; ≤ 3 requisições por minuto no log do servidor |
| b3 | Enviar rota pela API; firmware aceita `load_route` | `ack` aceito; missão `ready` |
| b4 | `start`; execução **fictícia** (um temporizador no lugar dos sensores) com 3 ações | `action_completed` para cada índice, `mission_completed`; missão `completed` com ações = 3 |
| b5 | Bloqueio: cubra o ultrassom com a mão | `block_started` único; `stopCount` +1 por episódio, não por amostra |
| b6 | `resume` com `blockId` correto e obstáculo removido | missão volta a `running` |
| b7 | `resume` com `blockId` antigo | `reject` `STALE_BLOCK` |
| b8 | Duplicata de comando (reenvio do mesmo `messageId`) | executado **uma** vez |
| b9 | Comando com `T` | `reject` `UNSUPPORTED_ACTION` |
| b10 | Fila com 65 ações | `reject` `QUEUE_TOO_LARGE` |

## 3. Etapa (c): ESP32 contra o Cloud Run real

O backend já está implantado em `https://roboflow-api-483331439325.us-central1.run.app` (projeto `compiladores-512823`, `us-central1`, Firestore criado e semeado com `RB-01` a `RB-04`). O simulador já fez `hello` com HMAC contra essa URL com sucesso (a sessão ficou gravada em `robots/RB-03`).

### (c1) Simulador contra a URL real

Passe o segredo por variável de ambiente (**não** na linha de comando, para não ficar no histórico do terminal). O segredo do `RB-03` está em `~/.roboflow-infra/terraform.tfvars`, fora do repositório; não o copie para nenhum arquivo versionado.

```powershell
cd backend
$env:DEVICE_SECRET = '<segredo do RB-03, do tfvars externo>'
npm run esp-sim -- --url https://roboflow-api-483331439325.us-central1.run.app --device RB-03
```

Sem `--secret`, a CLI lê `DEVICE_SECRET`. Esperado: `hello ok (sessão boot-...)`. Encerre com Ctrl+C.

> **Não deixe o simulador rodando.** `backend/tools/esp-sim/cli.ts` consulta o servidor a cada ~250 ms enquanto está em `ready` (linha `sim.state === 'ready'`), **ignorando** `nextPollMs`. Isso não é a cadência do firmware (que deve respeitar `nextPollMs`: 30 s em repouso). Contra a nuvem, ele gera ~4 requisições por segundo, cada uma com 1 leitura do Firestore: ~345 mil por dia, **sete vezes** a cota gratuita de 50 mil leituras. Rode por alguns minutos e feche com Ctrl+C. Confirmado nesta revisão: com o backend local, o `load_route` chegou em segundos mesmo com o intervalo de repouso de 30 s.

### (c2) Firmware real contra a URL real

| # | Teste | Critério de aceite |
|---|---|---|
| c1 | TLS com as raízes GTS R1 a R4 fixadas | Conecta. **Teste negativo:** remova a R1 do conjunto e confirme que a conexão **falha** (prova que a verificação está ativa) |
| c2 | Heap durante o handshake | Pico de heap e `getMinFreeHeap()` registrados; mínimo livre ≥ 40 KB |
| c3 | Conexão reutilizada | Número de conexões TLS novas por hora registrado; objetivo ≤ 2/h em repouso (ver custo de saída em [PROTOCOLO_DISPOSITIVO.md](PROTOCOLO_DISPOSITIVO.md) §11) |
| c4 | `hello` e poll em repouso por 1 h | Sem erro 401/409/429; requisições ≈ 120 |
| c5 | Cold start | Depois de 15 min sem tráfego, o primeiro `poll` conclui sem erro de timeout; tempo registrado |
| c6 | Relógio errado de propósito (+5 min) | `401 CLOCK_SKEW`; o firmware re-sincroniza o NTP e se recupera em ≤ 30 s |

> **Dependência para missão completa na nuvem.** Os endpoints de operador (`/api/*`) em produção exigem um **ID token do Firebase** (e-mail na lista permitida). O projeto ainda não tem login Firebase configurado nem o painel (FE-050), e `AUTH_MODE=off` é proibido na nuvem. Enquanto isso não existir, só os testes de repouso acima (hello, poll, telemetria ociosa) são possíveis contra a nuvem. Rotas e `start` em produção dependem de resolver esse acesso. Pergunta aberta no README.

## 4. Etapa (d): rodas suspensas

Carrinho sobre um calço, rodas **no ar**, alimentação de motores pelo power bank, chave física à mão. Backend na nuvem.

| # | Teste | Critério de aceite |
|---|---|---|
| d1 | Autoteste: motores desligados no reset e em `ready` | Rodas paradas no boot, no hello e no `load_route` |
| d2 | `start` com a fila de 3 ações; passe uma fita sob os sensores para simular cruzamentos | Rodas giram só em `running`; um `action_completed` por cruzamento confirmado |
| d3 | **Veto de obstáculo**: aproxime um alvo plano a ≤ 20 cm | Rodas param em ≤ 100 ms contados do dado válido; `block_started` único |
| d4 | Leitura inválida: desconecte o ECHO ou cubra o sensor | Rodas param; nunca "caminho livre" |
| d5 | Leitura vencida (> 200 ms sem atualizar) | Rodas param |
| d6 | Perda de linha fora de manobra | Rodas param; `block_started` `line_lost` |
| d7 | Liberação | Após 3 leituras ≥ 25 cm o firmware envia `block_cleared`, mas **só retoma** com `resume` aceito |
| d8 | `stop` remoto | Aceito; **registrar a latência real** do envio até as rodas pararem (esperado ≈ `nextPollMs`) |
| d9 | Perda de Wi-Fi com missão em `running` (desligue o AP) | Rodas continuam até o fim do trecho, seguram no próximo cruzamento; aos 30 s o estado é `paused` e há `fault` `COMM_LOST_HOLD` quando a rede volta; **não retoma sozinho** |
| d10 | Reboot do ESP32 no meio da ação (pressione EN) | Rodas desligam no reset; nova sessão; no servidor a missão fica `uncertain`; nada retoma |
| d11 | Perda de evento crítico (derrube a rede por alguns segundos durante `action_completed`) | Depois da reconexão os críticos são retransmitidos do mais antigo ao mais novo; a missão converge sem duplicar nem pular |
| d12 | `abort` | Rodas param, fila descartada, estado `ready` |
| d13 | Queda de tensão no power bank com motores acelerando | Não reinicia (brownout) ou, se reiniciar, motores desligam e a nova sessão marca incerteza |

## 5. Etapa (e): pista

Só depois de (d) inteira. Baixa velocidade (PWM baixo), pista livre, uma pessoa com a mão na chave física, obstáculos de espuma.

| # | Teste | Critério de aceite |
|---|---|---|
| e1 | Seguir linha reta por 1 segmento | Para no cruzamento certo, um `action_completed` |
| e2 | Rota `F, D, E` (3 ações) | Cada ação termina em **exatamente um** cruzamento; fim da fila desliga os motores |
| e3 | Repetir a rota 10 vezes | 10 de 10 corretas; sem cruzamento duplicado nem pulado |
| e4 | Parada por obstáculo e retomada explícita | Distância real de parada registrada (ver [PENDENCIAS_DE_HARDWARE.md](PENDENCIAS_DE_HARDWARE.md)) |
| e5 | Retirada manual do carrinho durante a missão | Posição incerta; exigir reposicionamento (`POST /api/robots/:id/position`) antes de nova missão |
| e6 | Velocidade maior, só depois de registrar a distância de parada | A distância de parada medida é menor que a distância de detecção |

## 6. O que registrar em cada execução

| Registro | Onde |
|---|---|
| Data, versão do firmware, versão do `contracts`, commit do repositório | planilha ou arquivo do ensaio |
| `deviceId`, `sessionId`, `missionId` | log do firmware + painel |
| Heap livre mínimo, tamanho do binário, nº de conexões TLS novas por hora | log do firmware |
| Latências: comando → rodas (stop/abort), hello → online, cold start | cronômetro ou log com `uptimeMs` |
| Distância de parada medida com régua (PWM, bateria, piso) | planilha |
| Erros HTTP vistos (código e contagem) | log do firmware |
| Para cada falha: o que o firmware fez, o que o servidor registrou | anotar lado a lado |

## 7. Checklist de segurança física (toda sessão com rodas ou pista)

- [ ] Chave física de alimentação **acessível** e testada antes de cada sessão.
- [ ] Rodas suspensas em (d); carrinho **nunca** sobre a mesa livre com motores ligados.
- [ ] Pull-downs de 10 kΩ em ENA e ENB instalados (motores não ligam no reset).
- [ ] Divisor de tensão do ECHO conferido: **nunca** 5 V direto no GPIO 19.
- [ ] Jumper 5V-EN do regulador do L298N retirado conforme `ARQUITETURA_DOS_COMPONENTES.md`.
- [ ] Fios soltos fixados; nada no caminho das rodas.
- [ ] Área de teste livre de pessoas e animais; velocidade baixa na primeira rodada.
- [ ] Segunda pessoa sabe onde está a chave.
- [ ] Antes de energizar: conferir tensões (5 V e 3,3 V) e GND comum.
- [ ] Sem USB e power bank conectados ao mesmo tempo no 5 V do ESP32 (ver documento de hardware).
- [ ] Todo ensaio de (d) em diante registra a distância de parada medida.
