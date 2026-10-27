/**
 * Protocolo AGV <-> nuvem sobre HTTPS por poll (ADR 0001, 0002).
 *
 *   POST /device/hello   sessão nova (a cada boot): capacidades e estado
 *   GET  /device/poll    pede comandos; a resposta dita `nextPollMs`
 *   POST /device/events  lote de eventos (até 16) e, de carona, comandos novos
 *
 * Derivado de backend/README.md §11, com duas adaptações ao poll:
 *  - não há `heartbeat` nem TTL absoluto: o comando é entregue na resposta de
 *    uma requisição do próprio dispositivo e carrega `validForMs` RELATIVO ao
 *    instante do recebimento (o ESP32 não precisa de UTC);
 *  - confirmação de eventos por `ackedSequence`, para retransmissão dos críticos.
 *
 * `ackedSequence` (REGRA)
 *   É a maior `sequence` de evento CRÍTICO (`isCriticalEvent`) já processada na
 *   sessão. NÃO é "contígua entre todos os eventos": telemetria e `action_started`
 *   são descartáveis e não participam; exigir contiguidade travaria a
 *   confirmação a cada amostra de telemetria substituída.
 *
 * Retransmissão pelo firmware
 *   O firmware guarda os eventos críticos ainda não confirmados
 *   (`sequence > ackedSequence`) e, a cada requisição, reenvia TODOS, do mais
 *   antigo ao mais novo, NO MESMO LOTE (`POST /device/events`, até 16),
 *   mantendo `messageId` e `sequence` originais. Descarta o que ficou
 *   `<= ackedSequence`. O servidor deduplica por `sequence`: reenviar é seguro.
 *   Telemetria nunca é retransmitida (a amostra nova a substitui).
 */
import { z } from 'zod';
import {
  CommandSchema,
  HeadingSchema,
  IdSchema,
  IsoDateSchema,
  PROTOCOL_VERSION,
} from './common.js';
import { CapabilitiesSchema } from './map.js';
import { DeviceStateSchema, RejectReasonSchema } from './mission.js';

// ---------------------------------------------------------------------------
// Pedaços comuns
// ---------------------------------------------------------------------------

const V = z.literal(PROTOCOL_VERSION);
const nodeIdField = z.string().regex(/^\d+,\d+$/, 'nó deve ser "x,y"');
const bit = z.union([z.literal(0), z.literal(1)]);
export const LineReadingSchema = z.tuple([bit, bit, bit]);
export type LineReading = z.infer<typeof LineReadingSchema>;

/** Campos de toda mensagem enviada PELO dispositivo. */
const upBase = {
  v: V,
  messageId: IdSchema,
  deviceId: IdSchema,
  /** Muda a cada boot (ex.: "boot-7"). */
  sessionId: IdSchema,
  /** Monótona e crescente dentro da sessão, a partir de 1. */
  sequence: z.number().int().positive(),
  /** Relógio monotônico do ESP32 (NÃO é data UTC). */
  uptimeMs: z.number().int().nonnegative(),
};

const missionRef = {
  missionId: IdSchema,
  routeRevision: z.number().int().positive(),
};

// ---------------------------------------------------------------------------
// Dispositivo -> nuvem
// ---------------------------------------------------------------------------

