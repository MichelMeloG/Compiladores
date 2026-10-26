/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Backend de DEMONSTRAÇÃO — usado exclusivamente na publicação estática
 * (GitHub Pages), onde não há servidor para responder às requisições.
 *
 * COMO FUNCIONA
 * Este módulo intercepta `window.fetch` e responde às rotas do contrato
 * (ver BACKEND_INTEGRATION.md) com um conjunto fixo de registros.
 *
 * POR QUE ASSIM
 * Os serviços em `src/services/` permanecem clientes HTTP puros, sem
 * nenhuma ramificação "mock vs. api": do ponto de vista da aplicação, as
 * respostas vêm da rede normalmente. Nada deste arquivo entra no build
 * normal — ele só é importado quando `VITE_DEMO === 'true'`, e o Vite
 * remove a importação dinâmica nos demais builds.
 *
 * NÃO use este arquivo como fonte de dados da aplicação, e não importe
 * nada daqui fora do bootstrap de demonstração em `main.tsx`.
 *
 * Os dados abaixo são fictícios e seguem o domínio do RoboFlow: uma
 * frota de AGVs percorre estações (`carga`, `descarga`, `triagem`)
 * executando os comandos da DSL — `stop()`, `signal_light()`,
 * `wait_signal()`, `resume_line_following()` — e reporta telemetria de
 * proximidade (PROX).
 *
 * Os números agregados (`/fleet/metrics`, `/dashboard/metrics`) são
 * CALCULADOS a partir das missões e eventos abaixo, e não escritos à
 * mão: assim o recorte por robô continua coerente com o que as tabelas
 * mostram, que é justamente o que esta tela precisa demonstrar.
 */

interface DemoEvent {
  id: string;
  missionId: string;
  robotId: string;
  timestamp: string;
  eventType: string;
  command?: string;
  roverState?: string;
  severity: string;
  message: string;
}

interface DemoMission {
  id: string;
  robotId: string;
  origin: string;
  destination: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number | null;
  stopCount: number;
  presenceStopCount: number;
  errorCount: number;
  eventCount: number;
  stopReasons: Array<{ reason: string; count: number }>;
}

/** Datas relativas a hoje, para o painel não parecer congelado no tempo. */
const day = (daysAgo: number, time: string): string => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  const [h, m, s] = time.split(':').map(Number);
  d.setHours(h, m, s ?? 0, 0);
  return d.toISOString();
};

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

// ---------------------------------------------------------------------------
// Frota
// ---------------------------------------------------------------------------

const ROBOTS = [
  {
    id: 'RB-01',
    name: 'Carregador Norte',
    area: 'Linha de montagem A',
    model: 'RoboFlow AGV v2',
    status: 'busy',
    roverState: 'moving',
    currentMissionId: 'RF-0112',
    batteryPercent: 78,
    currentPoint: '2,1',
    firmwareVersion: '1.4.2',
    lastSeenAt: minutesAgo(1),
    activeAlertsCount: 0,
  },
  {
    id: 'RB-02',
    name: 'Esteira Leste',
    area: 'Expedição',
    model: 'RoboFlow AGV v2',
    status: 'online',
    roverState: 'idle',
    batteryPercent: 94,
    currentPoint: '4,0',
    firmwareVersion: '1.4.2',
    lastSeenAt: minutesAgo(2),
    activeAlertsCount: 1,
  },
  {
    id: 'RB-03',
    name: 'Triagem Sul',
    area: 'Triagem',
    model: 'RoboFlow AGV v1',
    status: 'error',
    roverState: 'error',
    batteryPercent: 41,
    currentPoint: '1,3',
    firmwareVersion: '1.3.8',
    lastSeenAt: minutesAgo(12),
    activeAlertsCount: 2,
  },
  {
    id: 'RB-04',
    name: 'Expedição Oeste',
    area: 'Doca 3',
    model: 'RoboFlow AGV v1',
    status: 'offline',
    roverState: 'unknown',
    batteryPercent: null,
    currentPoint: null,
    firmwareVersion: '1.3.8',
    lastSeenAt: minutesAgo(214),
    activeAlertsCount: 0,
  },
];

// ---------------------------------------------------------------------------
// Malhas de navegação
// ---------------------------------------------------------------------------

