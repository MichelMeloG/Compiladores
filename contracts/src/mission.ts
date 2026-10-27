/**
 * Missão: máquina de estados, comandos de dispositivo e contratos de rota.
 *
 * O estado interno é detalhado; o contrato público existente (`Mission.status`)
 * é uma PROJEÇÃO dele (`publicMissionStatus`). O estado detalhado é exposto em
 * `GET /api/missions/:id/execution`.
 */
import { z } from 'zod';
import {
  CommandSchema,
  HeadingSchema,
  IdSchema,
  IsoDateSchema,
  type MissionStatus,
} from './common.js';
import { RouteErrorSchema } from './geometry.js';
import { RouteWaypointSchema } from './map.js';

// ---------------------------------------------------------------------------
// Estados da missão (backend/README.md §8)
// ---------------------------------------------------------------------------

export const MissionStateSchema = z.enum([
  'queued',
  'loading',
  'ready',
  'running',
  'blocked',
  'paused',
  'completed',
  'aborted',
  'failed',
  'uncertain',
]);
export type MissionState = z.infer<typeof MissionStateSchema>;

export const TERMINAL_STATES: readonly MissionState[] = ['completed', 'aborted', 'failed'];

/** "Ativos" ocupam o dispositivo (inclui `uncertain`, que mantém a reserva). */
export const ACTIVE_STATES: readonly MissionState[] = [
  'queued',
  'loading',
  'ready',
  'running',
  'blocked',
  'paused',
  'uncertain',
];

/**
 * Transições permitidas. As de backend/README.md §8 mais as extensões aprovadas:
 *  - `queued->aborted` (cancelar antes de enviar);
 *  - `ready->failed` e `ready->uncertain` (perda de sessão com a fila já aceita);
 *  - `loading->aborted` e `running->aborted` (abort confirmado durante o
 *    carregamento ou com o robô em movimento);
 *  - `uncertain->completed` e `uncertain->blocked` (reconciliação por
 *    `snapshot`/`hello` que prova o fim da fila ou um bloqueio ativo).
 * `uncertain` nunca volta a `running` sozinho: sai por reconciliação ou por
 * encerramento explícito (`force-close`, somente admin, vai a `aborted`).
 */
export const MISSION_TRANSITIONS: Record<MissionState, readonly MissionState[]> = {
  queued: ['loading', 'failed', 'aborted'],
  loading: ['ready', 'failed', 'uncertain', 'aborted'],
  ready: ['running', 'aborted', 'failed', 'uncertain'],
  running: ['blocked', 'paused', 'completed', 'failed', 'uncertain', 'aborted'],
  blocked: ['running', 'aborted', 'failed', 'uncertain'],
  paused: ['running', 'aborted', 'uncertain'],
  completed: [],
  aborted: [],
  failed: [],
  uncertain: ['paused', 'aborted', 'failed', 'completed', 'blocked'],
};

export function canTransition(from: MissionState, to: MissionState): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

/** Projeção para o enum público: ativos viram `in_progress`; incerto vira `indeterminate`. */
export function publicMissionStatus(state: MissionState): MissionStatus {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'aborted':
      return 'aborted';
    case 'failed':
      return 'failed';
    case 'uncertain':
      return 'indeterminate';
    default:
      return 'in_progress';
  }
}

// ---------------------------------------------------------------------------
// Comandos de dispositivo
// ---------------------------------------------------------------------------

export const DeviceCommandTypeSchema = z.enum([
  'load_route',
  'start',
  'stop',
  'resume',
  'abort',
]);
export type DeviceCommandType = z.infer<typeof DeviceCommandTypeSchema>;

/**
 * Ciclo: `pending` -> `accepted` | `rejected` | `expired` | `uncertain`.
 * `accepted` confirma a aplicação da transição de controle, NÃO a conclusão
 * de uma ação da rota.
 */
export const DeviceCommandStatusSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
  'expired',
  'uncertain',
]);
export type DeviceCommandStatus = z.infer<typeof DeviceCommandStatusSchema>;

export const COMMAND_TERMINAL_STATUSES: readonly DeviceCommandStatus[] = [
  'accepted',
  'rejected',
  'expired',
  'uncertain',
];

export const RejectReasonSchema = z.enum([
  'INVALID_SESSION',
  'BUSY',
  'UNSUPPORTED_ACTION',
  'QUEUE_TOO_LARGE',
  'BLOCKED',
  'STALE_BLOCK',
  'EXPIRED',
  'NO_ROUTE_LOADED',
  'INVALID_STATE',
  'MALFORMED',
]);
export type RejectReason = z.infer<typeof RejectReasonSchema>;

