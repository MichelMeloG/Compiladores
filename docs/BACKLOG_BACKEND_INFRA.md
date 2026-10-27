# Backlog de backend e infraestrutura (GCP) — RoboFlow

Gerado em 26/10/2026. Complementa [BACKLOG_FRONTEND.md](BACKLOG_FRONTEND.md) e parte da análise de arquitetura feita na conversa. Hoje **não existe backend, infraestrutura nem firmware** no repositório: só o front, o lexer/parser do compilador (~540 linhas Python, sem testes) e documentação.

Metas do POC: provar o fluxo ponta a ponta com o menor custo possível, dentro da cota gratuita do GCP, com segurança proporcional e código aberto bem arquitetado.

> Cotas e preços citados vêm do conhecimento do autor, não de consulta ao vivo. **Confirme na página de preços do GCP** (item INF-001) antes de fixá-los no artigo.

**Legenda.** Tipo: `DEC` decisão, `FEAT`, `DÍV`, `SEG`, `CUSTO`, `OBS` observabilidade, `DOC`. Prioridade: P0 bloqueia o resto, P1 necessário ao POC, P2 desejável, P3 polimento. Esforço: S (< 0,5 dia), M (0,5–2 dias), L (> 2 dias).

## 1. Arquitetura alvo (resumo)

```
Dashboard (Pages/Firebase Hosting)
   │ HTTPS + ID token (Firebase Auth)
   ▼
Cloud Run (1 serviço, min-instances=0, max-instances=2)
   ├─ /api/*      operador: valida, revalida, traduz, grava missão + comando (transação)
   ├─ /device/*   AGV: poll de comandos, ingest de eventos (HMAC por dispositivo)
   └─ /internal/* projetor (só OIDC do Pub/Sub)
        │                         │ publish
        ▼                         ▼
    Firestore                 Pub/Sub ──push──► /internal (alertas, rollups) ──► DLQ
        ▲
   ESP32 ──HTTPS poll/POST──► /device/*          Cloud Logging ◄── stdout JSON
```

Princípios:
- O ESP32 não é alcançável de fora: ele **puxa** comandos e **envia** eventos.
- A máquina de estados da missão e o ack de comando são **síncronos** no ingest; o Pub/Sub cuida só de efeitos derivados (alertas, rollups, analytics).
- Eventos de domínio vão para o Firestore; logs operacionais vão para o Cloud Logging. Não misturar.
- O servidor nunca confia na validação do front. A autoridade final de movimento é o supervisor local do ESP32.
- Estado nunca fica em memória do Cloud Run: instâncias morrem a qualquer momento.

## 2. Backlog ordenado

### Fase 0 — Decisões (ADRs; sem código)

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| INF-001 | DEC | P0 | S | Confirmar cotas gratuitas vigentes (Cloud Run, Firestore, Pub/Sub, Logging, Secret Manager, Artifact Registry, Cloud Build) e a região (`us-central1` contra `southamerica-east1`) | Tabela de cotas com data e link; região escolhida e justificada |
| INF-002 | DEC | P0 | M | **Transporte AGV↔nuvem:** poll HTTPS ao Cloud Run (recomendado) contra MQTT com broker. Registrar que o Cloud IoT Core foi descontinuado e que WebSocket no Cloud Run cobra tempo de instância enquanto aberto | ADR com trade-offs, latência de stop/abort e custo estimado |
| INF-003 | DEC | P0 | S | **Novo contrato de perda de comunicação.** O heartbeat de 250 ms e a parada após 1 s (`backend/README.md` §11.3) são inviáveis em HTTPS e estourariam a cota (~10 M req/mês). Definir: fila já carregada roda local; sem nuvem, conclui o trecho e segura no próximo cruzamento; stop/abort remoto é "melhor esforço" | ADR + atualização dos docs de backend e arquitetura. Parada de emergência declarada como física/local |
| INF-004 | DEC | P0 | S | Banco: **Firestore nativo** (sem SQL). Definir como substituir as garantias relacionais dos docs | ADR mapeia: 1 missão ativa por dispositivo → transação no doc do device; idempotência → doc com ID da chave e `create()`; dedupe de evento → ID `device_session_sequence` |
| INF-005 | DEC | P1 | S | Linguagem/stack do backend: TypeScript (compartilha tipos/zod com o front) ou Python (reaproveita o ecossistema do compilador) | ADR; estrutura de pastas definida |
| INF-006 | DEC | P0 | S | Contrato único de ordem e eixo Y (mesmos FE-001/002) | Decisão refletida em `backend/README.md` e `BACKEND_INTEGRATION.md` |
| INF-007 | DEC | P1 | S | Modelo de autorização: papéis (admin, operador, leitor), allowlist de e-mails, o que cada papel pode chamar | Matriz papel × endpoint |
| INF-008 | DOC | P1 | M | Reescrever `backend/README.md` e `docs/PLANO_BACKEND_ROBOFLOW.md` removendo serial/PC e adotando nuvem; corrigir as inconsistências listadas na análise | Nenhum documento afirma "backend no PC" ou "banco não escolhido" |

