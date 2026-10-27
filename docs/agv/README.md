# Carrinho AGV: o que precisamos construir

Documentação para a equipe do firmware e da bancada. Diz o que o ESP32 do carrinho precisa fazer para falar com o backend que **já está na nuvem**, em que ordem construir e como provar que funciona. Escrita em 27/10/2026 a partir do código real de `contracts/` (versão 1.1.0), `backend/` e do simulador `backend/tools/esp-sim/`.

## 1. Índice

| Documento | Para quê |
|---|---|
| [FIRMWARE_ESP32.md](FIRMWARE_ESP32.md) | Arquitetura do firmware: módulos, tarefas FreeRTOS, fila de eventos, executor, supervisor, memória, bibliotecas |
| [PROTOCOLO_DISPOSITIVO.md](PROTOCOLO_DISPOSITIVO.md) | O protocolo visto do firmware: assinatura HMAC, `hello`/`poll`/`events`, comandos, eventos, erros e orçamento de requisições |
| [VETORES_DE_TESTE.md](VETORES_DE_TESTE.md) e [`vetores/`](vetores/) | Assinaturas e mensagens geradas pelo código real, para validar o firmware sem rede |
| [PROVISIONAMENTO.md](PROVISIONAMENTO.md) | Identidade, segredo, Wi-Fi, certificado raiz fixado, relógio, rotação de segredo e limites de segurança |
| [PLANO_DE_BANCADA.md](PLANO_DE_BANCADA.md) | Testes progressivos (a) a (e) e checklist de segurança física |
| [PENDENCIAS_DE_HARDWARE.md](PENDENCIAS_DE_HARDWARE.md) | O que depende de medição ou decisão física, com como medir e critério |
| [RELACAO_COM_A_LINGUAGEM.md](RELACAO_COM_A_LINGUAGEM.md) | O que continua do compilador RoboFlow e perguntas para a equipe dele |

## 2. Visão geral do fluxo

```
Operador (dashboard)                Nuvem (Cloud Run + Firestore)                 Carrinho (ESP32)
        │                                    │                                         │
        │ escolhe robô e rota (A→B)          │                                         │
        ├──────────────────────────────────► │ revalida, traduz em F/D/E,              │
        │   POST /api/robots/:id/route       │ grava missão + comando load_route       │
        │                                    │                                         │
        │                                    │ ◄───── GET /device/poll (a cada nextPollMs)
        │                                    │ ─────► load_route (fila de ações)  ────► valida, guarda, ack
        │ start  ───────────────────────────►│ ─────► start  ───────────────────────► começa a executar
        │                                    │ ◄───── POST /device/events: action_completed, block_*, telemetria
        │ ◄──────── estado, logs, alertas ───┤  (confirmações de eventos críticos por ackedSequence)
```

Princípios que não mudam:

1. O ESP32 **puxa**; a nuvem nunca o chama (ADR 0001).
2. **A autoridade de movimento é local**: obstáculo, leitura inválida, perda de linha e falhas travam os motores no firmware, sem esperar a nuvem (ADR 0002).
3. `stop`/`abort` remotos são **melhor esforço** (latência ≈ `nextPollMs`); a parada de emergência é a chave física.
4. Nenhuma conclusão é presumida: uma ação só termina com o cruzamento confirmado pelo sensor.
5. Reboot ou nova sessão nunca retomam movimento sozinhos.

## 3. O que já existe e o que falta

