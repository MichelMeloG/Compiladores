/**
 * Registro de endpoints: a FONTE ÚNICA do contrato HTTP.
 *
 * É consumido por três coisas: o runner de contrato (`npm run contract:test`),
 * o gerador de OpenAPI e o backend (para registrar rotas e validar entrada).
 * Caminhos usam `:param` no estilo Express.
 *
 * Prefixos:  /api/*      operador autenticado (ID token do Firebase)
 *            /device/*   dispositivo (HMAC)
 *            /internal/* Pub/Sub e Scheduler (OIDC)
 */
import { z } from 'zod';
import type { ErrorCode } from './common.js';
import {
  AckResultSchema,
  AlertSchema,
  AlertsQuerySchema,
  DashboardMetricsSchema,
  FleetMetricsQuerySchema,
  FleetMetricsSchema,
  HealthSchema,
  ImportRequestSchema,
  ImportResultSchema,
  LogEventSchema,
  LogsQuerySchema,
  MetricsQuerySchema,
  MissionSchema,
  MissionsQuerySchema,
  RobotEventSchema,
  RobotEventsQuerySchema,
  RobotSchema,
} from './dashboard.js';
import {
  DeviceEventsRequestSchema,
  DeviceEventsResponseSchema,
  DeviceHelloRequestSchema,
  DeviceHelloResponseSchema,
  DeviceSyncResponseSchema,
  PubSubPushBodySchema,
} from './device.js';
import { RobotGridSchema } from './map.js';
import {
  ActiveRouteSchema,
  ControlAcceptedSchema,
  ControlRequestSchema,
  DeviceCommandSchema,
  DeviceStatusSchema,
  ExecutionStateSchema,
  ForceCloseResultSchema,
  PositionRequestSchema,
  PositionResultSchema,
  ResumeRequestSchema,
  RoutePreviewRequestSchema,
  RoutePreviewSchema,
  RouteSubmitRequestSchema,
  RouteSubmitResultSchema,
} from './mission.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH';
export type AuthKind = 'public' | 'operator' | 'device' | 'internal';
export type Role = 'admin' | 'operator' | 'viewer';

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';

export interface Endpoint {
  id: string;
  method: HttpMethod;
  path: string;
  auth: AuthKind;
  /** Papéis que podem chamar (`operator` auth). `admin` sempre pode. */
  roles?: readonly Role[];
  summary: string;
  query?: z.ZodType;
  body?: z.ZodType;
  /** Schema de `data` no envelope `{success:true,data}`. */
  response: z.ZodType;
  /** Status de sucesso esperados; o primeiro é o canônico. */
  okStatus: readonly number[];
  /** `required`: ausência => 400 IDEMPOTENCY_KEY_REQUIRED. */
  idempotency?: 'required' | 'recommended';
  /** Erros de negócio que o endpoint pode devolver, além dos transversais. */
  errors: readonly ErrorCode[];
  /** A resposta de dados é uma lista paginável (`limit`/`cursor`). */
  list?: boolean;
}

const READ: readonly Role[] = ['viewer', 'operator', 'admin'];
const WRITE: readonly Role[] = ['operator', 'admin'];
const ADMIN: readonly Role[] = ['admin'];