### Fase 1 — Fundação de infraestrutura

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| INF-010 | FEAT | P0 | M | Projeto GCP dedicado, **IaC (Terraform)** para Cloud Run, Firestore, Pub/Sub, Artifact Registry, service accounts e Secret Manager | `terraform apply` recria o ambiente do zero; estado fora do repositório |
| INF-011 | CUSTO | P0 | S | **Orçamento e alertas** (limites baixos, ex.: US$1) e **kill-switch**: alerta de orçamento → Pub/Sub → função que zera `max-instances`. Lembrar que o alerta sozinho não impede gasto | Teste forçado desliga o serviço |
| INF-012 | SEG | P0 | M | Service account própria do runtime com privilégio mínimo (`datastore.user`, `pubsub.publisher`); não usar a default do compute | Revisão de IAM sem papéis básicos (`editor`/`owner`) |
| INF-013 | SEG | P1 | M | **Workload Identity Federation** para o GitHub Actions; sem chave JSON de service account | Pipeline implanta sem segredo de longa duração |
| INF-014 | DÍV | P1 | M | CI/CD: build, testes, imagem distroless, deploy no Cloud Run por branch/tag; ambiente único para o POC | Merge em `main` implanta; falha de teste bloqueia |
| INF-015 | CUSTO | P1 | S | Cloud Run: `min-instances=0`, `max-instances` baixo, CPU alocada só durante a requisição, concorrência ajustada, `memory` mínima | Configuração no Terraform e no ADR de custo |
| INF-016 | CUSTO | P2 | S | Política de limpeza no Artifact Registry (a cota gratuita de armazenamento é pequena) | Mantém só as últimas N imagens |
| INF-017 | SEG | P2 | S | Secret Manager para segredos do servidor; repositório só com `.env.example`; gitleaks no CI | Varredura limpa |