| Peça | Estado |
|---|---|
| Backend `roboflow-api` no Cloud Run (`https://roboflow-api-483331439325.us-central1.run.app`, projeto `compiladores-512823`, `us-central1`) | **Implantado.** Firestore criado e semeado com `RB-01` a `RB-04` |
| Contratos `@roboflow/contracts` 1.1.0 (schemas, tradutor de rota, assinatura, fixtures, suíte de contrato) | Pronto; inclui `POST /api/robots/:id/position`, `POST /api/missions/:id/force-close` e as transições extras de estado |
| Simulador de ESP32 (`backend/tools/esp-sim`) | Pronto. Já fez `hello` com HMAC contra a nuvem (sessão gravada em `robots/RB-03`) |
| Vetores de teste de assinatura e mensagens | Prontos ([`vetores/`](vetores/)) |
| **Firmware do carrinho** | **Não existe.** Esta pasta especifica o que construir |
| Provisionamento (sketch que grava a NVS) | A fazer |
| Calibração de sensores, regra de cruzamento, geometria, distância de parada | A fazer (ver [PENDENCIAS_DE_HARDWARE.md](PENDENCIAS_DE_HARDWARE.md)) |
| Acesso de operador à nuvem (login Firebase e painel) | Pendente (dashboard fica para depois). Sem isso, não dá para criar rota/`start` contra a nuvem; só testes de repouso |
| Compilador gerando o sketch com o cliente de nuvem | Futuro; a linguagem RoboFlow **não muda** |

## 4. Ordem de trabalho (marcos)

Cada marco só começa quando o anterior passou. A numeração dos testes (b1, c1, d1...) está em [PLANO_DE_BANCADA.md](PLANO_DE_BANCADA.md).

| Marco | Entrega | Critério de aceite |
|---|---|---|
| **M0** Assinatura | HMAC-SHA256 e serialização no ESP32 (ou em um sketch de teste) | 7 de 7 vetores positivos de [`vetores/hmac-positivos.json`](vetores/hmac-positivos.json) idênticos, incluindo `int64` e UTF-8 |
| **M1** Rede e relógio | Wi-Fi, reconexão, NTP | Hora válida em ≤ 15 s após o Wi-Fi; reconecta sozinho após queda do AP |
| **M2** TLS | Conexão ao Cloud Run com as raízes GTS R1 a R4 fixadas, sem `setInsecure()` | `GET /health` → 200; **sem** a R1 a conexão falha; heap de pico e mínimo registrados; buffer de entrada ≥ 8 KB |
| **M3** Hello e poll em repouso | `hello` assinado e poll com `nextPollMs` | Dispositivo `online` no servidor; ~120 requisições/h em repouso; **contador de conexões TLS novas por hora** registrado |
| **M4** Ciclo sem motores | `load_route` → `ack` → `start` → execução fictícia → eventos → `mission_completed` | Etapa (b) do plano: missão `completed` no servidor com o número certo de ações |
| **M5** Resiliência | Retransmissão de críticos, reboot, 5xx, 429, `CLOCK_SKEW`, `resync`/`snapshot`, perda de comunicação de 30 s | Casos de falha de (b) e (c) passam |
| **M6** Sensores e supervisor | Leituras reais, vetos, bloqueios (`block_started`/`cleared`), telemetria real, ainda sem andar | Etapa (d) parcial: veto de obstáculo, leitura inválida/vencida e perda de linha com rodas suspensas |
| **M7** Executor | Seguidor de linha, fases por ação, detector de cruzamento com filtro e rearme | Etapa (d) completa: um `action_completed` por cruzamento simulado; parada de qualquer fase |
| **M8** Pista | Operação na grade em baixa velocidade | Etapa (e): 10 de 10 rotas `F, D, E`; distância de parada medida e dentro da margem |

## 5. O que NÃO muda

- A linguagem RoboFlow (`.rf`), o lexer, o parser, a AST e os exemplos: intocados. O sketch gerado pelo compilador no futuro reaproveita o cliente de nuvem como template ([RELACAO_COM_A_LINGUAGEM.md](RELACAO_COM_A_LINGUAGEM.md)).
- O protocolo é o de `contracts/`. Qualquer pedido de mudança (um novo motivo de bloqueio, um estado, um campo extra de telemetria) passa pela equipe do `contracts`, porque altera o servidor e os testes.

