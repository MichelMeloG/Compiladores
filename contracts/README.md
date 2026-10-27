# @roboflow/contracts

Fonte única de verdade do contrato entre **dashboard**, **backend** e **AGV (ESP32)**: schemas zod, tradução de rota, seed, fixtures, um servidor mock e uma suíte de contrato executável contra qualquer base URL.

- Decisões: [`docs/adr/0001` a `0005`](../docs/adr) e [`docs/FIRESTORE_MODEL.md`](../docs/FIRESTORE_MODEL.md).
- O backend real só é considerado conforme se **passar a suíte de contrato inteira**.
- Pacote independente (sem workspace na raiz do repositório). Instale **somente** dentro desta pasta.

## O que há aqui

| Caminho | Conteúdo |
|---|---|
| `src/common.ts` | Enums públicos (espelho do frontend), `Heading` × `Command`, envelope de sucesso/erro, `ErrorCode` e status HTTP |
| `src/map.ts`, `src/geometry.ts` | Mapa, malha, `translateRoute`, `findPath`, `simulateActions` — **funções puras**, sem I/O |
| `src/dashboard.ts` | Payloads que a dashboard já consome, campo a campo; consultas e `LIMITS` |
| `src/mission.ts` | Máquina de estados da missão, comandos de dispositivo, prévia/envio de rota, execução, status do dispositivo |
| `src/device.ts` | Protocolo do AGV: `hello`, `ack`/`reject`, `telemetry`, `action_*`, `block_*`, `fault`, `snapshot`; comandos `load_route`/`start`/`stop`/`resume`/`abort`; respostas de `poll`/`events` |
| `src/api.ts` | `ENDPOINTS`: registro de todos os endpoints (método, caminho, auth, papéis, schemas, idempotência, erros) |
| `src/metrics.ts`, `src/projection.ts` | Agregação de métricas de referência; projeção de eventos do dispositivo para os enums públicos |
| `src/registry.ts`, `src/seed.ts` | Registro nominal de schemas; schemas dos registros internos do seed |
| `src/signing.ts` | HMAC-SHA256 do dispositivo (**só Node**; subcaminho `@roboflow/contracts/signing`) |
| `seed/` | Mapas, dispositivos, robôs, missões, eventos, alertas e rota ativa (dados do demo com datas fixas) |
| `fixtures/` | Exemplos **válidos e inválidos** por endpoint e por mensagem de dispositivo |
| `mock/server.ts` | Servidor de referência em memória que implementa **todo** o contrato |
| `scripts/contract-test.ts` | Suíte de contrato (58 verificações) contra qualquer URL |
| `openapi.json` | OpenAPI 3.0 gerado de `ENDPOINTS` |

## Uso rápido

```bash
cd contracts
npm install
npm run build        # gera dist/ (necessário para consumir o pacote)
npm test             # 228 testes, inclui a suíte de contrato contra o mock
npm run mock         # http://localhost:8080 (operador: Bearer dev-token)
```

### Consumir no backend (TypeScript)

```jsonc
// backend/package.json
"dependencies": { "@roboflow/contracts": "file:../contracts" }
```

```ts
import { translateRoute, ENDPOINTS, RouteSubmitRequestSchema } from '@roboflow/contracts';
import { verifyRequest } from '@roboflow/contracts/signing';

const t = translateRoute(map, body.waypoints, body.initialHeading ?? device.lastConfirmedHeading, device.capabilities);
if (!t.executable) /* 422 ROUTE_INVALID ou CAPABILITY_UNSUPPORTED, com t.errors em `details` */;
```

Cada endpoint de `ENDPOINTS` traz `query`, `body` e `response` (schemas zod): valide a entrada com eles e use `response` nos testes. `matchEndpoint(método, caminho)` serve para um roteador genérico.

### Consumir no frontend

Os tipos de `dashboard/src/types/index.ts` continuam válidos (os schemas os espelham). Para migrar, importe os schemas/tipos daqui e valide as respostas em `apiRequest`. `@roboflow/contracts` (índice) é isomórfico; **não** importe `/signing` no navegador.

### Tradução de rota

```ts
import { translateRoute, DEFAULT_CAPABILITIES } from '@roboflow/contracts';

const r = translateRoute(
  { cols: 5, rows: 4, points: [{ x: 2, y: 2, kind: 'blocked' }] },
  [{ x: 0, y: 3 }, { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 1, y: 1 }],
  'N',
  DEFAULT_CAPABILITIES
);
// r.executable === true, r.actions === ['F', 'D', 'E'], r.finalHeading === 'N'
```

`y` cresce para baixo; `Heading` (N/E/S/W) e `Command` (F/T/D/E) são tipos distintos ([ADR 0004](../docs/adr/0004-eixo-de-coordenadas.md)). Erros possíveis: `ROUTE_TOO_SHORT`, `NODE_INVALID`, `NODE_OUT_OF_GRID`, `NODE_BLOCKED`, `NODE_REPEATED`, `STEP_DIAGONAL`, `STEP_JUMP`, `EDGE_CLOSED`, `HEADING_INVALID`, `REVERSE_UNSUPPORTED`, `QUEUE_TOO_LONG`.

## Suíte de contrato

```bash
npm run contract:test -- --base-url http://localhost:8080 \
  --auth-token dev-token --viewer-token viewer-token --admin-token admin-token --internal-token internal-token \
  --device-secret mock-device-secret --allow-mutations
```

