# Changelog — @roboflow/contracts

Formato: [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/) e versionamento semântico (ver `README.md`).

## [1.1.0] — 26/10/2026

Mudanças **aditivas** pedidas pela Frente B (ver `backend/CONTRACT_GAPS.md`).

### Adicionado
- `MISSION_TRANSITIONS`: `loading → aborted`, `running → aborted`, `uncertain → completed` e `uncertain → blocked` (reconciliação por `snapshot`/`hello`).
- `POST /api/robots/:id/position` `{x,y,heading}` → `{currentPoint, heading, positionConfidence:"confirmed"}` (operador/admin; `409 DEVICE_BUSY` com missão ativa; `422 ROUTE_INVALID` fora da malha ou em nó bloqueado).
- `POST /api/missions/:id/force-close` (somente admin) → `{missionId, state:"aborted"}`: leva missão `uncertain` a `aborted` sem confirmação do dispositivo (sem `endedAt`, `durationSeconds:null`); `409 CONFLICT_STATE` fora de `uncertain`.
- Servidor mock com token de admin (`admin-token`), os dois endpoints e a semântica de `ackedSequence` crítica; opção `--admin-token` e 5 verificações novas no runner (total 58); 9 fixtures; OpenAPI com 30 operações.

### Alterado (documentação/semântica do protocolo)
- **`ackedSequence` conta só eventos críticos**: é a maior `sequence` de evento crítico processada na sessão, e **não** a maior sequência contígua entre todos os eventos (telemetria e `action_started` são descartáveis). O firmware retransmite os críticos pendentes (`sequence > ackedSequence`) **do mais antigo ao mais novo, no mesmo lote**, mantendo `messageId` e `sequence`; o servidor deduplica. O protocolo ainda não tinha consumidores em produção.

### Política documentada
- Posição inicial: o primeiro waypoint declara o robô; padrão aceita e registra a divergência em `mission_start`; `REQUIRE_CONFIRMED_POSITION=true` (opcional no backend) exige `position` (ADR 0005).

## [1.0.0] — 26/10/2026

Primeira versão. Formaliza o contrato de `dashboard/BACKEND_INTEGRATION.md` e acrescenta as extensões dos ADRs 0001–0005.

### Adicionado
- Schemas zod de todos os payloads atuais da dashboard (`Robot`, `Mission`, `LogEvent`, `Alert`, métricas, malha, rota, importação), compatíveis campo a campo com `dashboard/src/types/index.ts`.
- Registro `ENDPOINTS` com 28 operações: as 14 já consumidas pela dashboard mais prévia de rota, controle de missão (`start`/`stop`/`resume`/`abort`), `GET /commands/:id`, `GET /missions/:id/execution`, `GET /devices/:id/status`, `GET /robots/:id/events`, `POST /device/hello`, `GET /device/poll`, `POST /device/events`, `POST /internal/events`, `POST /internal/offline-check`.
- Máquina de estados da missão (10 estados), projeção para o status público e tabela de transições.
- Comandos de dispositivo e seu ciclo (`pending`, `accepted`, `rejected`, `expired`, `uncertain`).
- Protocolo do dispositivo sobre HTTPS por poll, com eventos críticos confirmados por `ackedSequence`.
- Envelope de erro `{ success:false, message, error }` com 22 códigos e seus status HTTP.
- `translateRoute`, `findPath`, `simulateActions` (puras), com as validações de `backend/README.md` §5.2.
- Assinatura HMAC-SHA256 do dispositivo (`./signing`) com tolerância de relógio e anti-replay.
- Agregação de métricas de referência e projeção de eventos do dispositivo para os enums públicos.
- Seed (4 mapas, 4 dispositivos, 4 robôs, 10 missões, 38 eventos, 4 alertas, rota RT-0041), 142 fixtures, servidor mock e suíte de contrato (53 verificações), `openapi.json`.

### Regra operacional (ADR 0008)
- Um `start` e um `resume` pendentes por vez, por missão: segundo pedido com outra chave → 409 `CONFLICT_STATE`. `stop`/`abort` nunca são bloqueados.

### Decisões que divergem de documentos anteriores
- Eixo y para baixo (ADR 0004) em lugar de y para o norte de `backend/README.md` §4.
- Sem `POST /missions`; o envio de rota cria a missão (ADR 0005).
- Sem heartbeat de 250 ms nem parada por 1 s sem autorização (ADR 0002).
- Fio do dispositivo: HTTPS por poll no lugar de serial (ADR 0001).
