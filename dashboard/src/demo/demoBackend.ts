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
 * Os dados abaixo são fictícios e seguem o domínio do RoboFlow: o AGV
 * percorre estações (`carga`, `descarga`, `triagem`) executando os
 * comandos da DSL — `stop()`, `signal_light()`, `wait_signal()`,
 * `resume_line_following()` — e reporta telemetria de proximidade (PROX).
 */

interface DemoEvent {
  id: string;
  missionId: string;
  timestamp: string;
  eventType: string;
  command?: string;
  roverState?: string;
  severity: string;
  message: string;
}

interface DemoMission {
  id: string;
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

const EVENTS: DemoEvent[] = [
  // RF-0012 — percurso completo carga -> descarga
  { id: 'evt-1201', missionId: 'RF-0012', timestamp: day(0, '08:15:00'), eventType: 'mission_start', command: 'station "carga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação carga, destino descarga.' },
  { id: 'evt-1202', missionId: 'RF-0012', timestamp: day(0, '08:15:04'), eventType: 'command', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Seguimento de linha retomado após carregamento.' },
  { id: 'evt-1203', missionId: 'RF-0012', timestamp: day(0, '08:15:41'), eventType: 'presence_detected', roverState: 'obstacle_hold', severity: 'warning', message: 'PROX 42cm — obstáculo detectado à frente.' },
  { id: 'evt-1204', missionId: 'RF-0012', timestamp: day(0, '08:15:42'), eventType: 'stop_preventive', command: 'stop()', roverState: 'stopped', severity: 'warning', message: 'Parada preventiva executada. Aguardando via livre.' },
  { id: 'evt-1205', missionId: 'RF-0012', timestamp: day(0, '08:16:03'), eventType: 'resume', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Via liberada, seguimento de linha retomado.' },
  { id: 'evt-1206', missionId: 'RF-0012', timestamp: day(0, '08:16:48'), eventType: 'destination_reached', command: 'station "descarga"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na estação descarga.' },
  { id: 'evt-1207', missionId: 'RF-0012', timestamp: day(0, '08:16:49'), eventType: 'mission_end', command: 'wait_signal("descarga_completa")', roverState: 'idle', severity: 'info', message: 'Rota concluída. Aguardando sinal de descarga.' },

  // RF-0011 — retorno descarga -> carga, sem paradas
  { id: 'evt-1101', missionId: 'RF-0011', timestamp: day(0, '07:40:00'), eventType: 'mission_start', command: 'station "descarga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação descarga, destino carga.' },
  { id: 'evt-1102', missionId: 'RF-0011', timestamp: day(0, '07:41:12'), eventType: 'destination_reached', command: 'station "carga"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na estação carga.' },
  { id: 'evt-1103', missionId: 'RF-0011', timestamp: day(0, '07:41:13'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída sem interrupções.' },

  // RF-0010 — perda de linha, rota abortada
  { id: 'evt-1001', missionId: 'RF-0010', timestamp: day(1, '16:22:00'), eventType: 'mission_start', command: 'station "triagem"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação triagem, destino carga.' },
  { id: 'evt-1002', missionId: 'RF-0010', timestamp: day(1, '16:22:38'), eventType: 'warning', roverState: 'navigating', severity: 'warning', message: 'Erro de trajetória acima do limite: desvio lateral de 68px.' },
  { id: 'evt-1003', missionId: 'RF-0010', timestamp: day(1, '16:22:51'), eventType: 'error', command: 'stop()', roverState: 'error', severity: 'error', message: 'Linha perdida: transição FOLLOWING -> LOST_TRACK. Rota interrompida.' },

  // RF-0009 — parada por sinal manual
  { id: 'evt-0901', missionId: 'RF-0009', timestamp: day(2, '11:05:00'), eventType: 'mission_start', command: 'station "carga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação carga, destino triagem.' },
  { id: 'evt-0902', missionId: 'RF-0009', timestamp: day(2, '11:05:33'), eventType: 'presence_detected', roverState: 'obstacle_hold', severity: 'warning', message: 'PROX 25cm — operador no corredor.' },
  { id: 'evt-0903', missionId: 'RF-0009', timestamp: day(2, '11:05:34'), eventType: 'stop_preventive', command: 'stop()', roverState: 'stopped', severity: 'warning', message: 'Parada preventiva por detecção de presença.' },
  { id: 'evt-0904', missionId: 'RF-0009', timestamp: day(2, '11:06:10'), eventType: 'resume', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Corredor liberado, retomando trajeto.' },
  { id: 'evt-0905', missionId: 'RF-0009', timestamp: day(2, '11:07:02'), eventType: 'destination_reached', command: 'station "triagem"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na estação triagem.' },
  { id: 'evt-0906', missionId: 'RF-0009', timestamp: day(2, '11:07:03'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída com 1 parada preventiva.' },

  // RF-0008 — falha de leitura de sensor
  { id: 'evt-0801', missionId: 'RF-0008', timestamp: day(3, '09:30:00'), eventType: 'mission_start', command: 'station "descarga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação descarga, destino carga.' },
  { id: 'evt-0802', missionId: 'RF-0008', timestamp: day(3, '09:30:47'), eventType: 'error', roverState: 'error', severity: 'critical', message: 'Timeout na leitura serial do ESP32 após 3 tentativas.' },

  // RF-0007 — rota longa concluída
  { id: 'evt-0701', missionId: 'RF-0007', timestamp: day(4, '14:12:00'), eventType: 'mission_start', command: 'station "carga"', roverState: 'idle', severity: 'info', message: 'Rota iniciada na estação carga, destino descarga.' },
  { id: 'evt-0702', missionId: 'RF-0007', timestamp: day(4, '14:12:55'), eventType: 'presence_detected', roverState: 'obstacle_hold', severity: 'warning', message: 'PROX 38cm — obstáculo transitório.' },
  { id: 'evt-0703', missionId: 'RF-0007', timestamp: day(4, '14:13:20'), eventType: 'resume', command: 'resume_line_following()', roverState: 'moving', severity: 'info', message: 'Retomando trajeto.' },
  { id: 'evt-0704', missionId: 'RF-0007', timestamp: day(4, '14:14:38'), eventType: 'destination_reached', command: 'station "descarga"', roverState: 'completed', severity: 'info', message: 'Chegada confirmada na estação descarga.' },
  { id: 'evt-0705', missionId: 'RF-0007', timestamp: day(4, '14:14:39'), eventType: 'mission_end', roverState: 'idle', severity: 'info', message: 'Rota concluída.' },
];

const MISSIONS: DemoMission[] = [
  { id: 'RF-0012', origin: 'carga', destination: 'descarga', status: 'completed', startedAt: day(0, '08:15:00'), endedAt: day(0, '08:16:49'), durationSeconds: 109, stopCount: 1, presenceStopCount: 1, errorCount: 0, eventCount: 7, stopReasons: [{ reason: 'Presença detectada', count: 1 }] },
  { id: 'RF-0011', origin: 'descarga', destination: 'carga', status: 'completed', startedAt: day(0, '07:40:00'), endedAt: day(0, '07:41:13'), durationSeconds: 73, stopCount: 0, presenceStopCount: 0, errorCount: 0, eventCount: 3, stopReasons: [] },
  { id: 'RF-0010', origin: 'triagem', destination: 'carga', status: 'aborted', startedAt: day(1, '16:22:00'), endedAt: day(1, '16:22:51'), durationSeconds: 51, stopCount: 1, presenceStopCount: 0, errorCount: 1, eventCount: 3, stopReasons: [{ reason: 'Linha perdida', count: 1 }] },
  { id: 'RF-0009', origin: 'carga', destination: 'triagem', status: 'completed', startedAt: day(2, '11:05:00'), endedAt: day(2, '11:07:03'), durationSeconds: 123, stopCount: 1, presenceStopCount: 1, errorCount: 0, eventCount: 6, stopReasons: [{ reason: 'Presença detectada', count: 1 }] },
  { id: 'RF-0008', origin: 'descarga', destination: 'carga', status: 'failed', startedAt: day(3, '09:30:00'), durationSeconds: null, stopCount: 0, presenceStopCount: 0, errorCount: 1, eventCount: 2, stopReasons: [] },
  { id: 'RF-0007', origin: 'carga', destination: 'descarga', status: 'completed', startedAt: day(4, '14:12:00'), endedAt: day(4, '14:14:39'), durationSeconds: 159, stopCount: 1, presenceStopCount: 1, errorCount: 0, eventCount: 5, stopReasons: [{ reason: 'Presença detectada', count: 1 }] },
];

const ALERTS = [
  { id: 'alt-01', title: 'Linha perdida durante o trajeto', description: 'Transição FOLLOWING -> LOST_TRACK na rota RF-0010, entre triagem e carga.', severity: 'error', timestamp: day(1, '16:22:51'), missionId: 'RF-0010', occurrenceCount: 1, acknowledged: false, relatedEventIds: ['evt-1003'] },
  { id: 'alt-02', title: 'Falha de comunicação com o ESP32', description: 'Timeout na leitura serial após 3 tentativas durante a rota RF-0008.', severity: 'critical', timestamp: day(3, '09:30:47'), missionId: 'RF-0008', occurrenceCount: 1, acknowledged: false, relatedEventIds: ['evt-0802'] },
  { id: 'alt-03', title: 'Paradas recorrentes por presença', description: '3 paradas preventivas por detecção de presença nas últimas rotas.', severity: 'warning', timestamp: day(0, '08:15:42'), occurrenceCount: 3, acknowledged: true, acknowledgedAt: day(0, '09:00:00'), relatedEventIds: ['evt-1203', 'evt-0902', 'evt-0702'] },
];

const METRICS = {
  totalMissions: 6,
  completedMissions: 4,
  inProgressMissions: 0,
  failedMissions: 1,
  abortedMissions: 1,
  indeterminateMissions: 0,
  avgDurationSeconds: 116,
  medianDurationSeconds: 116,
  minDurationSeconds: 73,
  maxDurationSeconds: 159,
  totalStops: 4,
  presenceStops: 3,
  otherStops: 1,
  unknownStops: 0,
  completionRate: 66.7,
  activeAlertsCount: 2,
  totalErrors: 2,
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ok = (data: unknown) => json({ success: true, data });

/** Roteia uma rota do contrato para a resposta de demonstração. */
function route(path: string, method: string, search: URLSearchParams): Response {
  if (path === 'dashboard/metrics') return ok(METRICS);

  if (path === 'missions') return ok(MISSIONS);

  if (path.startsWith('missions/')) {
    const id = decodeURIComponent(path.slice('missions/'.length));
    const mission = MISSIONS.find((m) => m.id === id);
    if (!mission) return json({ success: false, message: 'Rota não encontrada' }, 404);
    return ok({ ...mission, events: EVENTS.filter((e) => e.missionId === id) });
  }

  if (path === 'logs') {
    const sorted = [...EVENTS].sort(
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
    let list = ALERTS;
    if (status === 'unacknowledged') list = ALERTS.filter((a) => !a.acknowledged);
    if (status === 'acknowledged') list = ALERTS.filter((a) => a.acknowledged);
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

    // Pequena latência, para os estados de carregamento ficarem visíveis.
    await new Promise((resolve) => setTimeout(resolve, 180));

    return route(path, method, parsed.searchParams);
  };
}
