# Backend RoboFlow — guia de desenvolvimento

API única (Fastify, Node 22, TypeScript estrito) para o Cloud Run. Três faces no mesmo serviço, cada uma com a sua autenticação:

| Prefixo | Quem chama | Autenticação |
|---|---|---|
| `/api/*` | dashboard | ID token do Firebase + allowlist de e-mails + papel (`admin`/`operator`/`viewer`) |
| `/device/*` | ESP32 | HMAC-SHA256 por dispositivo, `sessionId`, `X-Sequence` e relógio (`@roboflow/contracts/signing`) |
| `/internal/*` | Pub/Sub (push) e Cloud Scheduler | ID token OIDC da service account esperada |
| `/health` | sondas do Cloud Run | nenhuma; **não toca o banco** |

Os contratos (schemas, registro de endpoints, tradução de rota, assinatura, seed) vêm de [`../contracts`](../contracts). Este serviço **não duplica schemas**: registra as rotas a partir de `ENDPOINTS` e valida entrada com os schemas de lá. Desvios e lacunas: [`CONTRACT_GAPS.md`](CONTRACT_GAPS.md).

## 1. Rodar local (sem nenhuma credencial GCP)

```bash
cd contracts && npm ci && npm run build      # uma vez (o backend consome contracts/dist)
cd ../backend && npm ci
STORE=memory AUTH_MODE=off npm run dev       # http://localhost:8080 — já vem com o seed de demonstração
```

`STORE=memory` + `AUTH_MODE=off` é o modo de desenvolvimento: dados em memória (perdem-se ao reiniciar), sem login (`x-dev-role: viewer|operator|admin` escolhe o papel; padrão `admin`). A configuração **recusa iniciar** com `AUTH_MODE=off` se `NODE_ENV=production` ou `STORE=firestore`.

```bash
curl localhost:8080/health
curl localhost:8080/api/robots
curl localhost:8080/api/fleet/metrics?period=all
```

Dispositivos precisam de segredo. Para exercitar `/device/*` localmente:

```bash
export DEVICE_SECRETS_JSON='{"RB-02":"um-segredo-com-pelo-menos-16-chars"}'
STORE=memory AUTH_MODE=off npm run dev
```

## 2. Simulador de ESP32

```bash
npm run esp-sim -- --url http://localhost:8080 --device RB-02 --secret um-segredo-com-pelo-menos-16-chars \
  --step-ms 2000 --obstacle-at 1 --obstacle-ms 3000
```

Faz `hello`, consulta o servidor no ritmo de `nextPollMs`, carrega a fila quando chega `load_route`, anda um cruzamento por `--step-ms` depois do `start`, simula obstáculo (`--obstacle-at`), reinício (`--reboot-after`) e telemetria. No outro terminal, como operador:

```bash
curl -X POST localhost:8080/api/robots/RB-02/route -H 'content-type: application/json' -H 'Idempotency-Key: demo-1' \
  -d '{"waypoints":[{"x":4,"y":0},{"x":3,"y":0},{"x":2,"y":0}],"initialHeading":"W"}'
# ... espere o simulador carregar a fila (até nextPollMs) e inicie:
curl -X POST localhost:8080/api/missions/<missionId>/start -H 'content-type: application/json' -H 'Idempotency-Key: demo-2' -d '{}'
```

A mesma classe (`tools/esp-sim/sim.ts`) alimenta os testes e2e.

## 3. Testes

```bash
npm run typecheck     # tsc --noEmit, strict
npm test              # vitest: domínio, rotas, auth, HMAC, idempotência, sessão/reboot, Store, logging, contrato
npm run build         # dist/
```

Destaques da suíte (`test/`):

| Arquivo | Cobre |
|---|---|
| `mission-flow.test.ts` | fluxo completo com o simulador; recusas 200/422; start/stop/resume/abort; obstáculo (uma parada por episódio); reboot; duplicatas; salto de índice; falhas |
| `security.test.ts` | HMAC (adulteração, segredo errado, replay, relógio, 4 KB, sessão, rotação), papéis, allowlist, CORS, limite 429, 413 |
| `internal.test.ts` | OIDC de `/internal/*`, consumidor idempotente, DLQ (status não-2xx), varredura do Scheduler, custo do poll |
| `metrics.test.ts` | rollups == agregação de referência dos contratos (janelas, bordas, `custom`) |
| `api.contract.test.ts` | cada GET contra o schema do registro; filtros; cursor; importação nunca gera comando |
| `store.contract.test.ts` | a MESMA suíte roda no `MemoryStore` e, se houver emulador, no `FirestoreStore` |
| `contract-suite.test.ts` | executa `contracts/scripts/contract-test.ts` contra um servidor real (com Firebase/OIDC simulados) |
| `hardening.test.ts` | IDs externos nunca viram caminho de documento; `clean()` preserva `Timestamp` |