### Fase 2 — Núcleo do backend (domínio)

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| BE-001 | FEAT | P0 | S | Esqueleto do serviço: healthcheck, logging JSON estruturado com severidade e `trace`, tratamento de erro padrão `{success:false,message,error}`, CORS restrito | `GET /health` responde; logs aparecem estruturados no Cloud Logging |
| BE-002 | FEAT | P0 | M | **Modelo de dados no Firestore:** robôs, mapas e rotas versionados (imutáveis), missões, ações, comandos, eventos, alertas, rollups | Diagrama de coleções, índices e regras de acesso documentados |
| BE-003 | FEAT | P0 | M | **Mapa e rotas cadastrados** (carga inicial por seed): nós, arestas dirigidas, bloqueios, estações | Seed reproduzível; versão do mapa congelada por missão |
| BE-004 | FEAT | P0 | M | **Tradutor de rota para F/D/E/T** conforme `backend/README.md` §5, com validações (vizinhança, aresta existente, salto, ponto repetido, capacidade `supportsReverse=false`) | Testes nas 4 orientações; rejeita diagonal, salto, nó inexistente e `T` sem capacidade |
| BE-005 | FEAT | P0 | M | **Revalidação no servidor** de tudo que o front validou, mais versão do mapa, posição e rumo declarados | Rota inválida enviada direto à API é recusada com 422 |
| BE-006 | FEAT | P0 | L | **Máquina de estados da missão** (`queued → loading → ready → running → blocked/paused → completed/aborted/failed/uncertain`) com transições só por confirmação do dispositivo | Testes de transição, incluindo estados inválidos e `uncertain` |
| BE-007 | FEAT | P0 | M | **Exclusão por dispositivo** (1 missão ativa) via transação no Firestore | Dois `POST /missions` simultâneos: um vence, o outro recebe 409 |
| BE-008 | FEAT | P0 | M | **Idempotência HTTP** (`Idempotency-Key`): mesma chave e corpo → mesmo resultado; mesma chave e corpo diferente → 409 | Teste de repetição e de conflito |
| BE-009 | FEAT | P1 | M | Comandos de dispositivo (`load_route`, `start`, `stop`, `resume`, `abort`) como documentos com validade, tentativas e estado (`pending/accepted/rejected/expired/uncertain`); `202` + `GET /commands/:id` | Start sem conexão é rejeitado; stop sem conexão fica "incerto", nunca "parado" |
| BE-010 | FEAT | P1 | M | `resume` amarrado ao `blockId` exibido; sessão do dispositivo invalida comandos antigos | Resume com bloqueio antigo recebe 409 |
| BE-011 | FEAT | P1 | S | Endpoints de prévia e consulta: `/routes`, `/routes/:id`, `/maps/:id`, `/routes/:id/preview`, `/missions/:id/execution`, `/devices/:id/status` | Contratos publicados e testados |

### Fase 3 — Interface com o AGV

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| BE-020 | FEAT | P0 | M | `GET /device/poll`: entrega o próximo comando válido; intervalo orientado pelo servidor (curto com missão ativa, longo em repouso) | Resposta inclui `nextPollMs`; comando vencido nunca é entregue |
| BE-021 | FEAT | P0 | M | `POST /device/events`: lote de eventos, com `sessionId` + `sequence`; resposta com ack dos eventos críticos | Reenvio do mesmo lote não duplica nada |
| BE-022 | SEG | P0 | M | **Autenticação de dispositivo:** segredo por dispositivo, HMAC do corpo + `sequence`/timestamp contra replay, comparação em tempo constante, rotação documentada | Requisição sem assinatura válida recebe 401; replay recusado |
| BE-023 | FEAT | P0 | M | Handshake `hello`: registra sessão, capacidades e limites (`maxActions`, `maxMessageBytes`); nova sessão invalida comandos e exige reconciliação | Reboot do ESP não retoma movimento sozinho |
| BE-024 | FEAT | P1 | M | Regras de progresso: `action_completed` só aceita o próximo índice esperado; duplicata não altera posição; salto de índice gera reconciliação | Testes de duplicata, salto e fora de ordem |
| BE-025 | FEAT | P1 | M | **Simulador de ESP32** (script) que fala o protocolo: handshake, fila, progresso, bloqueio, reboot, perda de eventos | Suíte e2e roda sem hardware |
| BE-026 | CUSTO | P1 | S | Política de telemetria: transições e eventos críticos persistem; amostras periódicas só sobrescrevem um doc "ao vivo" com taxa limitada | Orçamento de escritas por missão documentado e ≤ meta |

