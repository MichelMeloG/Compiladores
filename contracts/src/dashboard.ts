/**
 * Payloads consumidos hoje pela dashboard (`dashboard/src/types/index.ts` e
 * `dashboard/BACKEND_INTEGRATION.md`). Compatibilidade campo a campo: nada
 * aqui pode ser removido, renomeado ou tornar-se obrigatório sem MAJOR.
 */
import { z } from 'zod';
import {
  EventSeveritySchema,
  EventTypeSchema,
  IdSchema,
  IsoDateSchema,
  MissionStatusSchema,
  RobotStatusSchema,
  RoverStateSchema,
  TimePeriodSchema,
} from './common.js';
import { RouteWaypointSchema } from './map.js';

// ---------------------------------------------------------------------------
// Robôs
// ---------------------------------------------------------------------------

export const RobotSchema = z.object({
  id: IdSchema,
  name: z.string(),
  area: z.string().optional(),
  model: z.string().optional(),
  status: RobotStatusSchema,
  roverState: RoverStateSchema.optional(),
  currentMissionId: z.string().optional(),
  batteryPercent: z.number().min(0).max(100).nullable().optional(),
  /** Vértice atual no formato "x,y" ou `null`. */
  currentPoint: z.string().regex(/^\d+,\d+$/).nullable().optional(),
  firmwareVersion: z.string().optional(),
  lastSeenAt: IsoDateSchema,
  activeAlertsCount: z.number().int().nonnegative(),
});
export type Robot = z.infer<typeof RobotSchema>;

// ---------------------------------------------------------------------------
// Eventos, missões, alertas
// ---------------------------------------------------------------------------

export const LogEventSchema = z.object({
  id: IdSchema,
  missionId: z.string().min(1),
  robotId: z.string().min(1),
  timestamp: IsoDateSchema,
  eventType: EventTypeSchema,
  command: z.string().optional(),
  roverState: RoverStateSchema.optional(),
  severity: EventSeveritySchema,
  message: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  raw: z.string().optional(),
});
export type LogEvent = z.infer<typeof LogEventSchema>;

/** Evento de dispositivo sem missão (diagnóstico): `missionId` é opcional. */
export const RobotEventSchema = LogEventSchema.extend({
  missionId: z.string().min(1).optional(),
});
export type RobotEvent = z.infer<typeof RobotEventSchema>;

export const StopReasonCountSchema = z.object({
  reason: z.string(),
  count: z.number().int().nonnegative(),
});
export type StopReasonCount = z.infer<typeof StopReasonCountSchema>;

export const MissionSchema = z.object({
  id: IdSchema,
  robotId: z.string().min(1),
  origin: z.string(),
  destination: z.string(),
  status: MissionStatusSchema,
  startedAt: IsoDateSchema,
  endedAt: IsoDateSchema.optional(),
  durationSeconds: z.number().nonnegative().nullable(),
  stopCount: z.number().int().nonnegative(),
  presenceStopCount: z.number().int().nonnegative(),
  errorCount: z.number().int().nonnegative(),
  eventCount: z.number().int().nonnegative(),
  stopReasons: z.array(StopReasonCountSchema),
  events: z.array(LogEventSchema).optional(),
});
export type Mission = z.infer<typeof MissionSchema>;

export const AlertSchema = z.object({
  id: IdSchema,
  title: z.string(),
  description: z.string(),
  severity: EventSeveritySchema,
  timestamp: IsoDateSchema,
  missionId: z.string().optional(),
  robotId: z.string().optional(),
  occurrenceCount: z.number().int().nonnegative(),
  acknowledged: z.boolean(),
  acknowledgedAt: IsoDateSchema.optional(),
  relatedEventIds: z.array(z.string()),
});
export type Alert = z.infer<typeof AlertSchema>;

// ---------------------------------------------------------------------------
// Métricas
// ---------------------------------------------------------------------------

const nullableNumber = z.number().nonnegative().nullable();

export const DashboardMetricsSchema = z.object({
  totalMissions: z.number().int().nonnegative(),
  completedMissions: z.number().int().nonnegative(),
  inProgressMissions: z.number().int().nonnegative(),
  failedMissions: z.number().int().nonnegative(),
  abortedMissions: z.number().int().nonnegative(),
  indeterminateMissions: z.number().int().nonnegative(),
  avgDurationSeconds: nullableNumber,
  medianDurationSeconds: nullableNumber,
  minDurationSeconds: nullableNumber,
  maxDurationSeconds: nullableNumber,
  totalStops: z.number().int().nonnegative(),
  presenceStops: z.number().int().nonnegative(),
  otherStops: z.number().int().nonnegative(),
  unknownStops: z.number().int().nonnegative(),
  /** Percentual de 0 a 100 (NÃO fração). */
  completionRate: z.number().min(0).max(100),
  activeAlertsCount: z.number().int().nonnegative(),
  totalErrors: z.number().int().nonnegative(),
  previousPeriodComparison: z
    .object({
      totalMissionsDiffPercent: z.number().nullable(),
      completionRateDiff: z.number().nullable(),
      avgDurationDiffPercent: z.number().nullable(),
      stopsDiffPercent: z.number().nullable(),
    })
    .optional(),
});
export type DashboardMetrics = z.infer<typeof DashboardMetricsSchema>;