### Suíte de contrato contra o servidor local

```bash
STORE=memory AUTH_MODE=off CORS_ORIGINS=http://localhost:3000 \
  DEVICE_SECRETS_JSON='{"RB-02":"um-segredo-com-pelo-menos-16-chars"}' npm run dev &
npm run contract:test -- --base-url http://localhost:8080 \
  --device-secret um-segredo-com-pelo-menos-16-chars --device-id RB-02 --allow-mutations
```

`--allow-mutations` deixa dados no servidor: use só em memória/ambiente descartável. Sem `--auth-token`/`--viewer-token`/`--internal-token`, 4 testes são pulados (o teste de integração `contract-suite.test.ts` cobre esses com verificadores falsos).

### Emulador do Firestore (opcional)

```bash
npx firebase-tools emulators:start --only firestore      # exige Java; nada é criado no GCP
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm test           # roda o contrato do Store também contra o Firestore
STORE=firestore GCP_PROJECT=demo-roboflow FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 AUTH_MODE=firebase \
  ALLOWED_OPERATOR_EMAILS=voce@ex.com npm run dev
```

> O `FirestoreStore` **não foi executado contra um Firestore real nem contra o emulador nesta entrega** (sem Java/emulador na máquina). A lógica de transação é compartilhada com o `MemoryStore` (`store/buffered.ts`, coberta por testes); o que é específico do Firestore (`store/firestore.ts`, ~120 linhas) precisa do teste de contrato com o emulador antes do primeiro deploy.

## 4. Variáveis de ambiente

Contrato com a infra: [`../infra/ENV_CONTRACT.md`](../infra/ENV_CONTRACT.md).

| Variável | Padrão | Observação |
|---|---|---|
| `STORE` | `memory` | `firestore` em produção |
| `GCP_PROJECT` | — | obrigatório com `firestore` |
| `AUTH_MODE` | `firebase` | `off` só em dev/teste (proibido em produção e com Firestore) |
| `ALLOWED_OPERATOR_EMAILS` | — | vazio = ninguém entra |
| `DEVICE_SECRETS_JSON` | — | `{"RB-01":"segredo"}` ou lista por dispositivo (rotação); mínimo 16 caracteres |
| `CORS_ORIGINS` | — | lista separada por vírgula; vazio = nenhuma origem |
| `INTERNAL_AUDIENCE`, `PUBSUB_PUSH_SA`, `SCHEDULER_SA` | — | obrigatórias em produção |
| `PUBSUB_TOPIC_EVENTS` / `PUBSUB_TOPIC_DLQ` | `agv-events` / `agv-events-dlq` | |
| `LOG_LEVEL` / `PORT` | `info` / `8080` | |
| `SEED_ON_BOOT` | `true` em memória, `false` no Firestore | |
| `SEED_PROFILE` | `demo` | `clean` = só mapas, robôs e contadores |

Ajustes opcionais (todos com padrão seguro para a cota gratuita; **não** estão no contrato de ambiente da infra):

| Variável | Padrão | Efeito |
|---|---|---|
| `POLL_ACTIVE_MS` / `POLL_IDLE_MS` | 1500 / 30000 | `nextPollMs` devolvido ao ESP32 (com missão/comando pendente / em repouso) |
| `OFFLINE_AFTER_MS` / `OFFLINE_AFTER_IDLE_MS` | 45000 / 180000 | limiar de "offline" (com missão / em repouso) |
| `LAST_SEEN_WRITE_MS` / `LAST_SEEN_WRITE_IDLE_MS` | 10000 / 120000 | cadência de gravação de `lastSeenAt` (cota de escrita) |
| `COMMAND_TTL_MS` / `LOAD_COMMAND_TTL_MS` | 30000 / 120000 | validade dos comandos |
| `DEVICE_CLOCK_SKEW_MS` | 120000 | tolerância de relógio do HMAC |
| `RATE_LIMIT_USER_PER_MIN` / `RATE_LIMIT_DEVICE_PER_MIN` | 300 / 240 | limite por instância |
| `REQUIRE_CONFIRMED_POSITION` | `false` | `true` recusa rotas com posição desconhecida/divergente (exige `POST /api/robots/:id/position`) |