### Fase 4 — Eventos, métricas e alertas

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| BE-030 | FEAT | P1 | M | Tópico `agv-events`, push subscription autenticada por OIDC para `/internal/*`, **DLQ** e retry com backoff | Mensagem venenosa vai à DLQ sem travar a fila |
| BE-031 | FEAT | P1 | M | Consumidores **idempotentes** (efeito igual em reentrega at-least-once) | Teste de reentrega |
| BE-032 | FEAT | P1 | M | Projeção de eventos para os enums públicos do front (`command`, `presence_detected`, `stop_preventive`, `resume`, `destination_reached`, `mission_end`, `error`) | Mapeamento testado contra `types/index.ts` |
| BE-033 | CUSTO | P1 | L | **Rollups** de métricas (por dia e por robô), incluindo mediana, mín e máx, que o Firestore não agrega nativamente | `/dashboard/metrics` e `/fleet/metrics` leem poucos documentos |
| BE-034 | FEAT | P1 | M | Regras de alertas (paradas recorrentes, falha, dispositivo offline) e `PATCH /alerts/:id/acknowledge` persistido | Reconhecer alerta nunca gera comando |
| BE-035 | FEAT | P1 | M | Contagem de paradas por **transição de bloqueio**, não por amostra; `totalStops = presença + outras + desconhecidas` | Testes de episódios com múltiplos motivos |
| BE-036 | FEAT | P2 | S | Detecção de dispositivo offline (sem poll por N intervalos) via Cloud Scheduler (3 jobs gratuitos) | Alerta de offline sem polling interno |
| BE-037 | FEAT | P2 | M | Exportação opcional para BigQuery por assinatura direta do Pub/Sub, para análises do artigo | Dataset de exemplo consultável |

### Fase 5 — API existente e importação

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| BE-040 | FEAT | P0 | L | Implementar os contratos que a dashboard já consome (`/robots`, `/fleet/metrics`, `/dashboard/metrics`, `/missions`, `/missions/:id`, `/logs`, `/alerts`, `/robots/:id/grid`, `/robots/:id/route`) | Dashboard sem `VITE_DEMO` lê dados reais nos formatos atuais |
| BE-041 | FEAT | P1 | M | Filtros de período em UTC `[start, end)`, `robotId`, status, busca; listas com `limit`/cursor e teto máximo | Consistente entre métricas e listas |
| BE-042 | FEAT | P1 | M | `POST /logs/import`: deduplica por ID, **nunca gera comando**, limite de lote e de corpo, atribui `unassigned` ao robô informado | Importar histórico não altera missão ativa |
| BE-043 | FEAT | P2 | S | Eventos de dispositivo sem missão em consulta própria (`/devices/:id/events`), sem inventar missão para `/logs` | Documentado |

### Fase 6 — Segurança

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| SEC-001 | SEG | P0 | M | Verificar o ID token do Firebase em todo `/api/*`; papéis via custom claims; sem cadastro aberto | Sem token válido: 401; leitor tentando comandar: 403 |
| SEC-002 | SEG | P1 | S | Validação de entrada por schema, corpo máximo (4 KB para dispositivo), rejeição de campos desconhecidos | Teste de payloads malformados |
| SEC-003 | SEG | P1 | S | Rate limiting na aplicação por usuário e por dispositivo (Cloud Armor é pago) | Excesso recebe 429 |
| SEC-004 | SEG | P1 | S | `/internal/*` aceita somente o OIDC do Pub/Sub e do Scheduler | Chamada sem token recebe 401/403 |
| SEC-005 | SEG | P1 | S | Auditoria: `operatorUid` em missões e comandos; logs sem segredos | Revisão de logs |
| SEC-006 | SEG | P2 | S | Dependabot, `npm audit`/`pip-audit`, imagem base fixada por digest, SBOM | CI falha em vulnerabilidade alta |
| SEC-007 | SEG | P2 | M | Modelo de ameaças (STRIDE) resumido: sessão do ESP, replay, segredo no flash, abuso da API pública; limites declarados no artigo | Documento em `docs/` |