| Opção | Efeito |
|---|---|
| `--base-url` | Raiz do servidor (sem `/api`). Obrigatória |
| `--auth-token` / `--viewer-token` / `--admin-token` | Bearer de operador / de leitor / de admin (testes de papel e de `force-close`) |
| `--internal-token` | Credencial de `/internal/*` |
| `--device-secret`, `--device-id` | Segredo HMAC e dispositivo simulado (padrão `RB-02`) |
| `--allow-mutations` | Habilita testes que **escrevem** (rota, controle, importação, ack de alerta, dispositivo). Deixa dados no servidor: use ambiente descartável |
| `--expect-auth` | Exige 401 sem token (ligado se há `--auth-token`) |
| `--origin` | Origem para o teste de CORS (padrão `http://localhost:3000`) |
| `--no-seed` | Pula as asserções que dependem do seed |
| `--only <regex>` | Filtra por nome |
| `--json` | Saída em JSON; código de saída ≠ 0 se algo falhar |

**Dependências por grupo**

| Grupo | Exige |
|---|---|
| Público, CORS, leitura, filtros, prévia, `/internal` sem credencial | Nada além do servidor (leitura valida schemas e invariantes) |
| Autenticação | `--auth-token` (e `--viewer-token` para 403) |
| Itens marcados `seed` (frota RB-01..04, grade da pista-1, rota RT-0041, robô RB-04 offline, métricas conhecidas) | **Seed carregado e intacto**; rode **antes** de qualquer mutação. Sem seed, use `--no-seed` |
| Mutações simples (ack de alerta, importação, recusas) | `--allow-mutations`; algumas também exigem o seed |
| Fluxo de dispositivo (hello, poll, rota → ack → start → progresso → bloqueio → resume → conclusão, reboot, salto de índice) | `--allow-mutations` **e** `--device-secret`; usa `RB-02` em `pista-2` (online, sem missão ativa) |

A suíte também compara o servidor com a biblioteca: a **prévia** de 9 rotas e as **métricas** são recalculadas localmente e precisam coincidir.

## Regras de protocolo e política (resumo)

- **`ackedSequence` conta só eventos críticos.** É a maior `sequence` de evento crítico (`hello`, `ack`, `reject`, `action_completed`, `mission_completed`, `block_started`, `block_cleared`, `fault`, `snapshot`) processada na sessão; **não** é contígua entre todos os eventos, porque telemetria e `action_started` são descartáveis. **Retransmissão (firmware):** a cada requisição, reenviar todos os críticos com `sequence > ackedSequence`, **do mais antigo ao mais novo, no mesmo lote** (até 16), mantendo `messageId` e `sequence`; o servidor deduplica por sequência. Telemetria nunca é retransmitida.
- **Transições de missão** (`MISSION_TRANSITIONS`): além das do `backend/README.md` §8, valem `queued/loading/running → aborted` e `uncertain → completed/blocked` (reconciliação por `snapshot`/`hello`). `uncertain` nunca volta a `running` sozinho.
- **`POST /api/robots/:id/position`** `{x,y,heading}` (operador/admin): confirma cruzamento e rumo do robô parado; missão ativa → `409 DEVICE_BUSY`; fora da malha/bloqueado → `422`.
- **`POST /api/missions/:id/force-close`** (somente admin): missão `uncertain` → `aborted` sem confirmação do dispositivo (sem `endedAt`, `durationSeconds:null`); fora de `uncertain` → `409`.
- **Posição inicial:** o primeiro waypoint declara onde o robô está. Padrão: aceita, registra a divergência no evento `mission_start` e marca a posição como `confirmed`. `REQUIRE_CONFIRMED_POSITION=true` (opcional no backend) recusa divergência/posição desconhecida até `position`. Ver [ADR 0005](../docs/adr/0005-contrato-de-ordem-unificado.md).

## Regerar artefatos

```bash
npm run generate        # build + seed + fixtures
npm run openapi         # openapi.json
```

`seed/` e `fixtures/` são **gerados** (`scripts/build-seed.mjs`, `scripts/build-fixtures.mjs`). Não edite à mão: altere o script e regenere. O `seed` usa a data fixa `2026-10-26T18:00:00Z`; o mock reancora as datas para "agora".

## Política de versão e mudança de contrato

Versão semântica em `package.json`, `CONTRACT_VERSION` e `CHANGELOG.md`.

- **PATCH:** correção sem efeito no formato (mensagem, doc, fixture).
- **MINOR:** mudança **aditiva** (endpoint novo, campo opcional, valor novo em enum **do protocolo do dispositivo**). O frontend e o backend antigos continuam funcionando.
- **MAJOR:** remoção, renomeação, campo novo obrigatório, mudança de significado ou de status HTTP.
- Enums públicos da dashboard (`EventType`, `RoverState`, `RobotStatus`, `MissionStatus`, `EventSeverity`) **só ganham valores depois** de o frontend ser atualizado: mudança coordenada, sempre MAJOR para o consumidor.
- Todo PR que altera `src/` deve: atualizar `ENDPOINTS`/schemas, regenerar `seed`/`fixtures`/`openapi.json`, adicionar fixtures válidas **e** inválidas, rodar `npm test` e registrar a entrada no `CHANGELOG.md`.
- Mudanças em `BACKEND_INTEGRATION.md` ou nos ADRs 0004/0005 exigem o mesmo PR.
