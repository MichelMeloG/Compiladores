/**
 * Primitivas compartilhadas: enums públicos, envelope HTTP e erros.
 *
 * Os enums de `EventSeverity`, `EventType`, `RoverState`, `RobotStatus` e
 * `MissionStatus` espelham `dashboard/src/types/index.ts` e NÃO podem receber
 * valores novos sem antes atualizar o frontend (ver CHANGELOG.md).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Enums públicos (espelho do frontend)
// ---------------------------------------------------------------------------

export const EventSeveritySchema = z.enum(['info', 'warning', 'error', 'critical']);
export type EventSeverity = z.infer<typeof EventSeveritySchema>;

export const EventTypeSchema = z.enum([
  'mission_start',
  'command',
  'state_change',
  'presence_detected',
  'stop_preventive',
  'resume',
  'destination_reached',
  'mission_end',
  'error',
  'warning',
  'unknown',
]);
export type EventType = z.infer<typeof EventTypeSchema>;

export const RoverStateSchema = z.enum([
  'idle',
  'moving',
  'stopped',
  'obstacle_hold',
  'navigating',
  'completed',
  'error',
  'unknown',
]);
export type RoverState = z.infer<typeof RoverStateSchema>;

export const RobotStatusSchema = z.enum([
  'online',
  'busy',
  'idle',
  'offline',
  'error',
  'maintenance',
]);
export type RobotStatus = z.infer<typeof RobotStatusSchema>;

export const MissionStatusSchema = z.enum([
  'completed',
  'in_progress',
  'aborted',
  'failed',
  'indeterminate',
]);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

export const TimePeriodSchema = z.enum(['24h', '7d', '30d', 'all', 'custom']);
export type TimePeriod = z.infer<typeof TimePeriodSchema>;

// ---------------------------------------------------------------------------
// Tipos escalares
// ---------------------------------------------------------------------------

/** Instante ISO 8601. O servidor emite sempre em UTC (`...Z`). */
export const IsoDateSchema = z.iso.datetime({ offset: true });

/** Identificador de recurso: não vazio, sem espaços nas pontas. */
export const IdSchema = z.string().trim().min(1).max(128);

// ---------------------------------------------------------------------------
// Rumo e comandos (ver ADR 0004)
// ---------------------------------------------------------------------------

/**
 * Rumo do chassi. ATENÇÃO: `E` aqui é LESTE (east). O comando de giro à
 * esquerda também se chama `E` (esquerda); por isso o código nunca mistura os
 * dois tipos: `Heading` e `Command` são tipos distintos.
 */
export const HeadingSchema = z.enum(['N', 'E', 'S', 'W']);
export type Heading = z.infer<typeof HeadingSchema>;

/** F = frente, T = trás (ré), D = direita, E = esquerda. */
export const CommandSchema = z.enum(['F', 'T', 'D', 'E']);
export type Command = z.infer<typeof CommandSchema>;

// ---------------------------------------------------------------------------
// Envelope HTTP
// ---------------------------------------------------------------------------

export const ErrorCodeSchema = z.enum([
  'INVALID_BODY',
  'INVALID_QUERY',
  'IDEMPOTENCY_KEY_REQUIRED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT_STATE',
  'CONFLICT_IDEMPOTENCY',
  'CONFLICT_SESSION',
  'STALE_BLOCK',
  'DEVICE_BUSY',
  'ROUTE_INVALID',
  'HEADING_REQUIRED',
  'CAPABILITY_UNSUPPORTED',
  'PAYLOAD_TOO_LARGE',
  'RATE_LIMITED',
  'SIGNATURE_INVALID',
  'REPLAY_DETECTED',
  'CLOCK_SKEW',
  'DEVICE_UNAVAILABLE',
  'NOT_IMPLEMENTED',
  'INTERNAL',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** Status HTTP canônico de cada código de erro. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  INVALID_BODY: 400,
  INVALID_QUERY: 400,
  IDEMPOTENCY_KEY_REQUIRED: 400,
  UNAUTHENTICATED: 401,
  SIGNATURE_INVALID: 401,
  REPLAY_DETECTED: 401,
  CLOCK_SKEW: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT_STATE: 409,
  CONFLICT_IDEMPOTENCY: 409,
  CONFLICT_SESSION: 409,
  STALE_BLOCK: 409,
  DEVICE_BUSY: 409,
  PAYLOAD_TOO_LARGE: 413,
  ROUTE_INVALID: 422,
  HEADING_REQUIRED: 422,
  CAPABILITY_UNSUPPORTED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
  DEVICE_UNAVAILABLE: 503,
};

export const ErrorEnvelopeSchema = z.object({
  success: z.literal(false),
  message: z.string().min(1),
  error: ErrorCodeSchema,
  /** Detalhes estruturados opcionais (ex.: lista de erros de rota). */
  details: z.unknown().optional(),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/** Envelope de sucesso `{ success: true, data }`. */
export function successEnvelope<T extends z.ZodType>(data: T) {
  return z.object({
    success: z.literal(true),
    data,
    message: z.string().optional(),
    total: z.number().int().nonnegative().optional(),
    page: z.number().int().positive().optional(),
    pageSize: z.number().int().positive().optional(),
    /** Cursor da próxima página (listas com `limit`). */
    nextCursor: z.string().optional(),
  });
}

export function buildError(
  error: ErrorCode,
  message: string,
  details?: unknown
): ErrorEnvelope {
  return details === undefined
    ? { success: false, message, error }
    : { success: false, message, error, details };
}

/** Versão do protocolo de dispositivo e do contrato HTTP. */
export const PROTOCOL_VERSION = 1 as const;
export const CONTRACT_VERSION = '1.1.0' as const;
