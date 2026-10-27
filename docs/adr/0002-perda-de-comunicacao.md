# ADR 0002 — Perda de comunicação e autoridade de segurança

- **Status:** aceito
- **Data:** 26/10/2026
- **Substitui:** `backend/README.md` §11.3 e §12 (heartbeat de 250 ms, expiração local em 1.000 ms, autorização contínua) e o item correspondente de `docs/PLANO_BACKEND_ROBOFLOW.md` §9.

## Contexto

A proposta anterior exigia que o backend renovasse a autorização de movimento a cada 250 ms e que o ESP32 parasse após 1.000 ms sem ela. Em HTTPS por poll (ADR 0001) isso é inviável:

- 4 requisições por segundo por AGV dão ~10 milhões por mês, cinco vezes a cota gratuita do Cloud Run.
- Latência de TLS e cold start de centenas de milissegundos a segundos fariam o AGV parar a cada oscilação de rede.
- Uma parada por "não ouvi a nuvem" não aumenta a segurança: a segurança real vem dos sensores locais.

## Decisão

**Autoridade de movimento é local.** A nuvem só fornece o plano (a fila) e solicitações explícitas.

1. **Fila carregada executa localmente.** Depois de `load_route` aceito e `start` aceito, o ESP32 executa as ações sem depender da nuvem.
2. **Vetos locais são sempre soberanos:** obstáculo (≤ 20 cm), leitura de distância inválida ou vencida, perda de linha fora de manobra válida, falha de sensor. Nenhum comando remoto os ignora.
3. **Sem comunicação com a nuvem** (nenhum poll bem-sucedido por um período configurável, inicialmente 30 s): o AGV **conclui o trecho em andamento e segura no próximo cruzamento confirmado**, com motores desabilitados. Ao reconectar, **não retoma sozinho**: exige `resume` explícito do operador.
4. **Stop e abort remotos são melhor esforço.** A latência esperada é `nextPollMs` (≈1,5 s em missão). Enquanto não confirmados, o comando fica `pending`; sem conexão, fica `uncertain`. A interface nunca afirma "parado" antes do `ack` do dispositivo.
5. **Parada de emergência é física/local** (chave de alimentação acessível). A documentação e o artigo devem declarar que o stop remoto não é um dispositivo de segurança.
6. **Start e resume sem conexão são rejeitados** (`503 DEVICE_UNAVAILABLE`).
7. **Reboot do ESP32** cria nova sessão: motores parados, fila antiga invalidada, missão em andamento vira `uncertain`, nenhum `start`/`resume` automático. O servidor só reconcilia e aguarda decisão explícita.
8. Confirmações de eventos críticos usam `ackedSequence` = **maior sequência de evento crítico processada** (não é contígua entre todos os eventos: telemetria é descartável e não participa). O firmware retransmite os críticos pendentes (`sequence > ackedSequence`) **do mais antigo ao mais novo, no mesmo lote**. Lacuna detectada → o servidor responde `resync: true` e o dispositivo envia um `snapshot`.
9. **Reconciliação do incerto.** Um `snapshot` ou `hello` que prove o estado leva `uncertain` a `completed` (fila concluída), `blocked` (bloqueio ativo) ou `paused`; nunca a `running`. Se o dispositivo ficar desligado, um **administrador** encerra a missão com `POST /api/missions/:id/force-close` (vai a `aborted`, sem `endedAt`, `durationSeconds: null`, e libera a reserva). Abort durante o carregamento ou com o robô em movimento também é válido (`loading`/`running → aborted`).

## Consequências

- O requisito de latência de parada de segurança fica totalmente no firmware, e deve ser validado com rodas suspensas.
- A missão pode terminar com o servidor sem saber (nuvem fora); ao reconectar, o dispositivo reenvia eventos críticos retidos e a missão converge, ou vira `uncertain` se houver lacuna.
- O valor de 30 s sem nuvem e o comportamento de "segurar no próximo cruzamento" são parâmetros iniciais e precisam de validação na pista.