export const ENDPOINTS = [
  // ---------------------------------------------------------------- público
  {
    id: 'health',
    method: 'GET',
    path: '/api/health',
    auth: 'public',
    summary: 'Disponibilidade do serviço (diagnóstico; a UI não consome).',
    response: HealthSchema,
    okStatus: [200],
    errors: [],
  },
  // ------------------------------------------------------------ observação
  {
    id: 'listRobots',
    method: 'GET',
    path: '/api/robots',
    auth: 'operator',
    roles: READ,
    summary: 'Robôs conectados (primeira chamada da UI).',
    response: z.array(RobotSchema),
    okStatus: [200],
    errors: [],
  },
  {
    id: 'getRobot',
    method: 'GET',
    path: '/api/robots/:id',
    auth: 'operator',
    roles: READ,
    summary: 'Detalhe de um robô.',
    response: RobotSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  {
    id: 'fleetMetrics',
    method: 'GET',
    path: '/api/fleet/metrics',
    auth: 'operator',
    roles: READ,
    summary: 'KPIs da frota inteira, com `perRobot`.',
    query: FleetMetricsQuerySchema,
    response: FleetMetricsSchema,
    okStatus: [200],
    errors: ['INVALID_QUERY'],
  },
  {
    id: 'dashboardMetrics',
    method: 'GET',
    path: '/api/dashboard/metrics',
    auth: 'operator',
    roles: READ,
    summary: 'KPIs agregados; `robotId` restringe a um robô.',
    query: MetricsQuerySchema,
    response: DashboardMetricsSchema,
    okStatus: [200],
    errors: ['INVALID_QUERY'],
  },
  {
    id: 'listMissions',
    method: 'GET',
    path: '/api/missions',
    auth: 'operator',
    roles: READ,
    summary: 'Missões (sem `events`, para manter a resposta leve).',
    query: MissionsQuerySchema,
    response: z.array(MissionSchema),
    okStatus: [200],
    errors: ['INVALID_QUERY'],
    list: true,
  },
  {
    id: 'getMission',
    method: 'GET',
    path: '/api/missions/:id',
    auth: 'operator',
    roles: READ,
    summary: 'Missão com a linha do tempo (`events`).',
    response: MissionSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  {
    id: 'listLogs',
    method: 'GET',
    path: '/api/logs',
    auth: 'operator',
    roles: READ,
    summary: 'Eventos, do mais recente para o mais antigo.',
    query: LogsQuerySchema,
    response: z.array(LogEventSchema),
    okStatus: [200],
    errors: ['INVALID_QUERY'],
    list: true,
  },
  {
    id: 'importLogs',
    method: 'POST',
    path: '/api/logs/import',
    auth: 'operator',
    roles: WRITE,
    summary: 'Importa eventos históricos. NUNCA gera comando nem altera missão ativa.',
    body: ImportRequestSchema,
    response: ImportResultSchema,
    okStatus: [200, 201],
    errors: ['INVALID_BODY', 'PAYLOAD_TOO_LARGE'],
  },
  {
    id: 'listAlerts',
    method: 'GET',
    path: '/api/alerts',
    auth: 'operator',
    roles: READ,
    summary: 'Alertas.',
    query: AlertsQuerySchema,
    response: z.array(AlertSchema),
    okStatus: [200],
    errors: ['INVALID_QUERY'],
    list: true,
  },
  {
    id: 'acknowledgeAlert',
    method: 'PATCH',
    path: '/api/alerts/:id/acknowledge',
    auth: 'operator',
    roles: WRITE,
    summary: 'Reconhece um alerta (persistido). Nunca autoriza movimento.',
    response: AckResultSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  {
    id: 'getRobotEvents',
    method: 'GET',
    path: '/api/robots/:id/events',
    auth: 'operator',
    roles: READ,
    summary: 'Eventos do dispositivo, inclusive sem missão (diagnóstico).',
    query: RobotEventsQuerySchema,
    response: z.array(RobotEventSchema),
    okStatus: [200],
    errors: ['NOT_FOUND', 'INVALID_QUERY'],
    list: true,
  },
  // ----------------------------------------------------------------- rotas
  {
    id: 'getGrid',
    method: 'GET',
    path: '/api/robots/:id/grid',
    auth: 'operator',
    roles: READ,
    summary: 'Malha de navegação do robô.',
    response: RobotGridSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  {
    id: 'getRoute',
    method: 'GET',
    path: '/api/robots/:id/route',
    auth: 'operator',
    roles: READ,
    summary: 'Rota carregada no robô. 404 = "nenhuma rota" (situação normal).',
    response: ActiveRouteSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  {
    id: 'previewRoute',
    method: 'POST',
    path: '/api/robots/:id/route/preview',
    auth: 'operator',
    roles: WRITE,
    summary: 'Valida e traduz para F/D/E/T sem mover nem reservar o robô.',
    body: RoutePreviewRequestSchema,
    response: RoutePreviewSchema,
    okStatus: [200],
    errors: ['NOT_FOUND', 'INVALID_BODY', 'HEADING_REQUIRED'],
  },
  {
    id: 'submitRoute',
    method: 'POST',
    path: '/api/robots/:id/route',
    auth: 'operator',
    roles: WRITE,
    summary:
      'Revalida, cria a missão e registra o carregamento da fila. NÃO inicia o movimento. Recusa de negócio = 200 com accepted:false.',
    body: RouteSubmitRequestSchema,
    response: RouteSubmitResultSchema,
    okStatus: [200, 201],
    idempotency: 'required',
    errors: ['NOT_FOUND', 'INVALID_BODY', 'IDEMPOTENCY_KEY_REQUIRED', 'CONFLICT_IDEMPOTENCY', 'ROUTE_INVALID', 'HEADING_REQUIRED'],
  },
  // --------------------------------------------------------------- controle
  {
    id: 'startMission',
    method: 'POST',
    path: '/api/missions/:id/start',
    auth: 'operator',
    roles: WRITE,
    summary: 'Solicita início de fila aceita (assíncrono).',
    body: ControlRequestSchema,
    response: ControlAcceptedSchema,
    okStatus: [202],
    idempotency: 'required',
    errors: ['NOT_FOUND', 'CONFLICT_STATE', 'CONFLICT_SESSION', 'CONFLICT_IDEMPOTENCY', 'IDEMPOTENCY_KEY_REQUIRED', 'DEVICE_UNAVAILABLE'],
  },
  {
    id: 'stopMission',
    method: 'POST',
    path: '/api/missions/:id/stop',
    auth: 'operator',
    roles: WRITE,
    summary: 'Solicita parada preservando o progresso (melhor esforço; ADR 0002).',
    body: ControlRequestSchema,
    response: ControlAcceptedSchema,
    okStatus: [202],
    idempotency: 'required',
    errors: ['NOT_FOUND', 'CONFLICT_STATE', 'CONFLICT_SESSION', 'CONFLICT_IDEMPOTENCY', 'IDEMPOTENCY_KEY_REQUIRED'],
  },
  {
    id: 'resumeMission',
    method: 'POST',
    path: '/api/missions/:id/resume',
    auth: 'operator',
    roles: WRITE,
    summary: 'Solicita retomada explícita; exige o `blockId` exibido.',
    body: ResumeRequestSchema,
    response: ControlAcceptedSchema,
    okStatus: [202],
    idempotency: 'required',
    errors: ['NOT_FOUND', 'CONFLICT_STATE', 'CONFLICT_SESSION', 'STALE_BLOCK', 'CONFLICT_IDEMPOTENCY', 'IDEMPOTENCY_KEY_REQUIRED', 'DEVICE_UNAVAILABLE'],
  },
  {
    id: 'abortMission',
    method: 'POST',
    path: '/api/missions/:id/abort',
    auth: 'operator',
    roles: WRITE,
    summary: 'Solicita parada e descarte da fila.',
    body: ControlRequestSchema,
    response: ControlAcceptedSchema,
    okStatus: [202],
    idempotency: 'required',
    errors: ['NOT_FOUND', 'CONFLICT_STATE', 'CONFLICT_SESSION', 'CONFLICT_IDEMPOTENCY', 'IDEMPOTENCY_KEY_REQUIRED'],
  },
  {
    id: 'confirmPosition',
    method: 'POST',
    path: '/api/robots/:id/position',
    auth: 'operator',
    roles: WRITE,
    summary:
      'O operador confirma o cruzamento e o rumo do robô parado. Com missão ativa => 409 DEVICE_BUSY; fora da malha ou bloqueado => 422.',
    body: PositionRequestSchema,
    response: PositionResultSchema,
    okStatus: [200],
    idempotency: 'recommended',
    errors: ['NOT_FOUND', 'INVALID_BODY', 'DEVICE_BUSY', 'ROUTE_INVALID'],
  },
  {
    id: 'forceCloseMission',
    method: 'POST',
    path: '/api/missions/:id/force-close',
    auth: 'operator',
    roles: ADMIN,
    summary:
      'Somente admin: leva missão `uncertain` a `aborted` sem confirmação do dispositivo (sem endedAt, durationSeconds:null). Fora de uncertain => 409.',
    response: ForceCloseResultSchema,
    okStatus: [200],
    idempotency: 'recommended',
    errors: ['NOT_FOUND', 'FORBIDDEN', 'CONFLICT_STATE'],
  },
  {
    id: 'getCommand',
    method: 'GET',
    path: '/api/commands/:id',
    auth: 'operator',
    roles: READ,
    summary: 'Resultado de um comando assíncrono.',
    response: DeviceCommandSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  {
    id: 'getExecution',
    method: 'GET',
    path: '/api/missions/:id/execution',
    auth: 'operator',
    roles: READ,
    summary: 'Estado operacional detalhado da missão.',
    response: ExecutionStateSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  {
    id: 'getDeviceStatus',
    method: 'GET',
    path: '/api/devices/:id/status',
    auth: 'operator',
    roles: READ,
    summary: 'Estado do dispositivo: sessão, conexão, sensores e bloqueios.',
    response: DeviceStatusSchema,
    okStatus: [200],
    errors: ['NOT_FOUND'],
  },
  // ----------------------------------------------------------- dispositivo
  {
    id: 'deviceHello',
    method: 'POST',
    path: '/device/hello',
    auth: 'device',
    summary: 'Abre a sessão do boot: capacidades e estado.',
    body: DeviceHelloRequestSchema,
    response: DeviceHelloResponseSchema,
    okStatus: [200],
    errors: ['INVALID_BODY', 'PAYLOAD_TOO_LARGE'],
  },
  {
    id: 'devicePoll',
    method: 'GET',
    path: '/device/poll',
    auth: 'device',
    summary: 'Busca comandos; a resposta dita `nextPollMs`.',
    response: DeviceSyncResponseSchema,
    okStatus: [200],
    errors: ['CONFLICT_SESSION'],
  },
  {
    id: 'deviceEvents',
    method: 'POST',
    path: '/device/events',
    auth: 'device',
    summary: 'Lote de eventos (até 16); idempotente por device/sessão/sequência.',
    body: DeviceEventsRequestSchema,
    response: DeviceEventsResponseSchema,
    okStatus: [200],
    errors: ['INVALID_BODY', 'PAYLOAD_TOO_LARGE', 'CONFLICT_SESSION'],
  },
  // ---------------------------------------------------------------- interno
  {
    id: 'internalEvents',
    method: 'POST',
    path: '/internal/events',
    auth: 'internal',
    summary: 'Entrega push do Pub/Sub (alertas, rollups). Consumidor idempotente.',
    body: PubSubPushBodySchema,
    response: z.object({ processed: z.boolean() }),
    okStatus: [200],
    errors: ['INVALID_BODY'],
  },
  {
    id: 'internalOfflineCheck',
    method: 'POST',
    path: '/internal/offline-check',
    auth: 'internal',
    summary: 'Chamado pelo Cloud Scheduler: marca dispositivos sem poll como offline.',
    response: z.object({ checked: z.number().int().nonnegative(), markedOffline: z.number().int().nonnegative() }),
    okStatus: [200],
    errors: [],
  },
] as const satisfies readonly Endpoint[];

export type EndpointId = (typeof ENDPOINTS)[number]['id'];

export function getEndpoint(id: EndpointId): Endpoint {
  const found = (ENDPOINTS as readonly Endpoint[]).find((e) => e.id === id);
  if (!found) throw new Error(`Endpoint desconhecido: ${id}`);
  return found;
}

/** Substitui `:param` pelos valores (com `encodeURIComponent`). */
export function buildPath(path: string, params: Record<string, string> = {}): string {
  return path.replace(/:([A-Za-z]+)/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`Parâmetro ausente: ${name}`);
    return encodeURIComponent(value);
  });
}

/** Procura o endpoint que casa com método + caminho concreto. */
export function matchEndpoint(
  method: string,
  pathname: string
): { endpoint: Endpoint; params: Record<string, string> } | null {
  for (const e of ENDPOINTS as readonly Endpoint[]) {
    if (e.method !== method.toUpperCase()) continue;
    const names: string[] = [];
    const re = new RegExp(
      '^' +
        e.path.replace(/:([A-Za-z]+)/g, (_, n: string) => {
          names.push(n);
          return '([^/]+)';
        }) +
        '/?$'
    );
    const m = re.exec(pathname);
    if (m) {
      const params: Record<string, string> = {};
      names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1] as string)));
      return { endpoint: e, params };
    }
  }
  return null;
}
