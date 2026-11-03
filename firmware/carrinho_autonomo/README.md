# Carrinho na bateria com controle pela dashboard

O único arquivo a gravar no ESP32 é **`carrinho_autonomo.ino`**.
O backend planeja a rota; o ESP32 executa os trechos e corrige a linha localmente.
Wi-Fi e HTTP rodam em uma tarefa separada, sem esperar respostas no controle dos
motores. O sketch original permanece em `../carrinho_simples/`.

## O que acontece ao ligar

1. Configura os pinos e mantém os motores parados durante 3 segundos.
2. Conecta ao Wi-Fi e sincroniza o relógio para autenticar as mensagens.
3. Apresenta o robô ao backend e fica aguardando uma rota.
4. Recebe e confirma a fila, ainda parado.
5. Começa somente após **Iniciar** na dashboard.
6. Executa cada ação localmente, informa os cruzamentos e para no destino.

Não precisa de computador conectado por USB nem de botão físico para operar.
O servidor precisa estar acessível pelo Wi-Fi: pode rodar em outro computador
ou em um serviço hospedado. Bateria é a alimentação, não substitui essa conexão.

## 1. Preparar o backend local

Na raiz do projeto, instale as dependências se necessário:

```powershell
npm --prefix contracts ci
npm --prefix contracts run build
npm --prefix backend ci
npm --prefix dashboard ci
Copy-Item backend/.env.example backend/.env
```

No `backend/.env`, configure:

```dotenv
STORE=memory
AUTH_MODE=off
SEED_PROFILE=clean
PORT=8080
CORS_ORIGINS=http://localhost:3000
DEVICE_SECRETS_JSON={"RB-01":"troque-por-um-segredo-longo-e-aleatorio"}
```

O cadastro limpo contém os robôs e o mapa, sem missões de demonstração.
O segredo precisa ter pelo menos 16 caracteres. Coloque o mesmo valor no sketch
e não versione credenciais reais. O ID precisa ser igual nos dois lados.

Inicie com o comando que carrega o `.env`:

```powershell
npm --prefix backend run dev:local
```

`STORE=memory` perde as missões ao reiniciar o servidor. Se isso acontecer durante
uma execução, reconecte, reinicie o carrinho parado e confirme novamente a origem.
O protocolo pede reconciliação quando o ESP ainda lembra de uma rota perdida no
servidor. Persistência e autenticação de produção já existentes no backend devem
ser configuradas separadamente para um serviço hospedado; `AUTH_MODE=off` é local.

## 2. Configurar e gravar o sketch

Na Arduino IDE, use **ESP32 Dev Module**, pacote ESP32 **3.x**, biblioteca
**ArduinoJson 7** e partição **No OTA**. Abra `carrinho_autonomo.ino`.

Preencha no início:

| Campo | Valor |
|---|---|
| `SSID` / `SENHA` | Rede Wi-Fi acessível ao carrinho |
| `URL` | Ex.: `http://192.168.1.10:8080`, IP do computador servidor, sem `/api` e sem barra final |
| `ROBO` | `RB-01`, ou outro ID cadastrado |
| `TOKEN` | O segredo desse ID em `DEVICE_SECRETS_JSON` |
| `SERVIDOR_NTP` | Servidor de horário acessível pela rede; padrão `pool.ntp.org` |
| `CA_CERT` | Certificado PEM da CA quando a URL usar HTTPS |

`localhost` na URL do ESP32 não aponta para o computador. Confira se o IP/porta
do backend está acessível pela rede. O NTP também precisa estar acessível: sem
horário sincronizado, o carrinho permanece parado e não autentica no backend.
Para HTTPS, o sketch exige a CA e não desliga a verificação do certificado.

Grave o programa por USB uma vez. Depois ele pode ser alimentado pela bateria,
com a alimentação adequada ao ESP32 e ao driver dos motores.

## 3. Abrir a dashboard e operar

Em outro terminal:

```powershell
npm --prefix dashboard run dev
```

Abra `http://localhost:3000`, selecione **RB-01** e **Definir rota**.
O Vite encaminha `/api` ao backend local na porta 8080; deixe `VITE_API_URL=/api`
e `VITE_DEMO` desativado/ausente. Se já houver `dashboard/.env` com outra URL,
ajuste esse arquivo. A página de demonstração publicada não controla o carrinho.

