# ADR 0001 — Transporte AGV ↔ nuvem: o ESP32 puxa por HTTPS

- **Status:** aceito
- **Data:** 26/10/2026
- **Substitui:** a seção 11.1 de `backend/README.md` (serial USB como transporte inicial) e o trecho de `docs/PLANO_BACKEND_ROBOFLOW.md` que assume backend no computador do operador.

## Contexto

O backend roda em Cloud Run (serverless, escala a zero). O ESP32 fica atrás de NAT/Wi-Fi e não aceita conexões de entrada, e o Cloud Run não mantém estado em memória entre instâncias. Portanto a nuvem **não consegue empurrar** comandos ao dispositivo.

Opções avaliadas:

| Opção | Resultado |
|---|---|
| Cloud IoT Core | Descontinuado pelo Google em 2023. Não é opção. |
| MQTT com broker | Push real e baixa latência, mas exige um broker: Mosquitto em e2-micro (operar, atualizar, proteger) ou serviço de terceiros fora do GCP. Aumenta a superfície de ataque e a operação. Rejeitado para o POC. |
| WebSocket/SSE no Cloud Run | Cloud Run cobra o tempo de instância enquanto a conexão está aberta, a conexão cai a cada limite de timeout e exige afinidade de sessão com mais de uma instância. Frágil no ESP32. Rejeitado. |
| Pub/Sub direto no ESP32 | Exigiria credencial de service account no dispositivo (OAuth/gRPC). Risco de segurança alto. Rejeitado. |
| **HTTPS por poll** | Funciona em qualquer rede, usa só o Cloud Run, dentro da cota gratuita. **Escolhido.** |

## Decisão

1. O dispositivo abre sessão com `POST /device/hello` a cada boot, busca trabalho com `GET /device/poll` e envia eventos com `POST /device/events` (até 16 por lote). A resposta de `events` também pode carregar comandos novos (reduz a latência de um round trip).
2. O **servidor dita o intervalo** em `nextPollMs`: 1,5 s com missão ativa e 30 s em repouso (limites 1 s a 60 s). Isso mantém o consumo de requisições previsível.
3. Autenticação por HMAC-SHA256 por dispositivo (cabeçalhos `X-Device-Id`, `X-Session-Id`, `X-Sequence`, `X-Timestamp`, `X-Signature`), definida em `contracts/src/signing.ts`.
4. Comandos entregues no poll carregam `validForMs` **relativo ao recebimento**. O ESP32 não precisa de data UTC.
5. Eventos críticos exigem confirmação (`ackedSequence`) e são retransmitidos; telemetria periódica é descartável. `ackedSequence` é a **maior sequência de evento crítico processada** (não contígua entre todos os eventos). O firmware retransmite os críticos ainda não confirmados do mais antigo ao mais novo, **no mesmo lote**, mantendo `messageId` e `sequence`; o servidor deduplica.

## Consequências

- Custo: 1 AGV em repouso gera ~2.900 polls/dia; em missão, ~2.400 por hora. Ordem de grandeza de 100 a 250 mil requisições por mês, contra 2 milhões gratuitos no Cloud Run (nível 1).
- Latência de comando remoto ≈ `nextPollMs`. Stop e abort remotos são **melhor esforço** (ADR 0002).
- O firmware precisa de cliente HTTPS com TLS, conexão reutilizada e relógio por NTP para o timestamp da assinatura.
- Se um dia houver necessidade de latência menor, MQTT pode substituir a camada de transporte sem alterar o protocolo lógico (mensagens, sessão, sequência).
