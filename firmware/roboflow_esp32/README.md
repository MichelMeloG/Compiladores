# Firmware ESP32 para o backend RoboFlow

Abra **`roboflow_esp32.ino`**, mantendo os arquivos `.cpp` e `.h` desta pasta juntos. O sketch original `codigoteste/codigoteste.ino` foi preservado.

Este firmware conecta o ESP ao Wi-Fi existente e à API do backend. Recebe `load_route`, `start`, `stop`, `resume` e `abort`; executa `F/D/E` na pista; envia sensores, confirmações, cruzamentos, bloqueios e falhas. A rota fica no ESP durante a missão. O backend não envia PWM para cada motor: a correção da linha e a execução das curvas precisam acontecer localmente, a cada 10 ms.

**Limite de validação:** compilação e testes de protocolo/controle com sensores simulados não calibram o robô físico. A velocidade e a geometria das curvas ainda precisam de ensaio na pista. Não há encoder nem identificação absoluta de cruzamentos; a posição resulta da contagem de cruzamentos confirmados a partir da origem declarada.

## 1. Gravar na placa

Na Arduino IDE:

1. Instale o pacote **esp32 by Espressif Systems** (core 3.x; compilação conferida com 3.3.12).
2. Instale **ArduinoJson**, de Benoit Blanchon (7.x; usado 7.4.2).
3. Abra `roboflow_esp32.ino` e selecione **ESP32 Dev Module**, para o ESP32 clássico de dois núcleos.
4. Selecione a partição **No OTA (2MB APP/2MB SPIFFS)** e a porta da placa.
5. Grave e abra o monitor serial em **115200**, com final de linha **Nova linha**.

O código mantém os motores parados no boot e enquanto não houver `start` aceito. O controlador e a rede rodam em núcleos separados. Há guarda de controle a 200 ms e watchdog de aproximadamente 1 s. Os pull-downs físicos dos enables continuam necessários para manter os motores desabilitados durante reset, antes do software executar.

## 2. Informar Wi-Fi e identidade

Na primeira inicialização, sem configuração salva, o ESP entra no modo de configuração. Para reconfigurar posteriormente, pressione RESET e envie `config` nos primeiros 5 segundos.

Envie **uma única linha JSON** pelo monitor serial, substituindo os valores:

```json
{"ssid":"SUA_REDE_2G4","wpass":"SENHA_WIFI","devid":"RB-01","secret":"MESMO_SEGREDO_CADASTRADO_NO_BACKEND","url":"https://SEU_SERVICO.run.app"}
```

- `url`: endereço base do backend, **sem `/api` e sem `/device`**. A URL implantada está registrada em `docs/agv/PROVISIONAMENTO.md`; confira o ambiente que pretende usar.
- `devid`: robô previamente cadastrado no backend.
- `secret`: exatamente o valor correspondente em `DEVICE_SECRETS_JSON`; não é o token de login da dashboard. Não envie o segredo pelo chat nem o versione.
- A rede precisa permitir NTP (UDP 123) e acesso ao backend. O relógio é necessário para a assinatura e validação TLS.

A configuração fica na NVS, namespace `roboflow`. O firmware não imprime as credenciais. Não há necessidade de editar o código para colocar senhas. Depois de salvar, reinicia automaticamente.

Para um backend **local**, use o IP do computador acessível pelo ESP (ex.: `http://192.168.1.10:8080`, nunca `localhost`) e altere `ALLOW_LOCAL_HTTP` em `settings.h` para `true`. O padrão usa HTTPS com validação de certificado. `trust_roots.h` contém as quatro raízes públicas GTS do Cloud Run; outro provedor HTTPS pode exigir outra raiz.

## 3. Pinagem preservada

| Componente | GPIO |
|---|---|
| Motor esquerdo EN / IN1 / IN2 | 25 / 26 / 27 |
| Motor direito EN / IN1 / IN2 | 13 / 14 / 23 |
| Linha esquerda / centro / direita | 32 / 34 / 33 |
| Ultrassônico TRIG / ECHO | 18 / 19 |