export const RobotMetricsSummarySchema = z.object({
  robotId: z.string(),
  robotName: z.string(),
  totalMissions: z.number().int().nonnegative(),
  completedMissions: z.number().int().nonnegative(),
  totalStops: z.number().int().nonnegative(),
  totalErrors: z.number().int().nonnegative(),
  completionRate: z.number().min(0).max(100),
  avgDurationSeconds: nullableNumber,
});
export type RobotMetricsSummary = z.infer<typeof RobotMetricsSummarySchema>;

export const FleetMetricsSchema = DashboardMetricsSchema.extend({
  totalRobots: z.number().int().nonnegative(),
  onlineRobots: z.number().int().nonnegative(),
  offlineRobots: z.number().int().nonnegative(),
  errorRobots: z.number().int().nonnegative(),
  perRobot: z.array(RobotMetricsSummarySchema),
});
export type FleetMetrics = z.infer<typeof FleetMetricsSchema>;

// ---------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------

/** Corpo de `POST /api/logs/import`. Limite de lote documentado em `LIMITS`. */
export const ImportRequestSchema = z.object({
  events: z.array(LogEventSchema).min(1),
});
export type ImportRequest = z.infer<typeof ImportRequestSchema>;

export const ImportResultSchema = z.object({
  importedCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative().optional(),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;

export const AckResultSchema = z.object({
  id: z.string(),
  acknowledged: z.boolean(),
  acknowledgedAt: IsoDateSchema.optional(),
});
export type AckResult = z.infer<typeof AckResultSchema>;

export const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  robotsConnected: z.number().int().nonnegative(),
});
export type Health = z.infer<typeof HealthSchema>;

// ---------------------------------------------------------------------------
// Parâmetros de consulta (todos opcionais; `all` é aceito e equivale a omitido)
// ---------------------------------------------------------------------------

const allOrValue = <T extends z.ZodType>(s: T) => z.union([z.literal('all'), s]);

const baseListQuery = {
  period: TimePeriodSchema.optional(),
  /** Com `period=custom`. Intervalo [startDate, endDate) em UTC. */
  startDate: IsoDateSchema.optional(),
  endDate: IsoDateSchema.optional(),
  robotId: z.string().optional(),
  /** Extensão: tamanho de página (padrão e teto em `LIMITS`). */
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** Extensão: cursor opaco devolvido em `nextCursor`. */
  cursor: z.string().optional(),
};

export const MetricsQuerySchema = z.object({
  period: TimePeriodSchema.optional(),
  startDate: IsoDateSchema.optional(),
  endDate: IsoDateSchema.optional(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  robotId: z.string().optional(),
});
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;

export const FleetMetricsQuerySchema = z.object({
  period: TimePeriodSchema.optional(),
  startDate: IsoDateSchema.optional(),
  endDate: IsoDateSchema.optional(),
});

export const MissionsQuerySchema = z.object({
  ...baseListQuery,
  origin: z.string().optional(),
  destination: z.string().optional(),
  status: allOrValue(MissionStatusSchema).optional(),
  search: z.string().optional(),
});
export type MissionsQuery = z.infer<typeof MissionsQuerySchema>;

export const LogsQuerySchema = z.object({
  ...baseListQuery,
  missionId: z.string().optional(),
  eventType: allOrValue(EventTypeSchema).optional(),
  severity: allOrValue(EventSeveritySchema).optional(),
  search: z.string().optional(),
});
export type LogsQuery = z.infer<typeof LogsQuerySchema>;

export const AlertsQuerySchema = z.object({
  robotId: z.string().optional(),
  severity: allOrValue(EventSeveritySchema).optional(),
  status: allOrValue(z.enum(['unacknowledged', 'acknowledged'])).optional(),
  missionId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});
export type AlertsQuery = z.infer<typeof AlertsQuerySchema>;

export const RobotEventsQuerySchema = z.object({
  period: TimePeriodSchema.optional(),
  startDate: IsoDateSchema.optional(),
  endDate: IsoDateSchema.optional(),
  severity: allOrValue(EventSeveritySchema).optional(),
  eventType: allOrValue(EventTypeSchema).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

/** Limites operacionais (cota gratuita e proteção contra abuso). */
export const LIMITS = {
  listDefaultLimit: 50,
  listMaxLimit: 500,
  importMaxEvents: 500,
  importMaxBodyBytes: 2 * 1024 * 1024,
  deviceBodyMaxBytes: 4096,
  deviceEventsPerRequest: 16,
  maxWaypoints: 65,
} as const;

export { RouteWaypointSchema };
