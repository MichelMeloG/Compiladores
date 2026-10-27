import type {
  Capabilities,
  ClosedEdge,
  Command,
  DeviceCommandStatus,
  DeviceCommandType,
  DeviceState,
  EventSeverity,
  EventType,
  Heading,
  MissionState,
  MissionStatus,
  PositionConfidence,
  RoverState,
} from '@roboflow/contracts';
import type { Doc } from '../store/types.js';

/** Robô = dispositivo (mesmo ID). Persistido em `robots/{id}`. */
export interface RobotDoc extends Doc {
  name: string;
  area?: string;
  model?: string;
  mapId: string;
  mapVersion: number;
  firmwareVersion?: string;
  protocolVersion?: number;
  /** "x,y" do último cruzamento confirmado/declarado. */
  currentPoint: string | null;
  heading: Heading | null;
  positionConfidence: PositionConfidence;
  maintenance?: boolean;
  batteryPercent: number | null;
  createdAt: string;
  // ---- sessão do dispositivo ----
  sessionId: string | null;
  capabilities: Capabilities | null;
  deviceState: DeviceState | null;
  lastSeenAt: string | null;
  lastHelloTs: number;
  /** Última X-Sequence (de requisição) aceita na sessão atual. */
  lastRequestSeq: number;
  /** Maior sequência de evento processada na sessão atual. */
  ackedSeq: number;
  // ---- reserva e comandos ----
  activeMissionId: string | null;
  currentRouteId: string | null;
  pendingCommandIds: string[];
  /** Última telemetria (sobrescrita com taxa limitada). */
  live: LiveTelemetry | null;
}

export interface LiveTelemetry {
  at: string;
  state: DeviceState;
  missionId?: string;
  actionIndex?: number | null;
  phase?: string;
  line: [0 | 1, 0 | 1, 0 | 1];
  distanceCm: number | null;
  distanceValid: boolean;
  distanceAgeMs: number | null;
  blockId: string | null;
  blockReasons: string[];
}

export interface BlockInfo {
  blockId: string;
  reasons: string[];
  startedAt: string;
  actionIndex: number | null;
  cleared: boolean;
}

export interface MissionFault {
  eventId: string;
  code: string;
  message: string;
  severity: EventSeverity;
}

export interface MissionDoc extends Doc {
  robotId: string;
  routeId: string;
  routeRevision: number;
  origin: string;
  destination: string;
  /** Estado interno detalhado. */
  state: MissionState;
  /** Projeção pública (consultável). */
  status: MissionStatus;
  /** Ocupa o dispositivo (inclui `uncertain`). */
  active: boolean;
  /** Rollup já aplicado (idempotência da agregação). */
  rolledUp: boolean;
  mapId: string;
  mapVersion: number;
  waypoints: { x: number; y: number }[];
  actions: Command[];
  expectedNodes: string[];
  initialHeading: Heading;
  /** Rumo ao concluir cada ação. */
  headingsAfter: Heading[];
  startNode: string;
  totalActions: number;
  completedActions: number;
  lastConfirmedNode: string;
  headingAtLastConfirmedNode: Heading;
  positionConfidence: PositionConfidence;
  startedAt: string;
  motionStartedAt?: string;
  endedAt?: string;
  durationSeconds: number | null;
  closedWithoutConfirmation?: boolean;
  stopCount: number;
  presenceStopCount: number;
  otherStopCount: number;
  unknownStopCount: number;
  errorCount: number;
  eventCount: number;
  eventSeq: number;
  stopReasons: { reason: string; count: number }[];
  currentBlock: BlockInfo | null;
  faults: MissionFault[];
  cancelIntent?: 'stop' | 'abort';
  sessionId: string | null;
  operatorUid: string;
  updatedAt: string;
}

export interface CommandDoc extends Doc {
  type: DeviceCommandType;
  missionId: string;
  robotId: string;
  /** Sessão para a qual o comando foi ENTREGUE (nula até a entrega). */
  sessionId: string | null;
  status: DeviceCommandStatus;
  reason?: string;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  deliveredAt?: string;
  resolvedAt?: string;
  operatorUid?: string;
  blockId?: string;
  routeRevision: number;
  /** TTL do Firestore (7 dias depois de criado). */
  expireAt?: Date;
}

export interface EventDoc extends Doc {
  missionId: string | null;
  robotId: string;
  timestamp: string;
  eventType: EventType;
  command?: string;
  roverState?: RoverState;
  severity: EventSeverity;
  message: string;
  payload?: Record<string, unknown>;
  raw?: string;
  source: 'device' | 'system' | 'import';
  /** Timestamp para a política de TTL do Firestore. */
  expireAt?: Date;
  sessionId?: string;
  sequence?: number;
  uptimeMs?: number;
}

export interface AlertDoc extends Doc {
  title: string;
  description: string;
  severity: EventSeverity;
  timestamp: string;
  missionId?: string;
  robotId?: string;
  occurrenceCount: number;
  acknowledged: boolean;
  acknowledgedAt?: string;
  relatedEventIds: string[];
}

export interface RouteDoc extends Doc {
  robotId: string;
  missionId: string;
  waypoints: { x: number; y: number }[];
  actions: Command[];
  initialHeading: Heading;
  mapId: string;
  mapVersion: number;
  createdAt: string;
}

export interface MapDoc extends Doc {
  mapId: string;
  version: number;
  cols: number;
  rows: number;
  points?: { x: number; y: number; label?: string; kind?: 'free' | 'station' | 'blocked' }[];
  closedEdges?: ClosedEdge[];
  name?: string;
}

export interface RollupDoc extends Doc {
  /** `day`: um dia UTC (`day` = YYYY-MM-DD); `all`: acumulado do robô desde sempre. */
  scope: 'day' | 'all';
  day: string;
  robotId: string;
  total: number;
  completed: number;
  failed: number;
  aborted: number;
  /** Durações (s) das missões concluídas com duração conhecida. */
  durations: number[];
  stops: number;
  presenceStops: number;
  otherStops: number;
  unknownStops: number;
  errors: number;
}

export interface IdempotencyDoc extends Doc {
  requestHash: string;
  status: number;
  body: unknown;
  createdAt: string;
  expireAt: Date;
}