`NIVEL_PRETO = 1` corresponde a `HIGH` no sketch fornecido. Na telemetria, `1` significa detecção de preto; `0`, ausência. GPIO 34 é entrada sem pull-up interno. O ECHO do HC-SR04 deve chegar ao ESP em nível de 3,3 V pelo divisor já previsto no projeto. GPIO 35 não é usado, pois não participa do sketch fornecido nem do contrato de três sensores.

## 4. Ultrassônico opcional — comportamento solicitado

`ultrasonicRequired = false` é o padrão:

| Situação | Comportamento |
|---|---|
| Sem sensor, sem eco, eco fora da faixa ou leitura com mais de 200 ms | Não veta movimento por distância; envia `distanceValid:false`, `distanceCm:null`. |
| Leitura válida de até 20 cm | Para localmente e envia `block_started` com motivo `obstacle`. |
| Após obstáculo, três leituras consecutivas de pelo menos 25 cm | Envia `block_cleared`; aguarda `resume` do operador. |
| Após obstáculo, deixa de haver leitura válida | Também libera o veto de distância e informa `block_cleared`; aguarda `resume`. |

Ausência de eco não permite distinguir “sensor ausente” de “objeto sem retorno”; ambos seguem a regra solicitada. Esse comportamento substitui, neste firmware, o requisito anterior dos documentos que bloqueava por sensor inválido/antigo. A perda de linha continua sendo um bloqueio independente.

## 5. Ajustar cruzamentos e curvas

Os ajustes ficam em **`settings.h`**, em `MotionSettings`:

| Parâmetro | Inicial | Ajuste |
|---|---:|---|
| `straight` | 200 | PWM de reta do sketch de teste. Não é velocidade em m/s. |
| `inner` / `outer` | 155 / 255 | Correções suaves da linha. |
| `correctionReverse` | 180 | Correção forte, como no sketch original. |
| `turnPwm` | 180 | PWM dos motores em sentidos opostos durante D/E. |
| `centerBeforeTurnMs` | 120 ms | Avanço para colocar o eixo no centro do cruzamento antes de girar. |
| `turnMinimumMs` | 180 ms | Tempo mínimo de giro antes de aceitar a nova linha. |
| `turnTimeoutMs` | 2500 ms | Falha se não reencontrar a linha de saída. |
| `stableSamples` | 4 | Exige quatro leituras consecutivas, separadas por 10 ms. |
| `crossingRequiresCenter` | `false` | Reconhece `101` ou `111`; `true` aceita apenas `111`. |
| `minimumSegmentMs` | 180 ms | Intervalo mínimo após sair do nó para reconhecer outro. |
| `leaveTimeoutMs` / `actionTimeoutMs` | 3000 / 15000 ms | Limites de saída do nó e de execução do trecho. |

Sequência de calibração:

1. Confirme polaridade dos sensores e direção dos motores usando seu sketch de teste. Inverta `INVERTER_ESQ/DIR` se necessário.
2. Posicione no cruzamento e informe a mesma origem/orientação na dashboard. Comece com uma rota de **um trecho F** e confira se sai do nó inicial, reconhece o seguinte e para.
3. Confira o padrão real do cruzamento antes de alterar `crossingRequiresCenter`. Tempo decorrido sozinho nunca confirma chegada.
4. Teste uma rota de um trecho **D**, depois **E**. Ajuste primeiro o avanço `centerBeforeTurnMs` para centralizar o eixo; depois `turnPwm` e `turnMinimumMs` para reencontrar a linha de saída.
5. O giro só termina após o sensor central deixar a linha antiga e voltar a detectar exclusivamente a linha de saída por quatro amostras. Se houver timeout, ajuste a mecânica/parâmetros; o firmware não transforma timeout em sucesso.
6. Teste obstáculo, retirada de obstáculo, perda de linha e `stop` antes de executar rotas maiores.

Uma parada durante `aligning` mantém a referência de giro como incerta: `resume` é recusado. Use `abort`, reposicione e carregue nova rota. Ré (`T`) não é anunciada nem executada.

## 6. Fluxo e comunicação