export const HelloMessageSchema = z.object({
  ...upBase,
  type: z.literal('hello'),
  firmwareVersion: z.string().min(1),
  protocolVersion: z.number().int().positive(),
  capabilities: CapabilitiesSchema,
  state: DeviceStateSchema,
  /** Última missão que o firmware ainda lembra (nunca é retomada sozinha). */
  lastMission: z
    .object({ ...missionRef, completedActions: z.number().int().nonnegative() })
    .optional(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

export const AckMessageSchema = z.object({
  ...upBase,
  type: z.literal('ack'),
  /** `messageId` do comando respondido (= `commandId`). */
  replyTo: IdSchema,
  result: z.literal('accepted'),
  missionId: IdSchema.optional(),
  routeRevision: z.number().int().positive().optional(),
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

export const RejectMessageSchema = z.object({
  ...upBase,
  type: z.literal('reject'),
  replyTo: IdSchema,
  reason: RejectReasonSchema,
  detail: z.string().max(200).optional(),
});
export type RejectMessage = z.infer<typeof RejectMessageSchema>;

export const TelemetryMessageSchema = z.object({
  ...upBase,
  type: z.literal('telemetry'),
  state: DeviceStateSchema,
  missionId: IdSchema.optional(),
  routeRevision: z.number().int().positive().optional(),
  actionIndex: z.number().int().nonnegative().nullable().optional(),
  phase: z
    .enum(['aligning', 'leaving_node', 'following_segment', 'confirming_node', 'idle'])
    .optional(),
  line: LineReadingSchema,
  /** `null` quando inválida: NUNCA um número artificial de "caminho livre". */
  distanceCm: z.number().nonnegative().nullable(),
  distanceValid: z.boolean(),
  distanceAgeMs: z.number().int().nonnegative().nullable(),
  blockId: z.string().nullable().optional(),
  blockReasons: z.array(z.string()).optional(),
});
export type TelemetryMessage = z.infer<typeof TelemetryMessageSchema>;

export const ActionStartedMessageSchema = z.object({
  ...upBase,
  type: z.literal('action_started'),
  ...missionRef,
  /** Índice da ação DO PRÓPRIO evento. */
  actionIndex: z.number().int().nonnegative(),
  command: CommandSchema.optional(),
});

export const ActionCompletedMessageSchema = z.object({
  ...upBase,
  type: z.literal('action_completed'),
  ...missionRef,
  actionIndex: z.number().int().nonnegative(),
  expectedNode: nodeIdField,
});
export type ActionCompletedMessage = z.infer<typeof ActionCompletedMessageSchema>;

export const MissionCompletedMessageSchema = z.object({
  ...upBase,
  type: z.literal('mission_completed'),
  ...missionRef,
  completedActions: z.number().int().nonnegative(),
});

/** Início de um episódio de bloqueio (conta UMA parada, não uma por amostra). */
export const BlockStartedMessageSchema = z.object({
  ...upBase,
  type: z.literal('block_started'),
  missionId: IdSchema.optional(),
  blockId: IdSchema,
  reasons: z.array(z.enum(['obstacle', 'line_lost', 'sensor_invalid', 'sensor_stale', 'stop_requested', 'fault'])).min(1),
  distanceCm: z.number().nonnegative().nullable().optional(),
  actionIndex: z.number().int().nonnegative().nullable().optional(),
});

export const BlockClearedMessageSchema = z.object({
  ...upBase,
  type: z.literal('block_cleared'),
  missionId: IdSchema.optional(),
  blockId: IdSchema,
});

export const FaultMessageSchema = z.object({
  ...upBase,
  type: z.literal('fault'),
  code: z.string().min(1).max(64),
  message: z.string().max(200),
  severity: z.enum(['warning', 'error', 'critical']),
  missionId: IdSchema.optional(),
});

/** Estado de progresso para reconciliação após lacuna de eventos críticos. */
export const SnapshotMessageSchema = z.object({
  ...upBase,
  type: z.literal('snapshot'),
  state: DeviceStateSchema,
  missionId: IdSchema.optional(),
  routeRevision: z.number().int().positive().optional(),
  completedActions: z.number().int().nonnegative().optional(),
  actionIndex: z.number().int().nonnegative().nullable().optional(),
  blockId: z.string().nullable().optional(),
});

export const DeviceEventMessageSchema = z.discriminatedUnion('type', [
  AckMessageSchema,
  RejectMessageSchema,
  TelemetryMessageSchema,
  ActionStartedMessageSchema,
  ActionCompletedMessageSchema,
  MissionCompletedMessageSchema,
  BlockStartedMessageSchema,
  BlockClearedMessageSchema,
  FaultMessageSchema,
  SnapshotMessageSchema,
]);
export type DeviceEventMessage = z.infer<typeof DeviceEventMessageSchema>;

/** Tipos que exigem confirmação (`ackedSequence`) e retransmissão. */
export const CRITICAL_EVENT_TYPES: ReadonlySet<DeviceEventMessage['type'] | 'hello'> = new Set([
  'hello',
  'ack',
  'reject',
  'action_completed',
  'mission_completed',
  'block_started',
  'block_cleared',
  'fault',
  'snapshot',
]);

export function isCriticalEvent(type: string): boolean {
  return (CRITICAL_EVENT_TYPES as ReadonlySet<string>).has(type);
}

// ---------------------------------------------------------------------------
// Nuvem -> dispositivo (dentro de `commands`)
// ---------------------------------------------------------------------------

const downBase = {
  v: V,
  /** = `commandId`; o dispositivo usa em `replyTo`. */
  messageId: IdSchema,
  deviceId: IdSchema,
  sessionId: IdSchema,
  missionId: IdSchema,
  /** Validade relativa ao recebimento. O dispositivo descarta se já passou. */
  validForMs: z.number().int().positive(),
};

export const LoadRouteCommandSchema = z
  .object({
    ...downBase,
    type: z.literal('load_route'),
    routeRevision: z.number().int().positive(),
    actions: z.array(CommandSchema).min(1).max(256),
    expectedNodes: z.array(nodeIdField).min(1).max(256),
    startNode: nodeIdField,
    initialHeading: HeadingSchema,
  })
  .refine((m) => m.actions.length === m.expectedNodes.length, {
    message: 'actions e expectedNodes precisam ter o mesmo comprimento',
    path: ['expectedNodes'],
  });
export type LoadRouteCommand = z.infer<typeof LoadRouteCommandSchema>;

export const StartCommandSchema = z.object({
  ...downBase,
  type: z.literal('start'),
  routeRevision: z.number().int().positive(),
});
export const StopCommandSchema = z.object({ ...downBase, type: z.literal('stop') });
export const ResumeCommandSchema = z.object({
  ...downBase,
  type: z.literal('resume'),
  routeRevision: z.number().int().positive(),
  blockId: IdSchema,
});
export const AbortCommandSchema = z.object({ ...downBase, type: z.literal('abort') });

export const DeviceCommandMessageSchema = z.discriminatedUnion('type', [
  LoadRouteCommandSchema,
  StartCommandSchema,
  StopCommandSchema,
  ResumeCommandSchema,
  AbortCommandSchema,
]);
export type DeviceCommandMessage = z.infer<typeof DeviceCommandMessageSchema>;

// ---------------------------------------------------------------------------
// Corpos e respostas dos endpoints /device/*
// ---------------------------------------------------------------------------

/** Intervalos de poll (ADR 0001). O servidor devolve o valor a usar. */
export const POLL_MS = {
  activeMission: 1500,
  idle: 30000,
  min: 1000,
  max: 60000,
} as const;

export const DeviceHelloRequestSchema = HelloMessageSchema;

const syncCommon = {
  sessionId: IdSchema,
  serverTime: IsoDateSchema,
  /** Próximo poll, ditado pelo servidor. */
  nextPollMs: z.number().int().min(POLL_MS.min).max(POLL_MS.max),
  /**
   * Maior `sequence` de evento CRÍTICO processada na sessão (não é contígua
   * entre todos os eventos). O dispositivo descarta os críticos `<=` este valor
   * e retransmite os demais do mais antigo ao mais novo, no mesmo lote.
   */
  ackedSequence: z.number().int().nonnegative(),
  commands: z.array(DeviceCommandMessageSchema),
  /** Pede um `snapshot` ao dispositivo (lacuna detectada). */
  resync: z.boolean().default(false),
};

export const DeviceSyncResponseSchema = z.object(syncCommon);
export type DeviceSyncResponse = z.infer<typeof DeviceSyncResponseSchema>;

export const DeviceHelloResponseSchema = z.object({
  ...syncCommon,
  accepted: z.literal(true),
  /** `true` quando há missão ativa/incerta que exige reconciliação no servidor. */
  reconcileRequired: z.boolean(),
  limits: CapabilitiesSchema,
});
export type DeviceHelloResponse = z.infer<typeof DeviceHelloResponseSchema>;

export const DeviceEventsRequestSchema = z.object({
  events: z.array(DeviceEventMessageSchema).min(1).max(16),
});
export type DeviceEventsRequest = z.infer<typeof DeviceEventsRequestSchema>;

export const DeviceEventsResponseSchema = z.object({
  ...syncCommon,
  /** Eventos recusados (assinatura de conteúdo, sequência inválida, sessão velha). */
  rejected: z
    .array(z.object({ sequence: z.number().int().positive(), reason: z.string() }))
    .default([]),
});
export type DeviceEventsResponse = z.infer<typeof DeviceEventsResponseSchema>;

/** Mensagem Pub/Sub publicada pelo ingest e consumida em `/internal/events`. */
export const InternalEventEnvelopeSchema = z.object({
  eventId: z.string(),
  deviceId: z.string(),
  sessionId: z.string(),
  sequence: z.number().int().positive(),
  receivedAt: IsoDateSchema,
  event: DeviceEventMessageSchema,
});
export type InternalEventEnvelope = z.infer<typeof InternalEventEnvelopeSchema>;

/** Corpo de entrega de uma push subscription do Pub/Sub. */
export const PubSubPushBodySchema = z.object({
  message: z.object({
    data: z.string(),
    messageId: z.string(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string(), z.string()).optional(),
  }),
  subscription: z.string(),
});
export type PubSubPushBody = z.infer<typeof PubSubPushBodySchema>;

/** ID determinístico do evento no Firestore (dedupe por `create()`). */
export function deviceEventDocId(deviceId: string, sessionId: string, sequence: number): string {
  return `${deviceId}_${sessionId}_${sequence}`;
}
