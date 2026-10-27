# ADR 0005 — Contrato de ordem unificado e interfaces do dispositivo

- **Status:** aceito
- **Data:** 26/10/2026
- **Fonte executável:** `contracts/src/api.ts` (registro `ENDPOINTS`); suíte em `contracts/scripts/contract-test.ts`.

## Contexto

Existiam dois caminhos incompatíveis para enviar uma ordem: `POST /robots/:id/route` (waypoints livres, usado pela dashboard, recusa por `accepted:false` com HTTP 200) e `POST /missions` (rota cadastrada, 201/202/409/422, no `backend/README.md`). O contrato da dashboard (`dashboard/BACKEND_INTEGRATION.md`) já está implementado no frontend e **prevalece**.

## Decisão

1. **Um único caminho de envio:** `POST /api/robots/:id/route`. `POST /api/missions` do `backend/README.md` não existe; a criação da missão é consequência do envio da rota.
2. **Preservar** todos os endpoints, o envelope `{ success, data }`, os enums e os campos de `BACKEND_INTEGRATION.md`. Mudanças só aditivas (campos opcionais, endpoints novos).
3. **Recusa de negócio** (robô offline, em falha ou com missão ativa) = **HTTP 200 com `accepted:false`** e `message`. **Corpo inválido** = 400 `INVALID_BODY`; **rota inválida** = 422 `ROUTE_INVALID`; **ré sem suporte** = 422 `CAPABILITY_UNSUPPORTED`. Esta regra resolve a contradição entre os documentos.
4. **O servidor nunca confia no cliente.** O front valida por usabilidade; o backend revalida tudo (vizinhança, bloqueios, trechos fechados, capacidade, versão do mapa, rumo) com a mesma biblioteca `translateRoute`.
5. **Idempotência:** o cabeçalho `Idempotency-Key` é **obrigatório** em `POST .../route` e em start/stop/resume/abort. Mesma chave e corpo = mesmo resultado; mesma chave com corpo diferente = 409 `CONFLICT_IDEMPOTENCY`.
6. **Carregar a fila não inicia o movimento.** `POST .../route` cria a missão e o comando `load_route`; o início é outra ação.

### Endpoints novos (operador, prefixo `/api`)

| Método | Caminho | Função |
|---|---|---|
| POST | `/robots/:id/route/preview` | Valida e traduz (F/D/E/T, rumo final, `executable`, `errors[]`) sem reservar o robô |
| POST | `/missions/:id/start` `stop` `resume` `abort` | Retornam `202 {commandId, missionId, status:"pending"}`; `resume` exige `blockId` |
| GET | `/commands/:id` | `pending`, `accepted`, `rejected`, `expired`, `uncertain` |
| GET | `/missions/:id/execution` | Estado detalhado, ação atual, último/próximo nó, `positionConfidence` |
| GET | `/devices/:id/status` | Sessão, conexão, sensores e bloqueios, com idade do dado |
| GET | `/robots/:id/events` | Eventos do dispositivo inclusive sem missão |
| POST | `/robots/:id/position` | `{x,y,heading}`: o operador/admin confirma cruzamento e rumo do robô **parado**. Missão ativa → `409 DEVICE_BUSY`; fora da malha ou bloqueado → `422 ROUTE_INVALID`. Resposta `{currentPoint, heading, positionConfidence:"confirmed"}` |
| POST | `/missions/:id/force-close` | **Somente admin.** Leva missão `uncertain` a `aborted` **sem** confirmação do dispositivo: sem `endedAt`, `durationSeconds:null`, libera a reserva. Fora de `uncertain` → `409 CONFLICT_STATE`. Resposta `{missionId, state:"aborted"}` |

Campos opcionais acrescentados: `initialHeading` e `mapVersion` no corpo de envio; `missionId`, `commandId`, `actions`, `errors` na resposta; `missionId`, `state`, `actions` etc. em `GET .../route`. Erros: `404` inexistente, `409` conflito de estado/sessão/idempotência/`STALE_BLOCK`, `422` rota ou capacidade, `503` dispositivo indisponível.

### Posição inicial (política)

O contrato de envio não tem campo "confirmo a posição": o **primeiro waypoint declara onde o robô está**. Padrão do backend: **aceita**, registra no evento `mission_start` a divergência ("posição inicial declarada (x,y) difere da última conhecida (a,b)") e passa a posição para `confirmed`; a prévia sinaliza com `startMismatch`. A variável opcional `REQUIRE_CONFIRMED_POSITION=true` ativa o **modo estrito**: recusa divergência e posição `unknown` até `POST /api/robots/:id/position`. Ligar o modo estrito só quando a dashboard tiver a tela de confirmação de posição e rumo (FE-030).

### Dispositivo (`/device/*`) e interno (`/internal/*`)

- `POST /device/hello`, `GET /device/poll`, `POST /device/events` (ADR 0001). `ackedSequence` = maior sequência de evento **crítico** processada; o firmware retransmite os críticos pendentes do mais antigo ao mais novo no mesmo lote.
- Autenticação HMAC-SHA256 com cabeçalhos `X-Device-Id`, `X-Session-Id`, `X-Sequence`, `X-Timestamp`, `X-Signature`. Texto assinado: `MÉTODO \n CAMINHO+QUERY \n timestamp \n sequence \n sha256(corpo)`. Tolerância de relógio de 60 s; anti-replay por `X-Sequence` estritamente crescente na sessão. Falhas: `SIGNATURE_INVALID`, `CLOCK_SKEW`, `REPLAY_DETECTED` (401).
- `POST /internal/events` (entrega push do Pub/Sub) e `POST /internal/offline-check` (Cloud Scheduler) aceitam **somente** credencial OIDC interna; um token de operador é recusado.

### Papéis

`viewer` só lê; `operator` lê e comanda; `admin` tudo. Reconhecer alerta e importar logs **nunca** geram comando nem alteram missão ativa.

## Consequências

- Pequena divergência de `BACKEND_INTEGRATION.md`: ele afirma "sem demo"; o código tem `VITE_DEMO`. Não afeta o contrato HTTP.
- O backend real só é considerado conforme se passar a suíte de contrato inteira (`npm run contract:test`).
- Mudanças incompatíveis exigem versão MAJOR de `@roboflow/contracts` e aviso no CHANGELOG.
