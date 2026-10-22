/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type EventSeverity = 'info' | 'warning' | 'error' | 'critical';

export type EventType =
  | 'mission_start'
  | 'command'
  | 'state_change'
  | 'presence_detected'
  | 'stop_preventive'
  | 'resume'
  | 'destination_reached'
  | 'mission_end'
  | 'error'
  | 'warning'
  | 'unknown';

export type RoverState =
  | 'idle'
  | 'moving'
  | 'stopped'
  | 'obstacle_hold'
  | 'navigating'
  | 'completed'
  | 'error'
  | 'unknown';

export type RobotStatus =
  | 'online'
  | 'busy'
  | 'idle'
  | 'offline'
  | 'error'
  | 'maintenance';

/**
 * Um robô (AGV) conectado à central.
 *
 * A frota é a unidade de navegação da interface: a tela inicial agrega
 * todos os robôs, e cada robô tem o mesmo painel restrito aos seus dados.
 */
export interface Robot {
  id: string;
  name: string;
  /** Setor/linha de produção onde o robô opera. */
  area?: string;
  model?: string;
  status: RobotStatus;
  /** Estado do firmware no último contato. */
  roverState?: RoverState;
  /** Missão que o robô executa agora, quando houver. */
  currentMissionId?: string;
  /** Carga da bateria em percentual (0–100), ou `null` se não reportada. */
  batteryPercent?: number | null;
  /** Último ponto conhecido na malha, no formato "x,y". */
  currentPoint?: string | null;
  firmwareVersion?: string;
  lastSeenAt: string;
  activeAlertsCount: number;
}

export type MissionStatus =
  | 'completed'
  | 'in_progress'
  | 'aborted'
  | 'failed'
  | 'indeterminate';

export interface LogEvent {
  id: string;
  missionId: string;
  /** Robô que emitiu o evento. Obrigatório na operação multi-robô. */
  robotId: string;
  timestamp: string; // ISO 8601 string
  eventType: EventType;
  command?: string;
  roverState?: RoverState;
  severity: EventSeverity;
  message: string;
  payload?: Record<string, unknown>;
  raw?: string;
}

export interface StopReasonCount {
  reason: string;
  count: number;
}

export interface Mission {
  id: string;
  robotId: string;
  origin: string;
  destination: string;
  status: MissionStatus;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number | null;
  stopCount: number;
  presenceStopCount: number;
  errorCount: number;
  eventCount: number;
  stopReasons: StopReasonCount[];
  /**
   * Linha do tempo completa da missão.
   *
   * Opcional na listagem (`GET /missions`) para manter a resposta leve —
   * o modal de detalhe busca em `GET /missions/:id` quando ausente.
   */
  events?: LogEvent[];
}

export interface Alert {
  id: string;
  title: string;
  description: string;
  severity: EventSeverity;
  timestamp: string;
  missionId?: string;
  /** Robô de origem do alerta. Ausente em alertas da frota como um todo. */
  robotId?: string;
  occurrenceCount: number;
  acknowledged: boolean;
  acknowledgedAt?: string;
  relatedEventIds: string[];
}

export interface DashboardMetrics {
  totalMissions: number;
  completedMissions: number;
  inProgressMissions: number;
  failedMissions: number;
  abortedMissions: number;
  indeterminateMissions: number;
  avgDurationSeconds: number | null;
  medianDurationSeconds: number | null;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
  totalStops: number;
  presenceStops: number;
  otherStops: number;
  unknownStops: number;
  completionRate: number; // 0 to 100
  activeAlertsCount: number;
  totalErrors: number;
  previousPeriodComparison?: {
    totalMissionsDiffPercent: number | null;
    completionRateDiff: number | null;
    avgDurationDiffPercent: number | null;
    stopsDiffPercent: number | null;
  };
}

export type TimePeriod = '24h' | '7d' | '30d' | 'all' | 'custom';

export interface GlobalFilterState {
  period: TimePeriod;
  /** Restringe a consulta a um robô. Ausente = frota inteira. */
  robotId?: string;
  startDate?: string;
  endDate?: string;
  origin?: string;
  destination?: string;
  status?: string;
  search?: string;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
  total: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  error?: string;
  /** Total de registros disponíveis no backend (endpoints de listagem). */
  total?: number;
  page?: number;
  pageSize?: number;
}

/** Resultado de POST /logs/import — ver BACKEND_INTEGRATION.md §3.6 */
export interface ImportResult {
  importedCount: number;
  ignoredCount?: number;
}

// ---------------------------------------------------------------------------
// Malha de navegação e planejamento de rota
// ---------------------------------------------------------------------------

/**
 * Um vértice da malha do chão de fábrica.
 *
 * A malha é uma grade de vértices ligados por trilhos ortogonais: o robô
 * só anda sobre as linhas, nunca em diagonal. As coordenadas são
 * 0-indexadas, com a origem `(0, 0)` no canto superior esquerdo.
 */
export interface GridPoint {
  /** Coluna (eixo horizontal), 0-indexada. */
  x: number;
  /** Linha (eixo vertical), 0-indexada. */
  y: number;
  /** Rótulo opcional do ponto — nome da estação, quando houver. */
  label?: string;
  /**
   * `blocked` remove o vértice da malha: o planejador nunca traça rota
   * por ele e o operador não consegue selecioná-lo.
   */
  kind?: 'free' | 'station' | 'blocked';
}

/** A malha percorrível de um robô, como o backend a descreve. */
export interface RobotGrid {
  /** Número de vértices no eixo horizontal. */
  cols: number;
  /** Número de vértices no eixo vertical. */
  rows: number;
  /**
   * Vértices com característica própria (estação ou bloqueio).
   * Os vértices omitidos são livres.
   */
  points?: GridPoint[];
}

/** Um ponto da rota, na ordem em que o robô deve visitá-lo. */
export interface RouteWaypoint {
  x: number;
  y: number;
}

/** A rota montada pelo operador, pronta para ser enviada ao robô. */
export interface RoutePlan {
  robotId: string;
  /**
   * Sequência ordenada de vértices, do primeiro ao último.
   * Vértices consecutivos são sempre adjacentes na malha.
   */
  waypoints: RouteWaypoint[];
}

/** Resposta de `POST /robots/:id/route`. */
export interface RouteSubmitResult {
  routeId: string;
  accepted: boolean;
  waypointCount: number;
  message?: string;
}

/** Rota atualmente carregada no robô — `GET /robots/:id/route`. */
export interface ActiveRoute {
  routeId: string;
  robotId: string;
  waypoints: RouteWaypoint[];
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'cancelled';
  /** Índice do waypoint que o robô já alcançou, ou `null` se não iniciou. */
  currentWaypointIndex?: number | null;
}

/**
 * Indicadores da frota inteira — `GET /fleet/metrics`.
 *
 * Estende os mesmos KPIs operacionais do painel de um robô com a
 * contagem de robôs por estado e o recorte por robô, que alimenta o
 * gráfico comparativo da tela inicial.
 */
export interface FleetMetrics extends DashboardMetrics {
  totalRobots: number;
  onlineRobots: number;
  offlineRobots: number;
  errorRobots: number;
  /** Um resumo por robô, para comparação lado a lado. */
  perRobot: RobotMetricsSummary[];
}

/** Recorte enxuto dos números de um robô, usado nos comparativos. */
export interface RobotMetricsSummary {
  robotId: string;
  robotName: string;
  totalMissions: number;
  completedMissions: number;
  totalStops: number;
  totalErrors: number;
  completionRate: number;
  avgDurationSeconds: number | null;
}