/**
 * Cada robô opera numa malha de 5 × 4 vértices. As estações recebem
 * rótulo, e um vértice bloqueado por robô demonstra o desvio automático
 * do planejador de rota.
 */
const GRIDS: Record<string, unknown> = {
  'RB-01': {
    cols: 5,
    rows: 4,
    points: [
      { x: 0, y: 0, kind: 'station', label: 'carga' },
      { x: 4, y: 0, kind: 'station', label: 'descarga' },
      { x: 0, y: 3, kind: 'station', label: 'triagem' },
      { x: 2, y: 2, kind: 'blocked' },
    ],
  },
  'RB-02': {
    cols: 5,
    rows: 4,
    points: [
      { x: 4, y: 0, kind: 'station', label: 'doca 1' },
      { x: 4, y: 3, kind: 'station', label: 'doca 2' },
      { x: 0, y: 1, kind: 'station', label: 'estoque' },
      { x: 1, y: 2, kind: 'blocked' },
      { x: 3, y: 2, kind: 'blocked' },
    ],
  },
  'RB-03': {
    cols: 5,
    rows: 4,
    points: [
      { x: 0, y: 3, kind: 'station', label: 'triagem' },
      { x: 2, y: 0, kind: 'station', label: 'inspeção' },
      { x: 4, y: 2, kind: 'station', label: 'rejeito' },
    ],
  },
  'RB-04': {
    cols: 4,
    rows: 4,
    points: [
      { x: 0, y: 0, kind: 'station', label: 'doca 3' },
      { x: 3, y: 3, kind: 'station', label: 'pátio' },
      { x: 1, y: 1, kind: 'blocked' },
    ],
  },
};

/** Rotas já carregadas nos robôs, exibidas ao abrir a tela de rota. */
const ROUTES: Record<
  string,
  {
    routeId: string;
    robotId: string;
    waypoints: Array<{ x: number; y: number }>;
    createdAt: string;
    status: string;
    currentWaypointIndex: number | null;
  }
> = {
  'RB-01': {
    routeId: 'RT-0041',
    robotId: 'RB-01',
    waypoints: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 1 },
      { x: 3, y: 1 },
      { x: 4, y: 1 },
      { x: 4, y: 0 },
    ],
    createdAt: minutesAgo(26),
    status: 'running',
    currentWaypointIndex: 3,
  },
};

// ---------------------------------------------------------------------------
// Telemetria
// ---------------------------------------------------------------------------