/** Resposta de `GET /api/commands/:id`. */
export const DeviceCommandSchema = z.object({
  id: IdSchema,
  type: DeviceCommandTypeSchema,
  missionId: IdSchema,
  deviceId: IdSchema,
  sessionId: z.string().optional(),
  status: DeviceCommandStatusSchema,
  reason: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  createdAt: IsoDateSchema,
  /** Prazo absoluto no servidor; o dispositivo recebe `validForMs` relativo. */
  expiresAt: IsoDateSchema,
  deliveredAt: IsoDateSchema.optional(),
  resolvedAt: IsoDateSchema.optional(),
  operatorUid: z.string().optional(),
  /** Para `resume`: bloqueio exibido ao operador. */
  blockId: z.string().optional(),
});
export type DeviceCommand = z.infer<typeof DeviceCommandSchema>;

// ---------------------------------------------------------------------------
// Rotas: prévia, envio e rota ativa
// ---------------------------------------------------------------------------

export const PositionConfidenceSchema = z.enum(['confirmed', 'estimated', 'unknown']);
export type PositionConfidence = z.infer<typeof PositionConfidenceSchema>;

const waypointsField = z.array(RouteWaypointSchema).min(0).max(65);

/** `POST /api/robots/:id/route/preview`. */
export const RoutePreviewRequestSchema = z.object({
  waypoints: waypointsField,
  /** Rumo atual do chassi. Se ausente, usa o último rumo confirmado do robô. */
  initialHeading: HeadingSchema.optional(),
  mapVersion: z.number().int().positive().optional(),
});
export type RoutePreviewRequest = z.infer<typeof RoutePreviewRequestSchema>;

export const RoutePreviewSchema = z.object({
  robotId: z.string(),
  mapId: z.string(),
  mapVersion: z.number().int().positive(),
  waypoints: z.array(RouteWaypointSchema),
  actions: z.array(CommandSchema),
  expectedNodes: z.array(z.string()),
  initialHeading: HeadingSchema.nullable(),
  finalHeading: HeadingSchema.nullable(),
  executable: z.boolean(),
  errors: z.array(RouteErrorSchema),
  /** O nó em que o robô declara estar difere do primeiro waypoint. */
  startMismatch: z.boolean().optional(),
});
export type RoutePreview = z.infer<typeof RoutePreviewSchema>;

/** `POST /api/robots/:id/route`. Cabeçalho `Idempotency-Key` obrigatório. */
export const RouteSubmitRequestSchema = z.object({
  waypoints: waypointsField,
  initialHeading: HeadingSchema.optional(),
  mapVersion: z.number().int().positive().optional(),
});
export type RouteSubmitRequest = z.infer<typeof RouteSubmitRequestSchema>;

/**
 * Resposta de `POST /api/robots/:id/route`. Os quatro primeiros campos são o
 * contrato atual (`RouteSubmitResult`); o resto é extensão opcional.
 * Recusa de negócio = HTTP 200 com `accepted:false` (ADR 0005).
 */
export const RouteSubmitResultSchema = z.object({
  routeId: z.string(),
  accepted: z.boolean(),
  waypointCount: z.number().int().nonnegative(),
  message: z.string().optional(),
  missionId: z.string().optional(),
  /** Comando `load_route` gerado. Carregar a fila NÃO inicia o movimento. */
  commandId: z.string().optional(),
  actions: z.array(CommandSchema).optional(),
  errors: z.array(RouteErrorSchema).optional(),
});
export type RouteSubmitResult = z.infer<typeof RouteSubmitResultSchema>;

export const ActiveRouteStatusSchema = z.enum(['queued', 'running', 'completed', 'cancelled']);

/** Resposta de `GET /api/robots/:id/route` (404 quando não há rota). */
export const ActiveRouteSchema = z.object({
  routeId: z.string(),
  robotId: z.string(),
  waypoints: z.array(RouteWaypointSchema),
  createdAt: IsoDateSchema,
  status: ActiveRouteStatusSchema,
  currentWaypointIndex: z.number().int().nonnegative().nullable().optional(),
  // ---- extensões (ADR 0005) ----
  missionId: z.string().optional(),
  state: MissionStateSchema.optional(),
  initialHeading: HeadingSchema.optional(),
  actions: z.array(CommandSchema).optional(),
  mapVersion: z.number().int().positive().optional(),
});
export type ActiveRoute = z.infer<typeof ActiveRouteSchema>;

// ---------------------------------------------------------------------------
// Posição inicial e encerramento forçado (extensões aprovadas)
// ---------------------------------------------------------------------------

/**
 * `POST /api/robots/:id/position`: o operador confirma o cruzamento e o rumo do
 * robô PARADO (sem missão ativa; com missão ativa => 409 DEVICE_BUSY).
 * Fora da malha ou em nó bloqueado => 422 ROUTE_INVALID.
 */