## 5. Estrutura

```
src/
  config.ts              ambiente validado; combinações inseguras não iniciam
  server.ts              Fastify: corpo cru (HMAC), CORS, trace, erros, rotas
  routes/                api.ts (a partir de ENDPOINTS), device.ts, internal.ts
  auth/                  operator.ts (Firebase), device.ts (HMAC), internal.ts (OIDC)
  services/              operator.ts (rota/controle), device.ts (hello/poll/eventos),
                         derive.ts (rollups/alertas/varredura), metrics.ts, queries.ts, ...
  domain/                tipos dos documentos e máquina de estados (mission.ts)
  store/                 types.ts, buffered.ts (transação), memory.ts, firestore.ts
  pubsub.ts              PubSub real, inline (dev) e gravador (teste)
  seed.ts                converte contracts/seed nos documentos internos
tools/esp-sim/           simulador de ESP32 (biblioteca + CLI)
tools/seed.ts            carga do seed em qualquer Store
firestore.indexes.json   índices compostos + política de TTL
```

### Decisões de projeto que valem saber

- **Sem estado em memória do processo** em `STORE=firestore`. Os únicos caches são o de mapas (imutáveis por versão) e o último `X-Sequence` por sessão (anti-replay; recuperado do robô numa instância fria).
- **Caminho crítico síncrono:** estado da missão, ack de comando, alertas de falha/incerteza e deduplicação acontecem na transação do ingest. Pub/Sub só leva efeitos derivados (rollup e alerta de recorrência), com consumidor idempotente. Se a publicação falhar, o ingest **não** falha: `POST /internal/offline-check` recupera.
- **Custo do poll:** em repouso `GET /device/poll` faz 1 leitura e nenhuma escrita (`lastSeenAt` só a cada 120 s); com missão, a cada 10 s.
- **Telemetria** não vira documento por amostra: só sobrescreve `robots/{id}.live`, no máximo a cada 5 s ou quando o estado/bloqueio muda.
- **Recusas:** geometria/forma inválida → `422 ROUTE_INVALID`; ré ou fila acima da capacidade → `422 CAPABILITY_UNSUPPORTED` (nunca substitui `T`); estado do momento (robô offline, ocupado, versão de mapa) → `200` com `accepted:false`.
- **Perda de comunicação não conclui nem aborta missão:** gera alerta; ao voltar (mesma sessão) o dispositivo reconcilia por `hello.lastMission`/`snapshot`. Reboot (nova sessão) torna `running/blocked/paused` em `uncertain` e **nunca** retoma sozinho.

## 6. Imagem e deploy

```bash
docker build -f backend/Dockerfile -t roboflow-api .      # contexto = RAIZ do repositório
```

O `Dockerfile` instala `contracts` e `backend` separadamente (sem `node_modules` na raiz), compila, remove dependências de desenvolvimento e roda em `distroless/nodejs22:nonroot`. `Dockerfile.dockerignore` limita o contexto (BuildKit). Sonda de inicialização: `GET /health`.

> O Docker não estava ativo na máquina onde isto foi escrito, então a imagem **não foi construída**; as mesmas etapas (`npm ci` → `build` → `prune --omit=dev` → `node dist/src/main.js`) foram reproduzidas numa cópia limpa e o servidor respondeu em `/health` e carregou o seed de `contracts`.

### Carga de dados no Firestore

```bash
STORE=firestore GCP_PROJECT=compiladores-512823 npm run seed -- --profile clean --yes
```

Cria mapas (`maps/{mapId}/versions/{n}`), robôs e contadores. `demo` exige `--allow-demo-in-firestore`. Índices e TTL: `firestore.indexes.json` (a infra os aplica; `expireAt` em `idempotency`, `deviceEvents`, `commands` e `events`).

### Se uma consulta falhar com `FAILED_PRECONDITION`

É um índice composto que falta (combinação rara de filtros em alertas, por exemplo). O erro traz o link de criação; adicione o índice a `firestore.indexes.json`.

## 7. Observabilidade

JSON em stdout com `severity`, `message`, `timestamp`; `logging.googleapis.com/trace` a partir de `X-Cloud-Trace-Context` (precisa de `GCP_PROJECT`); `logging.googleapis.com/labels` com `deviceId`/`missionId`/`sessionId` onde há contexto. Nunca são registrados tokens, assinaturas nem segredos (`authorization` e `x-signature` são redigidos). Polls vão para `debug`.