1. Espere a conexão do robô aparecer.
2. Posicione o carrinho no primeiro cruzamento e escolha o rumo inicial.
3. Monte a rota, confirme a posição física e clique **Carregar rota**.
4. Espere **Pronto para iniciar**, que depende da confirmação do ESP32.
5. Clique **Iniciar**. Acompanhe trechos, sensores e último nó confirmado.
6. **Parar** preserva o progresso; **Retomar** exige linha/estado válidos.
   **Cancelar** interrompe e descarta a fila.

Cada pedido mostra seu resultado: pendente, confirmado, recusado, expirado ou
incerto. Um HTTP 202 não comprova que os motores pararam. O intervalo de consulta
é normalmente 1,5 s em missão e até 3 s parado para este firmware, somado ao tempo
da rede. A dashboard consulta a API a cada 2 s; sensores persistidos podem ter
até o intervalo de atualização do backend (5 s). Não é uma transmissão a cada 10 ms.

Após reiniciar o ESP32 durante uma missão, a fila é perdida e o backend mantém
a missão incerta. Com o carrinho novamente conectado e parado, um administrador
pode **Encerrar missão incerta**, reposicionar e cadastrar outra rota.

## Pinagem e calibração

| Componente | GPIO |
|---|---|
| Motor esquerdo EN / IN1 / IN2 | 25 / 26 / 27 |
| Motor direito EN / IN1 / IN2 | 13 / 14 / 23 |
| Sensores esquerdo / central / direito | 32 / 34 / 33 |

As correções mantêm três leituras iguais antes de mudar a direção:

| Sensores E/C/D | Correção no trecho | PWM esquerdo / direito |
|---|---|---|
| `010` | Em frente | 150 / 150 |
| `110` | Esquerda suave | 110 / 150 |
| `100` | Esquerda forte | 60 / 150 |
| `011` | Direita suave | 150 / 110 |
| `001` | Direita forte | 150 / 60 |
| `000` | Bloqueia imediatamente fora da fase de curva | 0 / 0 |
| `101` / `111` | Cruzamento: interpretado conforme a fase da ação | Depende da fase |

- `NIVEL_LINHA`: `HIGH` ativo; mude para `LOW` se o sensor for invertido.
- `SENTIDO_E/D`: use `-1` se um motor girar ao contrário; confira com rodas suspensas.
- `POTENCIA_*`: PWM inicial, precisa de calibração física.
- `ALINHAMENTO_MS`: avanço curto antes de girar no cruzamento, inicialmente 120 ms.
- `CURVA_MINIMA_MS`: mínimo antes de aceitar a nova linha, inicialmente 180 ms.
- `LIMITE_CURVA_MS` / `LIMITE_TRECHO_MS`: limites de falha, não critérios de chegada.

Cada F/D/E termina no próximo cruzamento. D/E alinham, giram, confirmam a saída
da linha antiga e reencontram a nova antes de seguir. Não contam a partida como
chegada. Os sensores precisam reconhecer os cruzamentos da pista; origem e mapa
são informados pelo operador, sem localização absoluta.

## Limites e recuperação

- Até **16 ações**, sem marcha à ré (`T`). O backend valida esses limites.
- Perda de linha bloqueia; reencontrá-la não retoma automaticamente.
- Ao passar 30 s sem resposta válida, conclui o trecho em andamento e aguarda
  no próximo cruzamento. A perda de linha ou um timeout local pode pará-lo antes.
- A fila de eventos é limitada; sem espaço, segura antes de iniciar outro trecho.
  Eventos críticos são reenviados com os mesmos IDs até confirmação.
- Pausa conserva a fase local; retomada pressupõe que o carrinho não foi
  reposicionado manualmente. Falha de manobra exige conferir a posição e reiniciar.
- Bateria, velocidade real e distância de obstáculos não são medidas por este
  sketch. Não há PID, sensor ultrassônico ou confirmação física da rotação das rodas.
- O firmware original e o novo não podem controlar o mesmo robô durante uma missão.

O monitor serial em **115200 baud** mostra comandos e falhas quando estiver
conectado por USB; o programa não aguarda o monitor.

## Verificação

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32:PartitionScheme=no_ota firmware/carrinho_autonomo
npm --prefix backend test
npm --prefix dashboard test
```

A compilação ESP32 e os testes do protocolo/simulador não substituem a validação
física. Comece com as rodas suspensas; depois valide reta, D/E, cruzamentos,
parada/retomada, perda de linha e queda de Wi-Fi na pista. A calibração e a execução
em hardware ainda não foram realizadas nesta entrega.