### Fase 7 — Observabilidade e custo em operação

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| OBS-001 | OBS | P1 | S | Logs estruturados com labels `deviceId`/`missionId`/`sessionId` e correlação por trace | Filtro por missão no Logs Explorer reconstrói o caso |
| OBS-002 | OBS | P1 | S | Métricas baseadas em log (paradas preventivas, erros 5xx, comandos expirados) e alertas por e-mail | Alerta dispara em teste |
| OBS-003 | CUSTO | P1 | S | Painel/relatório de consumo contra a cota (requisições, vCPU-s, leituras e escritas do Firestore) | Margem mensal visível |
| OBS-004 | CUSTO | P2 | S | Teste de carga leve para medir leituras/escritas por missão e validar a estimativa | Números reais no ADR de custo |
| OBS-005 | OBS | P3 | S | Retenção de logs e exclusão de dados antigos (TTL do Firestore para eventos/telemetria) | TTL configurado |

### Fase 8 — Elos com firmware e compilador (dependências externas ao backend)

| ID | Tipo | P | Esf. | Item | Critério de aceite |
|---|---|---|---|---|---|
| FW-001 | FEAT | P1 | L | Cliente HTTPS no ESP32: Wi-Fi, TLS com certificado raiz fixado, conexão reutilizada, NTP, assinatura HMAC, poll adaptativo | Fala com o simulador e com o Cloud Run |
| FW-002 | FEAT | P1 | L | Executor por fases, supervisor de veto e política de perda de comunicação (INF-003) no firmware | Teste com rodas suspensas |
| FW-003 | DEC | P1 | S | Onde guardar o segredo do dispositivo (NVS; criptografia de flash opcional) e como provisionar sem expô-lo no repositório | Procedimento documentado |
| CMP-001 | FEAT | P2 | L | Gerador do compilador passa a produzir o sketch com cliente HTTPS, em vez de serial | Sketch completo compila na Arduino IDE |
| CMP-002 | DÍV | P2 | M | Testes do lexer/parser (hoje inexistentes) | Casos válidos e inválidos nos exemplos `.rf` |

## 3. Ordem sugerida de consumo

1. **Decisões:** INF-001 a INF-008. Sem elas, o resto retrabalha.
2. **Fundação:** INF-010 → 012 → 011 → 013 → 014, e BE-001 em paralelo.
3. **Domínio puro e testável sem nuvem:** BE-002 → 003 → 004 → 005 → 006 → 007 → 008.
4. **Interface com o AGV e simulador:** BE-020 → 021 → 022 → 023 → 025 → 024 → 009 → 010.
5. **API que o front já consome:** BE-040, 041, 042, em conjunto com FE-040/041 (rollups).
6. **Eventos e métricas:** BE-030 a 036.
7. **Segurança e observabilidade:** SEC-001 antes de expor a URL; SEC-002 a 005 e OBS-001 a 003 antes da demonstração.
8. **Firmware e compilador** em paralelo, depois que BE-025 existir.

## 4. Riscos

- **Cota de leitura do Firestore (~50 mil/dia):** listas e métricas calculadas na hora podem esgotá-la. Mitigação: BE-033, BE-041 e FE-040.
- **Cold start do Cloud Run** convive mal com o timeout de 10 s do front (FE-020).
- **Latência de parada remota:** o stop remoto jamais substitui o veto local e a parada física. Precisa estar explícito no artigo.
- **Segredo do dispositivo no flash do ESP32** e **API pública com custo atrelado a cartão:** mitigados por INF-011, SEC-003 e um modelo de ameaças que declare os limites (SEC-007).
- **Escopo:** o POC pode ficar grande demais. Corte sugerido, se faltar tempo: manter BE-001 a 011, BE-020 a 025 e BE-040 a 042; adiar BE-036, BE-037, OBS-004/005 e CMP-001.