const EVENTS: DemoEvent[] = [
  // RB-01 / RF-0112 — em andamento agora
  { id: 'evt-11201', missionId: 'RF-0112', robotId: 'RB-01', timestamp: minutesAgo(26), eventType: 'mission_start', command: 'station "carga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação carga, destino descarga.' },
  { id: 'evt-11202', missionId: 'RF-0112', robotId: 'RB-01', timestamp: minutesAgo(25), eventType: 'command', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Seguimento de linha retomado após carregamento.' },
  { id: 'evt-11203', missionId: 'RF-0112', robotId: 'RB-01', timestamp: minutesAgo(8), eventType: 'state_change', roverState: 'navigating', severity: 'info', message: 'Ponto (2, 1) alcançado. Seguindo para (3, 1).' },

  // RB-01 / RF-0111 — percurso completo carga -> descarga
  { id: 'evt-11101', missionId: 'RF-0111', robotId: 'RB-01', timestamp: day(0, '08:15:00'), eventType: 'mission_start', command: 'station "carga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação carga, destino descarga.' },
  { id: 'evt-11102', missionId: 'RF-0111', robotId: 'RB-01', timestamp: day(0, '08:15:04'), eventType: 'command', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Seguimento de linha retomado após carregamento.' },
  { id: 'evt-11103', missionId: 'RF-0111', robotId: 'RB-01', timestamp: day(0, '08:15:41'), eventType: 'presence_detected', roverState: 'obstacle_hold', severity: 'warning', message: 'PROX 42cm — obstáculo detectado à frente.' },
  { id: 'evt-11104', missionId: 'RF-0111', robotId: 'RB-01', timestamp: day(0, '08:15:42'), eventType: 'stop_preventive', command: 'stop()', roverState: 'stopped', severity: 'warning', message: 'Parada preventiva executada. Aguardando via livre.' },
  { id: 'evt-11105', missionId: 'RF-0111', robotId: 'RB-01', timestamp: day(0, '08:16:03'), eventType: 'resume', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Via liberada, seguimento de linha retomado.' },
  { id: 'evt-11106', missionId: 'RF-0111', robotId: 'RB-01', timestamp: day(0, '08:16:48'), eventType: 'destination_reached', command: 'station "descarga"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na estação descarga.' },
  { id: 'evt-11107', missionId: 'RF-0111', robotId: 'RB-01', timestamp: day(0, '08:16:49'), eventType: 'mission_end', command: 'wait_signal("descarga_completa")', roverState: 'idle', severity: 'info', message: 'Rota concluída. Aguardando sinal de descarga.' },

  // RB-01 / RF-0108 — retorno sem paradas
  { id: 'evt-10801', missionId: 'RF-0108', robotId: 'RB-01', timestamp: day(1, '07:40:00'), eventType: 'mission_start', command: 'station "descarga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação descarga, destino carga.' },
  { id: 'evt-10802', missionId: 'RF-0108', robotId: 'RB-01', timestamp: day(1, '07:41:12'), eventType: 'destination_reached', command: 'station "carga"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na estação carga.' },
  { id: 'evt-10803', missionId: 'RF-0108', robotId: 'RB-01', timestamp: day(1, '07:41:13'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída sem interrupções.' },

  // RB-02 / RF-0110 — parada por presença, concluída
  { id: 'evt-11001', missionId: 'RF-0110', robotId: 'RB-02', timestamp: day(0, '11:05:00'), eventType: 'mission_start', command: 'station "estoque"', roverState: 'idle', severity: 'info', message: 'Rota iniciada no estoque, destino doca 1.' },
  { id: 'evt-11002', missionId: 'RF-0110', robotId: 'RB-02', timestamp: day(0, '11:05:33'), eventType: 'presence_detected', roverState: 'obstacle_hold', severity: 'warning', message: 'PROX 25cm — operador no corredor.' },
  { id: 'evt-11003', missionId: 'RF-0110', robotId: 'RB-02', timestamp: day(0, '11:05:34'), eventType: 'stop_preventive', command: 'stop()', roverState: 'stopped', severity: 'warning', message: 'Parada preventiva por detecção de presença.' },
  { id: 'evt-11004', missionId: 'RF-0110', robotId: 'RB-02', timestamp: day(0, '11:06:10'), eventType: 'resume', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Corredor liberado, retomando trajeto.' },
  { id: 'evt-11005', missionId: 'RF-0110', robotId: 'RB-02', timestamp: day(0, '11:07:02'), eventType: 'destination_reached', command: 'station "doca 1"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na doca 1.' },
  { id: 'evt-11006', missionId: 'RF-0110', robotId: 'RB-02', timestamp: day(0, '11:07:03'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída com 1 parada preventiva.' },

  // RB-02 / RF-0107 — desvio de trajetória, concluída
  { id: 'evt-10701', missionId: 'RF-0107', robotId: 'RB-02', timestamp: day(1, '14:12:00'), eventType: 'mission_start', command: 'station "doca 1"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na doca 1, destino doca 2.' },
  { id: 'evt-10702', missionId: 'RF-0107', robotId: 'RB-02', timestamp: day(1, '14:12:55'), eventType: 'warning', roverState: 'navigating', severity: 'warning', message: 'Erro de trajetória acima do limite: desvio lateral de 54px.' },
  { id: 'evt-10703', missionId: 'RF-0107', robotId: 'RB-02', timestamp: day(1, '14:13:20'), eventType: 'resume', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Trajetória corrigida pelo PID, retomando.' },
  { id: 'evt-10704', missionId: 'RF-0107', robotId: 'RB-02', timestamp: day(1, '14:14:38'), eventType: 'destination_reached', command: 'station "doca 2"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na doca 2.' },
  { id: 'evt-10705', missionId: 'RF-0107', robotId: 'RB-02', timestamp: day(1, '14:14:39'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída.' },

  // RB-02 / RF-0104 — concluída, rápida
  { id: 'evt-10401', missionId: 'RF-0104', robotId: 'RB-02', timestamp: day(3, '09:02:00'), eventType: 'mission_start', command: 'station "doca 2"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na doca 2, destino estoque.' },
  { id: 'evt-10402', missionId: 'RF-0104', robotId: 'RB-02', timestamp: day(3, '09:03:08'), eventType: 'destination_reached', command: 'station "estoque"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada no estoque.' },
  { id: 'evt-10403', missionId: 'RF-0104', robotId: 'RB-02', timestamp: day(3, '09:03:09'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída sem interrupções.' },

  // RB-03 / RF-0109 — perda de linha, rota abortada
  { id: 'evt-10901', missionId: 'RF-0109', robotId: 'RB-03', timestamp: day(0, '16:22:00'), eventType: 'mission_start', command: 'station "triagem"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na triagem, destino inspeção.' },
  { id: 'evt-10902', missionId: 'RF-0109', robotId: 'RB-03', timestamp: day(0, '16:22:38'), eventType: 'warning', roverState: 'navigating', severity: 'warning', message: 'Erro de trajetória acima do limite: desvio lateral de 68px.' },
  { id: 'evt-10903', missionId: 'RF-0109', robotId: 'RB-03', timestamp: day(0, '16:22:51'), eventType: 'error', command: 'stop()', roverState: 'error', severity: 'error', message: 'Linha perdida: transição FOLLOWING -> LOST_TRACK. Rota interrompida.' },

  // RB-03 / RF-0106 — falha de comunicação
  { id: 'evt-10601', missionId: 'RF-0106', robotId: 'RB-03', timestamp: day(2, '09:30:00'), eventType: 'mission_start', command: 'station "inspeção"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na inspeção, destino rejeito.' },
  { id: 'evt-10602', missionId: 'RF-0106', robotId: 'RB-03', timestamp: day(2, '09:30:47'), eventType: 'error', roverState: 'error', severity: 'critical', message: 'Timeout na leitura serial do ESP32 após 3 tentativas.' },

  // RB-03 / RF-0103 — concluída
  { id: 'evt-10301', missionId: 'RF-0103', robotId: 'RB-03', timestamp: day(4, '10:18:00'), eventType: 'mission_start', command: 'station "triagem"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na triagem, destino rejeito.' },
  { id: 'evt-10302', missionId: 'RF-0103', robotId: 'RB-03', timestamp: day(4, '10:19:44'), eventType: 'destination_reached', command: 'station "rejeito"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada no rejeito.' },
  { id: 'evt-10303', missionId: 'RF-0103', robotId: 'RB-03', timestamp: day(4, '10:19:45'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída.' },

  // RB-04 / RF-0102 — último percurso antes de sair do ar
  { id: 'evt-10201', missionId: 'RF-0102', robotId: 'RB-04', timestamp: day(0, '05:40:00'), eventType: 'mission_start', command: 'station "doca 3"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na doca 3, destino pátio.' },
  { id: 'evt-10202', missionId: 'RF-0102', robotId: 'RB-04', timestamp: day(0, '05:41:36'), eventType: 'destination_reached', command: 'station "pátio"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada no pátio.' },
  { id: 'evt-10203', missionId: 'RF-0102', robotId: 'RB-04', timestamp: day(0, '05:41:37'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída. Robô recolhido para manutenção preventiva.' },
];

const MISSIONS: DemoMission[] = [
  { id: 'RF-0112', robotId: 'RB-01', origin: 'carga', destination: 'descarga', status: 'in_progress', startedAt: minutesAgo(26), durationSeconds: null, stopCount: 0, presenceStopCount: 0, errorCount: 0, eventCount: 3, stopReasons: [] },
  { id: 'RF-0111', robotId: 'RB-01', origin: 'carga', destination: 'descarga', status: 'completed', startedAt: day(0, '08:15:00'), endedAt: day(0, '08:16:49'), durationSeconds: 109, stopCount: 1, presenceStopCount: 1, errorCount: 0, eventCount: 7, stopReasons: [{ reason: 'Presença detectada', count: 1 }] },
  { id: 'RF-0110', robotId: 'RB-02', origin: 'estoque', destination: 'doca 1', status: 'completed', startedAt: day(0, '11:05:00'), endedAt: day(0, '11:07:03'), durationSeconds: 123, stopCount: 1, presenceStopCount: 1, errorCount: 0, eventCount: 6, stopReasons: [{ reason: 'Presença detectada', count: 1 }] },
  { id: 'RF-0109', robotId: 'RB-03', origin: 'triagem', destination: 'inspeção', status: 'aborted', startedAt: day(0, '16:22:00'), endedAt: day(0, '16:22:51'), durationSeconds: 51, stopCount: 1, presenceStopCount: 0, errorCount: 1, eventCount: 3, stopReasons: [{ reason: 'Linha perdida', count: 1 }] },
  { id: 'RF-0108', robotId: 'RB-01', origin: 'descarga', destination: 'carga', status: 'completed', startedAt: day(1, '07:40:00'), endedAt: day(1, '07:41:13'), durationSeconds: 73, stopCount: 0, presenceStopCount: 0, errorCount: 0, eventCount: 3, stopReasons: [] },
  { id: 'RF-0107', robotId: 'RB-02', origin: 'doca 1', destination: 'doca 2', status: 'completed', startedAt: day(1, '14:12:00'), endedAt: day(1, '14:14:39'), durationSeconds: 159, stopCount: 1, presenceStopCount: 0, errorCount: 0, eventCount: 5, stopReasons: [{ reason: 'Desvio de trajetória', count: 1 }] },
  { id: 'RF-0106', robotId: 'RB-03', origin: 'inspeção', destination: 'rejeito', status: 'failed', startedAt: day(2, '09:30:00'), durationSeconds: null, stopCount: 0, presenceStopCount: 0, errorCount: 1, eventCount: 2, stopReasons: [] },
  { id: 'RF-0104', robotId: 'RB-02', origin: 'doca 2', destination: 'estoque', status: 'completed', startedAt: day(3, '09:02:00'), endedAt: day(3, '09:03:09'), durationSeconds: 69, stopCount: 0, presenceStopCount: 0, errorCount: 0, eventCount: 3, stopReasons: [] },
  { id: 'RF-0103', robotId: 'RB-03', origin: 'triagem', destination: 'rejeito', status: 'completed', startedAt: day(4, '10:18:00'), endedAt: day(4, '10:19:45'), durationSeconds: 105, stopCount: 0, presenceStopCount: 0, errorCount: 0, eventCount: 3, stopReasons: [] },
  { id: 'RF-0102', robotId: 'RB-04', origin: 'doca 3', destination: 'pátio', status: 'completed', startedAt: day(0, '05:40:00'), endedAt: day(0, '05:41:37'), durationSeconds: 97, stopCount: 0, presenceStopCount: 0, errorCount: 0, eventCount: 3, stopReasons: [] },
];

const ALERTS = [
  { id: 'alt-01', title: 'Linha perdida durante o trajeto', description: 'Transição FOLLOWING -> LOST_TRACK na rota RF-0109, entre triagem e inspeção.', severity: 'error', timestamp: day(0, '16:22:51'), missionId: 'RF-0109', robotId: 'RB-03', occurrenceCount: 1, acknowledged: false, relatedEventIds: ['evt-10903'] },
  { id: 'alt-02', title: 'Falha de comunicação com o ESP32', description: 'Timeout na leitura serial após 3 tentativas durante a rota RF-0106.', severity: 'critical', timestamp: day(2, '09:30:47'), missionId: 'RF-0106', robotId: 'RB-03', occurrenceCount: 1, acknowledged: false, relatedEventIds: ['evt-10602'] },
  { id: 'alt-03', title: 'Desvio de trajetória recorrente', description: 'Erro lateral acima do limite em 2 das últimas 3 rotas da doca 1.', severity: 'warning', timestamp: day(1, '14:12:55'), missionId: 'RF-0107', robotId: 'RB-02', occurrenceCount: 2, acknowledged: false, relatedEventIds: ['evt-10702'] },
  { id: 'alt-04', title: 'Paradas recorrentes por presença', description: '2 paradas preventivas por detecção de presença nas últimas rotas da frota.', severity: 'warning', timestamp: day(0, '08:15:42'), occurrenceCount: 2, acknowledged: true, acknowledgedAt: day(0, '09:00:00'), relatedEventIds: ['evt-11103', 'evt-11002'] },
];

// ---------------------------------------------------------------------------
// Agregação
// ---------------------------------------------------------------------------

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
};

/**
 * Calcula os KPIs de um conjunto de missões, do mesmo modo que o backend
 * real deve fazer — ver BACKEND_INTEGRATION.md §3.2.
 */
function aggregate(missions: DemoMission[], events: DemoEvent[], alerts: typeof ALERTS) {
  const by = (status: string) => missions.filter((m) => m.status === status).length;

  const durations = missions
    .filter((m) => m.status === 'completed' && m.durationSeconds !== null)
    .map((m) => m.durationSeconds as number);

  const totalStops = missions.reduce((sum, m) => sum + m.stopCount, 0);
  const presenceStops = missions.reduce((sum, m) => sum + m.presenceStopCount, 0);
  const otherStops = missions.reduce(
    (sum, m) =>
      sum +
      m.stopReasons
        .filter((reason) => reason.reason !== 'Presença detectada')
        .reduce((inner, reason) => inner + reason.count, 0),
    0
  );

  const completed = by('completed');

  return {
    totalMissions: missions.length,
    completedMissions: completed,
    inProgressMissions: by('in_progress'),
    failedMissions: by('failed'),
    abortedMissions: by('aborted'),
    indeterminateMissions: by('indeterminate'),
    avgDurationSeconds: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    medianDurationSeconds: median(durations),
    minDurationSeconds: durations.length ? Math.min(...durations) : null,
    maxDurationSeconds: durations.length ? Math.max(...durations) : null,
    totalStops,
    presenceStops,
    otherStops,
    unknownStops: Math.max(totalStops - presenceStops - otherStops, 0),
    completionRate: missions.length
      ? Math.round((completed / missions.length) * 1000) / 10
      : 0,
    activeAlertsCount: alerts.filter((a) => !a.acknowledged).length,
    totalErrors: events.filter(
      (e) => e.severity === 'error' || e.severity === 'critical'
    ).length,
  };
}

function metricsFor(robotId: string | null) {
  const missions = robotId ? MISSIONS.filter((m) => m.robotId === robotId) : MISSIONS;
  const events = robotId ? EVENTS.filter((e) => e.robotId === robotId) : EVENTS;
  const alerts = robotId ? ALERTS.filter((a) => a.robotId === robotId) : ALERTS;
  return aggregate(missions, events, alerts);
}

function fleetMetrics() {
  const base = aggregate(MISSIONS, EVENTS, ALERTS);

  return {
    ...base,
    totalRobots: ROBOTS.length,
    onlineRobots: ROBOTS.filter(
      (r) => r.status === 'online' || r.status === 'busy' || r.status === 'idle'
    ).length,
    offlineRobots: ROBOTS.filter((r) => r.status === 'offline').length,
    errorRobots: ROBOTS.filter((r) => r.status === 'error').length,
    perRobot: ROBOTS.map((robot) => {
      const scoped = metricsFor(robot.id);
      return {
        robotId: robot.id,
        robotName: robot.name,
        totalMissions: scoped.totalMissions,
        completedMissions: scoped.completedMissions,
        totalStops: scoped.totalStops,
        totalErrors: scoped.totalErrors,
        completionRate: scoped.completionRate,
        avgDurationSeconds: scoped.avgDurationSeconds,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Roteamento HTTP
// ---------------------------------------------------------------------------

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ok = (data: unknown): Response => json({ success: true, data });

/** Sequência para os ids de rota criados durante a sessão de demonstração. */
let nextRouteId = 42;

async function route(
  path: string,
  method: string,
  search: URLSearchParams,
  body: string | null
): Promise<Response> {
  const robotId = search.get('robotId');

  if (path === 'health') {
    return ok({ status: 'ok', version: '2.0.0-demo', robotsConnected: ROBOTS.length });
  }

  if (path === 'robots') return ok(ROBOTS);

  if (path === 'fleet/metrics') return ok(fleetMetrics());

  if (path === 'dashboard/metrics') return ok(metricsFor(robotId));

  // ----- rotas aninhadas em /robots/:id -----
  const robotMatch = path.match(/^robots\/([^/]+)(?:\/(grid|route|metrics))?$/);
  if (robotMatch) {
    const id = decodeURIComponent(robotMatch[1]);
    const sub = robotMatch[2];
    const robot = ROBOTS.find((r) => r.id === id);

    if (!robot) {
      return json({ success: false, message: `Robô ${id} não encontrado.` }, 404);
    }

    if (!sub) return ok(robot);

    if (sub === 'metrics') return ok(metricsFor(id));

    if (sub === 'grid') {
      return ok(GRIDS[id] ?? { cols: 4, rows: 4, points: [] });
    }

    if (sub === 'route') {
      if (method === 'GET') {
        const existing = ROUTES[id];
        if (!existing) {
          return json(
            { success: false, message: 'Este robô não tem rota definida.' },
            404
          );
        }
        return ok(existing);
      }

      if (method === 'POST') {
        let waypoints: Array<{ x: number; y: number }> = [];
        try {
          waypoints = JSON.parse(body ?? '{}').waypoints ?? [];
        } catch {
          return json({ success: false, message: 'Corpo inválido.' }, 400);
        }

        if (waypoints.length < 2) {
          return json(
            {
              success: false,
              message: 'A rota precisa de pelo menos dois pontos.',
            },
            422
          );
        }

        // Um robô offline não recebe rota: é a recusa que o backend real
        // devolveria, e a tela precisa saber mostrá-la.
        if (robot.status === 'offline') {
          return ok({
            routeId: '',
            accepted: false,
            waypointCount: waypoints.length,
            message: `${robot.name} está offline e não pode receber uma rota agora.`,
          });
        }

        const routeId = `RT-${String(nextRouteId++).padStart(4, '0')}`;
        ROUTES[id] = {
          routeId,
          robotId: id,
          waypoints,
          createdAt: new Date().toISOString(),
          status: 'queued',
          currentWaypointIndex: null,
        };

        return ok({
          routeId,
          accepted: true,
          waypointCount: waypoints.length,
          message: 'Rota aceita e enfileirada no robô.',
        });
      }
    }
  }

  if (path === 'missions') {
    const list = robotId ? MISSIONS.filter((m) => m.robotId === robotId) : MISSIONS;
    return ok(list);
  }

  if (path.startsWith('missions/')) {
    const id = decodeURIComponent(path.slice('missions/'.length));
    const mission = MISSIONS.find((m) => m.id === id);
    if (!mission) return json({ success: false, message: 'Rota não encontrada' }, 404);
    return ok({ ...mission, events: EVENTS.filter((e) => e.missionId === id) });
  }

  if (path === 'logs') {
    const list = robotId ? EVENTS.filter((e) => e.robotId === robotId) : EVENTS;
    const sorted = [...list].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );
    return ok(sorted);
  }

  if (path === 'logs/import' && method === 'POST') {
    return json(
      {
        success: false,
        message:
          'Importação indisponível na demonstração: não há backend para persistir os registros.',
      },
      501
    );
  }

  if (path === 'alerts') {
    const status = search.get('status');
    let list = robotId ? ALERTS.filter((a) => a.robotId === robotId) : ALERTS;
    if (status === 'unacknowledged') list = list.filter((a) => !a.acknowledged);
    if (status === 'acknowledged') list = list.filter((a) => a.acknowledged);
    return ok(list);
  }

  if (/^alerts\/.+\/acknowledge$/.test(path) && method === 'PATCH') {
    const id = decodeURIComponent(path.split('/')[1]);
    const alert = ALERTS.find((a) => a.id === id);
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date().toISOString();
    }
    return ok({ id, acknowledged: true, acknowledgedAt: new Date().toISOString() });
  }

  return json({ success: false, message: `Rota não prevista na demonstração: ${path}` }, 404);
}

/**
 * Instala o interceptador. Chamado apenas pelo bootstrap de demonstração.
 */
export function installDemoBackend(apiBaseUrl: string): void {
  const base = apiBaseUrl.replace(/\/$/, '');
  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.href
        : input.url;

    if (!url.startsWith(base)) {
      return originalFetch(input, init);
    }

    const parsed = new URL(url, window.location.origin);
    const path = parsed.pathname
      .replace(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '')
      .replace(/^\//, '');

    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;

    // Pequena latência, para os estados de carregamento ficarem visíveis.
    await new Promise((resolve) => setTimeout(resolve, 180));

    return route(path, method, parsed.searchParams, body);
  };
}