## 6. Divergências entre a documentação antiga e o código (o código e os ADRs vencem)

| Documento | Dizia | Vale |
|---|---|---|
| `backend/README.md` §11, `docs/PLANO_BACKEND_ROBOFLOW.md` | Serial USB, `heartbeat` a 250 ms, parada em 1 s | HTTPS por poll, sem `heartbeat` (ADR 0001/0002). Os trechos antigos já estão marcados como superados |
| ADR 0002, item 8 | `ackedSequence` = maior sequência **contígua** persistida | Maior sequência de evento **crítico** processada (`contracts/src/device.ts`, `CHANGELOG`) |
| `contracts/src/signing.ts` | Tolerância de relógio padrão de 60 s | O backend usa 120 s (`DEVICE_CLOCK_SKEW_MS`) |
| `docs/ARQUITETURA_DOS_COMPONENTES.md` §11 | Mensagens de texto na serial (`STATE ...`) | Só como log de depuração |
| `compiler/DOCUMENTACAO_COMPILADOR_ROBOFLOW.md` §14.5 | Transporte inicial por serial USB | HTTPS por poll |
| `docs/ARQUITETURA_DOS_COMPONENTES.md` §9.1 | Nomes de estado em português (SEGUINDO_LINHA...) | Estados do protocolo em inglês; tabela de correspondência em [FIRMWARE_ESP32.md](FIRMWARE_ESP32.md) §4 |
| `O_QUE_O_ROBO_FAZ.md`, dashboard e telemetria | Três sensores de linha | O documento de hardware agora lista um IR adicional (GPIO 35); a telemetria `line` aceita só 3 bits |
| `contracts/seed/devices.json` | `secretName: "device-secret-RB-01"` | Resquício do Secret Manager (não usado); o segredo vem de `DEVICE_SECRETS_JSON` |
| `backend/tools/esp-sim/cli.ts` | Em `ready` consulta o servidor a cada ~250 ms | **Não é a cadência do firmware**, que respeita `nextPollMs` (30 s em repouso). Não deixar rodando contra a nuvem (consumiria a cota de leituras do Firestore) |
| `infra/COST_ZERO.md` (egress) | Respostas pequenas mantêm o tráfego de saída mínimo | Não considera o handshake TLS (~8 KB por conexão nova). O firmware **deve** reutilizar a conexão |

## 7. Dúvidas abertas

1. **Qual `deviceId` é o carrinho físico?** Sugestão: `RB-01`; `RB-02` a `RB-04` ficam para simulação. Até aqui o simulador usou `RB-03` na nuvem.
2. **Como o operador cria rota e `start` contra a nuvem?** Exige token do Firebase; a dashboard e o login ficaram para depois. Sem isso, a etapa (c) só cobre repouso.
3. **Papel do quarto sensor IR (GPIO 35)** e se o valor dele precisa chegar à nuvem (a telemetria aceita 3 bits).
4. **Motivo de bloqueio para perda de comunicação.** O firmware usa `paused` e `fault` `warning` `COMM_LOST_HOLD`; `reasons` de `block_started` não tem "comunicação". Aceitar a convenção ou ampliar o contrato?
5. **`wait_signal`/`AGUARDANDO_ESTACAO` do RoboFlow** não têm correspondente no protocolo (ver [RELACAO_COM_A_LINGUAGEM.md](RELACAO_COM_A_LINGUAGEM.md)).
6. **Keep-alive do Cloud Run:** quanto tempo o servidor mantém uma conexão ociosa? Define se o poll de repouso pode ser 30 s ou deve subir para 60 s (custo de saída de rede). Medir no M3.
7. **Validação do mbedtls com a cadeia cruzada do `run.app`:** com a R1 autoassinada como âncora o OpenSSL aceita; o mbedtls ainda não foi testado (M2).
8. **Grade física:** dimensões reais e se corresponde a `pista-1` (5 × 4) ou a um mapa novo.