export const PositionRequestSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  heading: HeadingSchema,
});
export type PositionRequest = z.infer<typeof PositionRequestSchema>;

export const PositionResultSchema = z.object({
  /** "x,y" — mesmo formato de `Robot.currentPoint`. */
  currentPoint: z.string().regex(/^\d+,\d+$/),
  heading: HeadingSchema,
  positionConfidence: z.literal('confirmed'),
});
export type PositionResult = z.infer<typeof PositionResultSchema>;

/**
 * `POST /api/missions/:id/force-close` (somente admin): leva uma missão
 * `uncertain` a `aborted` SEM confirmação do dispositivo. Não inventa
 * `endedAt` nem sucesso: a missão fica sem `endedAt` e com
 * `durationSeconds: null`. Fora de `uncertain` => 409 CONFLICT_STATE.
 */
export const ForceCloseResultSchema = z.object({
  missionId: z.string(),
  state: z.literal('aborted'),
});
export type ForceCloseResult = z.infer<typeof ForceCloseResultSchema>;

// ---------------------------------------------------------------------------
// Controle de missão
// ---------------------------------------------------------------------------

export const ControlRequestSchema = z.object({
  /** Sessão de execução observada pelo cliente; divergência => 409 CONFLICT_SESSION. */
  sessionId: z.string().optional(),
  /** Obrigatório em `resume`: bloqueio exibido; divergência => 409 STALE_BLOCK. */
  blockId: z.string().optional(),
  reason: z.string().max(200).optional(),
});
export type ControlRequest = z.infer<typeof ControlRequestSchema>;

export const ResumeRequestSchema = ControlRequestSchema.extend({
  blockId: z.string().min(1),
});

/** Resposta `202` de start/stop/resume/abort. */
export const ControlAcceptedSchema = z.object({
  commandId: z.string(),
  missionId: z.string(),
  status: z.literal('pending'),
});
export type ControlAccepted = z.infer<typeof ControlAcceptedSchema>;

/** Resposta de `GET /api/missions/:id/execution`. */
export const ExecutionStateSchema = z.object({
  missionId: z.string(),
  deviceId: z.string(),
  sessionId: z.string().nullable(),
  state: MissionStateSchema,
  /** Item atual/próximo (0-based); `null` ao concluir a fila. */
  actionIndex: z.number().int().nonnegative().nullable(),
  completedActions: z.number().int().nonnegative(),
  totalActions: z.number().int().nonnegative(),
  lastConfirmedNode: z.string().nullable(),
  expectedNode: z.string().nullable(),
  atNode: z.boolean(),
  positionConfidence: PositionConfidenceSchema,
  headingAtLastConfirmedNode: HeadingSchema.nullable(),
  blockId: z.string().nullable(),
  blockReasons: z.array(z.string()),
  pendingCommands: z.array(DeviceCommandSchema),
  updatedAt: IsoDateSchema,
});
export type ExecutionState = z.infer<typeof ExecutionStateSchema>;

/** Estado do firmware reportado na telemetria. */
export const DeviceStateSchema = z.enum([
  'initializing',
  'ready',
  'running',
  'blocked',
  'paused',
  'finished',
  'fault',
]);
export type DeviceState = z.infer<typeof DeviceStateSchema>;

export const DeviceConnectionSchema = z.enum(['online', 'stale', 'offline']);

/** Resposta de `GET /api/devices/:id/status`. */
export const DeviceStatusSchema = z.object({
  deviceId: z.string(),
  robotId: z.string(),
  connection: DeviceConnectionSchema,
  sessionId: z.string().nullable(),
  firmwareVersion: z.string().optional(),
  protocolVersion: z.number().int().positive().optional(),
  capabilities: z
    .object({
      supportsReverse: z.boolean(),
      maxActions: z.number().int().positive(),
      maxMessageBytes: z.number().int().positive(),
    })
    .nullable(),
  state: DeviceStateSchema.nullable(),
  activeMissionId: z.string().nullable(),
  sensors: z
    .object({
      line: z.tuple([z.union([z.literal(0), z.literal(1)]), z.union([z.literal(0), z.literal(1)]), z.union([z.literal(0), z.literal(1)])]).nullable(),
      distanceCm: z.number().nonnegative().nullable(),
      distanceValid: z.boolean(),
      distanceAgeMs: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  blockId: z.string().nullable(),
  blockReasons: z.array(z.string()),
  lastSeenAt: IsoDateSchema.nullable(),
  /** Idade do dado exibido: a UI nunca deve afirmar conexão "ao vivo" sem isso. */
  dataAgeMs: z.number().int().nonnegative().nullable(),
  nextPollMs: z.number().int().positive().nullable(),
});
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;
