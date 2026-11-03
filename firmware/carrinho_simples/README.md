# Carrinho: um único arquivo `.ino`

Abra [`carrinho_simples.ino`](carrinho_simples.ino) na Arduino IDE. Ele lê os três
sensores de linha, envia os bits por HTTP e aplica a potência recebida para cada
motor. Toda decisão de seguimento de linha, curva, cruzamento e progresso está em
[`sensor-control.ts`](../../backend/src/services/sensor-control.ts), no backend.

Este é o modelo do código que o futuro compilador da linguagem deve gerar.
Não há runtime auxiliar, fila de rota ou identificação de cruzamento no ESP32.

## Configuração

No início do `.ino`, preencha `SSID`, `SENHA`, `URL`, `ROBO` e `TOKEN`.
`TOKEN` corresponde ao segredo desse robô em `DEVICE_SECRETS_JSON` do backend.
Não versione o arquivo depois de preencher credenciais reais.
Use **ESP32 Dev Module**, core **3.x**, **ArduinoJson 7** e partição **No OTA**.

| Componente | GPIO |
|---|---|
| Motor esquerdo EN / IN1 / IN2 | 25 / 26 / 27 |
| Motor direito EN / IN1 / IN2 | 13 / 14 / 23 |
| Sensores esquerdo / central / direito | 32 / 34 / 33 |

HIGH significa sensor ativo (preto). Esta versão lê os três sensores digitais de
linha; não lê o ultrassônico. O backend define os valores de PWM.

## Backend local

O ESP precisa conversar com o backend na mesma rede Wi-Fi, usando o IP do computador.
Inicie o backend com `STORE=memory`, `AUTH_MODE=off`, `SEED_PROFILE=clean` e os segredos
dos dispositivos definidos, conforme [`backend/.env.example`](../../backend/.env.example).
Por exemplo, use `DEVICE_SECRETS_JSON={"RB-01":"troque-por-um-segredo-longo"}` e
coloque esse mesmo segredo em `TOKEN` no sketch.
O arquivo `.ino` usa HTTP local e não se conecta diretamente ao Cloud Run HTTPS.

O intervalo é de aproximadamente 50 ms mais o tempo da requisição. Esse caminho é
de controle frequente; executá-lo com Firestore produz uma transação por amostra e
não tem o perfil de cota do protocolo antigo por poll. A velocidade e as curvas
precisam ser ajustadas na pista com o backend local.

`POST /device/sensors`, com `X-Device-Id` e `Authorization: Bearer <segredo>`:

```json
{"line":[0,1,0],"boot":"boot-123","sequence":2,"applied":1}
```

```json
{"success":true,"data":{"sequence":2,"left":150,"right":150}}
```

`boot` identifica o reinício, `sequence` ordena as leituras e `applied` informa a
última resposta aplicada aos motores. São metadados de transporte. A rota e todo
o estado do controlador ficam no backend, em transação com o estado do robô.

O operador continua usando a dashboard para carregar, iniciar, parar, retomar ou
cancelar a rota. O backend confirma o cruzamento pelos sensores laterais ativos
em quatro amostras, depois de confirmar a saída do cruzamento anterior. Curvas
exigem abandonar a linha antiga e reencontrar a linha central; tempo não confirma
chegada. Sem linha, o backend bloqueia. Sem comunicação, o ESP fica parado enquanto
aguarda uma resposta; o backend exige retomada após uma lacuna de 1,5 s. Reinício
durante o movimento deixa a posição incerta.

## Validação

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=no_ota firmware/carrinho_simples
npm --prefix contracts run build
npm --prefix backend test -- --run test/sensor-control.test.ts
```

Compilação verificada com ESP32 **3.3.12**, ArduinoJson **7.4.2** e `no_ota`.
O sketch ocupa 936.891 bytes de programa e 48.508 bytes de variáveis globais.
A execução física e a calibração na pista ainda não foram realizadas.