1. ESP envia `hello`, assinado com HMAC-SHA256, com sessão única por boot.
2. A dashboard envia a rota. ESP recebe `load_route`, valida e responde `ack`, sem movimentar.
3. Operador pede `start`; ESP confirma e segue linha localmente.
4. Em cada chegada confirmada envia `action_completed` com índice e `expectedNode`.
5. Na última chegada, desliga motores e envia `mission_completed`.

`POST /device/events` leva telemetria e críticos e também recebe comandos na resposta; funciona como consulta ao servidor. `GET /device/poll` está implementado para consultas sem eventos. A próxima telemetria respeita `nextPollMs`; críticos podem antecipar a consulta, limitados a duas requisições por segundo. Eventos críticos são reenviados em ordem até `ackedSequence`; cada lote contém no máximo 16 eventos e 3900 bytes. Novos eventos não passam à frente de críticos antigos. `action_started` é opcional no contrato e não é emitido nesta versão.

Comandos repetidos são reconhecidos por `messageId` e não repetem movimentos. A validade `validForMs` começa no recebimento da resposta e inclui o tempo na fila até aplicar o comando. `stop` e `abort` têm efeito no próximo ciclo local após recebimento; o tempo de entrega depende da rede/poll.

Na API do operador, `resume` exige `blockId` não vazio. Para bloqueio real, use exatamente o ID informado pelo ESP. Para uma pausa por `stop`/comunicação sem bloqueio, o backend atual aceita um identificador como `operator-pause`; essa exigência vem de `ResumeRequestSchema`, mesmo quando `/execution` informa `blockId:null`.

Depois de 30 s sem resposta do backend, conclui o trecho atual dentro de seu timeout, para no próximo cruzamento e envia snapshot de estado `paused`. Não inicia o próximo trecho nem retoma sozinho. Falhas locais continuam parando imediatamente. Reboot perde a fila e cria nova sessão: eventual missão antiga deve ser reconciliada/encerrada no backend antes de uma nova rota.

O histórico local guarda até 256 comandos por boot; ao atingir o limite, entra em falha e exige reinicialização. A fila de críticos guarda até 64 entradas; próximo do limite, para com `EVENT_QUEUE_OVERFLOW` antes de perder confirmações. Falha crítica exige reinício e resolução da missão no backend.

## 7. Verificação reproduzível

Compilação (raiz do repositório; `arduino-cli` deve estar no PATH):

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=no_ota --build-path build/roboflow-esp32 firmware/roboflow_esp32
```

Teste do **mesmo C++** contra o backend em memória, sem motores e sem acesso ao serviço de produção. Use um compilador C++17, como `clang++`, `g++` ou `zig c++`:

```powershell
# Ajuste a pasta da biblioteca se o sketchbook da Arduino IDE estiver em outro lugar.
zig c++ -std=c++17 -I "$env:USERPROFILE/Documents/Arduino/libraries/ArduinoJson/src" firmware/tests/bridge.cpp -o build/firmware-bridge.exe
npm --prefix contracts ci
npm --prefix contracts run build
npm --prefix backend ci
$env:FIRMWARE_TEST_BINARY = (Resolve-Path build/firmware-bridge.exe).Path
npm --prefix backend test -- --run test/firmware-core.test.ts
```

Os testes injetam leituras no controlador real e enviam os JSON produzidos ao backend. Validam formas dos eventos, missão completa, ré recusada, sessão/revisão/validade, ultrassônico opcional, bloqueio, stop/resume/abort, retransmissão, curvas e timeouts. Sem `FIRMWARE_TEST_BINARY`, esse arquivo de testes fica explicitamente pulado.

A camada Wi-Fi/TLS, ISR do ultrassom, PWM e watchdog foi compilada para o ESP, mas exige execução na placa para validação elétrica e temporal. A assinatura possui autoteste no boot usando o vetor público do repositório. Raízes TLS podem ser regeneradas com `node firmware/tools/update-trust-roots.mjs`, que confere fingerprints antes de escrever.

Referências técnicas consultadas: [Arduino-ESP32 LEDC](https://docs.espressif.com/projects/arduino-esp32/en/latest/api/ledc.html), [ArduinoJson 7](https://arduinojson.org/v7/api/jsondocument/), [Google Trust Services](https://pki.goog/repository/). Contratos locais: `contracts/src/device.ts` e `contracts/src/signing.ts`.
