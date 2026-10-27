/**
 * Gera `contracts/seed/*.json` de forma DETERMINÍSTICA.
 *
 * Os dados são os do demo da dashboard (dashboard/src/demo/demoBackend.ts)
 * com datas fixas: o "agora" do seed é `SEED_NOW`. Nada de segredo aqui;
 * `devices.json` só guarda o NOME do segredo no Secret Manager.
 *
 * Uso: npm run seed:build
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');
mkdirSync(out, { recursive: true });

export const SEED_NOW = '2026-10-26T18:00:00.000Z';
const NOW = Date.parse(SEED_NOW);

/** `day(n, 'hh:mm:ss')`: n dias antes de 26/10/2026, em UTC. */
const day = (daysAgo, time) => {
  const [h, m, s] = time.split(':').map(Number);
  const d = new Date(Date.UTC(2026, 9, 26 - daysAgo, h, m, s ?? 0, 0));
  return d.toISOString();
};
const minutesAgo = (min) => new Date(NOW - min * 60_000).toISOString();

const write = (name, data) =>
  writeFileSync(join(out, name), JSON.stringify(data, null, 2) + '\n', 'utf8');

// ---------------------------------------------------------------- mapas
const grid = (id, name, cols, rows, points, closedEdges = []) => ({
  id,
  version: 1,
  name,
  cols,
  rows,
  points,
  closedEdges,
});

const maps = [
  grid('pista-1', 'Pista 1 — Linha de montagem A', 5, 4, [
    { x: 0, y: 0, kind: 'station', label: 'carga' },
    { x: 4, y: 0, kind: 'station', label: 'descarga' },
    { x: 0, y: 3, kind: 'station', label: 'triagem' },
    { x: 2, y: 2, kind: 'blocked' },
  ]),
  grid('pista-2', 'Pista 2 — Expedição', 5, 4, [
    { x: 4, y: 0, kind: 'station', label: 'doca 1' },
    { x: 4, y: 3, kind: 'station', label: 'doca 2' },
    { x: 0, y: 1, kind: 'station', label: 'estoque' },
    { x: 1, y: 2, kind: 'blocked' },
    { x: 3, y: 2, kind: 'blocked' },
  ]),
  grid('pista-3', 'Pista 3 — Triagem', 5, 4, [
    { x: 0, y: 3, kind: 'station', label: 'triagem' },
    { x: 2, y: 0, kind: 'station', label: 'inspeção' },
    { x: 4, y: 2, kind: 'station', label: 'rejeito' },
  ]),
  grid('pista-4', 'Pista 4 — Doca 3', 4, 4, [
    { x: 0, y: 0, kind: 'station', label: 'doca 3' },
    { x: 3, y: 3, kind: 'station', label: 'pátio' },
    { x: 1, y: 1, kind: 'blocked' },
  ]),
];
write('maps.json', maps);

// ------------------------------------------------------------ dispositivos
const capabilities = { supportsReverse: false, maxActions: 64, maxMessageBytes: 4096 };
const devices = [
  ['RB-01', 'pista-1', 'E'],
  ['RB-02', 'pista-2', 'S'],
  ['RB-03', 'pista-3', 'N'],
  ['RB-04', 'pista-4', 'E'],
].map(([id, mapId, heading]) => ({
  id, // deviceId == robotId (decisão de simplificação do POC)
  robotId: id,
  mapId,
  mapVersion: 1,
  /** Rumo confirmado pela última vez; o operador reconfirma antes de enviar. */
  lastConfirmedHeading: heading,
  capabilities,
  /** Nome do segredo HMAC no Secret Manager. O VALOR nunca entra no repositório. */
  secretName: `device-secret-${id}`,
}));
write('devices.json', devices);

// ----------------------------------------------------------------- robôs
// Resposta de GET /api/robots (contrato público).
const robots = [
  { id: 'RB-01', name: 'Carregador Norte', area: 'Linha de montagem A', model: 'RoboFlow AGV v2', status: 'busy', roverState: 'moving', currentMissionId: 'RF-0112', batteryPercent: 78, currentPoint: '2,1', firmwareVersion: '1.4.2', lastSeenAt: minutesAgo(1), activeAlertsCount: 0 },
  { id: 'RB-02', name: 'Esteira Leste', area: 'Expedição', model: 'RoboFlow AGV v2', status: 'online', roverState: 'idle', batteryPercent: 94, currentPoint: '4,0', firmwareVersion: '1.4.2', lastSeenAt: minutesAgo(2), activeAlertsCount: 1 },
  { id: 'RB-03', name: 'Triagem Sul', area: 'Triagem', model: 'RoboFlow AGV v1', status: 'error', roverState: 'error', batteryPercent: 41, currentPoint: '1,3', firmwareVersion: '1.3.8', lastSeenAt: minutesAgo(12), activeAlertsCount: 2 },
  { id: 'RB-04', name: 'Expedição Oeste', area: 'Doca 3', model: 'RoboFlow AGV v1', status: 'offline', roverState: 'unknown', batteryPercent: null, currentPoint: null, firmwareVersion: '1.3.8', lastSeenAt: minutesAgo(214), activeAlertsCount: 0 },
];
write('robots.json', robots);

// ------------------------------------------------------ rotas cadastradas
// Modelos de rota (sem endpoint na v1): servem de dados de teste e de base
// para atalhos "A -> B" futuros. Sempre começam sem exigir marcha à ré.
const routeTemplates = [
  { id: 'rota-carga-descarga', version: 1, name: 'Carga até descarga', mapId: 'pista-1', mapVersion: 1, initialHeading: 'E', waypoints: [[0,0],[1,0],[2,0],[2,1],[3,1],[4,1],[4,0]] },
  { id: 'rota-descarga-carga', version: 1, name: 'Descarga até carga', mapId: 'pista-1', mapVersion: 1, initialHeading: 'W', waypoints: [[4,0],[3,0],[2,0],[1,0],[0,0]] },
  { id: 'rota-estoque-doca1', version: 1, name: 'Estoque até doca 1', mapId: 'pista-2', mapVersion: 1, initialHeading: 'N', waypoints: [[0,1],[0,0],[1,0],[2,0],[3,0],[4,0]] },
  { id: 'rota-triagem-inspecao', version: 1, name: 'Triagem até inspeção', mapId: 'pista-3', mapVersion: 1, initialHeading: 'N', waypoints: [[0,3],[0,2],[0,1],[0,0],[1,0],[2,0]] },
  { id: 'rota-doca3-patio', version: 1, name: 'Doca 3 até pátio', mapId: 'pista-4', mapVersion: 1, initialHeading: 'E', waypoints: [[0,0],[1,0],[2,0],[3,0],[3,1],[3,2],[3,3]] },
].map((r) => ({ ...r, waypoints: r.waypoints.map(([x, y]) => ({ x, y })) }));
write('route-templates.json', routeTemplates);

// Rota carregada hoje (GET /api/robots/RB-01/route)
write('active-routes.json', [
  {
    routeId: 'RT-0041',
    robotId: 'RB-01',
    waypoints: routeTemplates[0].waypoints,
    createdAt: minutesAgo(26),
    status: 'running',
    currentWaypointIndex: 3,
    missionId: 'RF-0112',
    state: 'running',
    initialHeading: 'E',
    actions: ['F', 'F', 'D', 'E', 'F', 'E'],
    mapVersion: 1,
  },
]);

// --------------------------------------------------------------- eventos
const E = (id, missionId, robotId, timestamp, eventType, roverState, severity, message, command) => ({
  id, missionId, robotId, timestamp, eventType,
  ...(command ? { command } : {}),
  roverState, severity, message,
});

const events = [
  E('evt-11201','RF-0112','RB-01',minutesAgo(26),'mission_start','idle','info','Rota iniciada na estação carga, destino descarga.','station "carga"'),
  E('evt-11202','RF-0112','RB-01',minutesAgo(25),'command','moving','info','Seguimento de linha retomado após carregamento.','resume_line_following()'),
  E('evt-11203','RF-0112','RB-01',minutesAgo(8),'state_change','navigating','info','Ponto (2, 1) alcançado. Seguindo para (3, 1).'),

  E('evt-11101','RF-0111','RB-01',day(0,'08:15:00'),'mission_start','idle','info','Rota iniciada na estação carga, destino descarga.','station "carga"'),
  E('evt-11102','RF-0111','RB-01',day(0,'08:15:04'),'command','moving','info','Seguimento de linha retomado após carregamento.','resume_line_following()'),
  E('evt-11103','RF-0111','RB-01',day(0,'08:15:41'),'presence_detected','obstacle_hold','warning','PROX 42cm — obstáculo detectado à frente.'),
  E('evt-11104','RF-0111','RB-01',day(0,'08:15:42'),'stop_preventive','stopped','warning','Parada preventiva executada. Aguardando via livre.','stop()'),
  E('evt-11105','RF-0111','RB-01',day(0,'08:16:03'),'resume','moving','info','Via liberada, seguimento de linha retomado.','resume_line_following()'),
  E('evt-11106','RF-0111','RB-01',day(0,'08:16:48'),'destination_reached','completed','info','Chegada confirmada na estação descarga.','station "descarga"'),
  E('evt-11107','RF-0111','RB-01',day(0,'08:16:49'),'mission_end','idle','info','Rota concluída. Aguardando sinal de descarga.','wait_signal("descarga_completa")'),

  E('evt-10801','RF-0108','RB-01',day(1,'07:40:00'),'mission_start','idle','info','Rota iniciada na estação descarga, destino carga.','station "descarga"'),
  E('evt-10802','RF-0108','RB-01',day(1,'07:41:12'),'destination_reached','completed','info','Chegada confirmada na estação carga.','station "carga"'),
  E('evt-10803','RF-0108','RB-01',day(1,'07:41:13'),'mission_end','idle','info','Rota concluída sem interrupções.'),

  E('evt-11001','RF-0110','RB-02',day(0,'11:05:00'),'mission_start','idle','info','Rota iniciada no estoque, destino doca 1.','station "estoque"'),
  E('evt-11002','RF-0110','RB-02',day(0,'11:05:33'),'presence_detected','obstacle_hold','warning','PROX 25cm — operador no corredor.'),
  E('evt-11003','RF-0110','RB-02',day(0,'11:05:34'),'stop_preventive','stopped','warning','Parada preventiva por detecção de presença.','stop()'),
  E('evt-11004','RF-0110','RB-02',day(0,'11:06:10'),'resume','moving','info','Corredor liberado, retomando trajeto.','resume_line_following()'),
  E('evt-11005','RF-0110','RB-02',day(0,'11:07:02'),'destination_reached','completed','info','Chegada confirmada na doca 1.','station "doca 1"'),
  E('evt-11006','RF-0110','RB-02',day(0,'11:07:03'),'mission_end','idle','info','Rota concluída com 1 parada preventiva.'),

  E('evt-10701','RF-0107','RB-02',day(1,'14:12:00'),'mission_start','idle','info','Rota iniciada na doca 1, destino doca 2.','station "doca 1"'),
  E('evt-10702','RF-0107','RB-02',day(1,'14:12:55'),'warning','navigating','warning','Erro de trajetória acima do limite: desvio lateral de 54px.'),
  E('evt-10703','RF-0107','RB-02',day(1,'14:13:20'),'resume','moving','info','Trajetória corrigida pelo PID, retomando.','resume_line_following()'),
  E('evt-10704','RF-0107','RB-02',day(1,'14:14:38'),'destination_reached','completed','info','Chegada confirmada na doca 2.','station "doca 2"'),
  E('evt-10705','RF-0107','RB-02',day(1,'14:14:39'),'mission_end','idle','info','Rota concluída.'),

  E('evt-10401','RF-0104','RB-02',day(3,'09:02:00'),'mission_start','idle','info','Rota iniciada na doca 2, destino estoque.','station "doca 2"'),
  E('evt-10402','RF-0104','RB-02',day(3,'09:03:08'),'destination_reached','completed','info','Chegada confirmada no estoque.','station "estoque"'),
  E('evt-10403','RF-0104','RB-02',day(3,'09:03:09'),'mission_end','idle','info','Rota concluída sem interrupções.'),

  E('evt-10901','RF-0109','RB-03',day(0,'16:22:00'),'mission_start','idle','info','Rota iniciada na triagem, destino inspeção.','station "triagem"'),
  E('evt-10902','RF-0109','RB-03',day(0,'16:22:38'),'warning','navigating','warning','Erro de trajetória acima do limite: desvio lateral de 68px.'),
  E('evt-10903','RF-0109','RB-03',day(0,'16:22:51'),'error','error','error','Linha perdida: transição FOLLOWING -> LOST_TRACK. Rota interrompida.','stop()'),

  E('evt-10601','RF-0106','RB-03',day(2,'09:30:00'),'mission_start','idle','info','Rota iniciada na inspeção, destino rejeito.','station "inspeção"'),
  E('evt-10602','RF-0106','RB-03',day(2,'09:30:47'),'error','error','critical','Timeout na leitura serial do ESP32 após 3 tentativas.'),

  E('evt-10301','RF-0103','RB-03',day(4,'10:18:00'),'mission_start','idle','info','Rota iniciada na triagem, destino rejeito.','station "triagem"'),
  E('evt-10302','RF-0103','RB-03',day(4,'10:19:44'),'destination_reached','completed','info','Chegada confirmada no rejeito.','station "rejeito"'),
  E('evt-10303','RF-0103','RB-03',day(4,'10:19:45'),'mission_end','idle','info','Rota concluída.'),

  E('evt-10201','RF-0102','RB-04',day(0,'05:40:00'),'mission_start','idle','info','Rota iniciada na doca 3, destino pátio.','station "doca 3"'),
  E('evt-10202','RF-0102','RB-04',day(0,'05:41:36'),'destination_reached','completed','info','Chegada confirmada no pátio.','station "pátio"'),
  E('evt-10203','RF-0102','RB-04',day(0,'05:41:37'),'mission_end','idle','info','Rota concluída. Robô recolhido para manutenção preventiva.'),
];
write('events.json', events);

// --------------------------------------------------------------- missões
const M = (id, robotId, origin, destination, status, startedAt, endedAt, durationSeconds, stopCount, presenceStopCount, errorCount, stopReasons) => ({
  id, robotId, origin, destination, status, startedAt,
  ...(endedAt ? { endedAt } : {}),
  durationSeconds, stopCount, presenceStopCount, errorCount,
  eventCount: events.filter((e) => e.missionId === id).length,
  stopReasons,
});
const presence = [{ reason: 'Presença detectada', count: 1 }];
const missions = [
  M('RF-0112','RB-01','carga','descarga','in_progress',minutesAgo(26),null,null,0,0,0,[]),
  M('RF-0111','RB-01','carga','descarga','completed',day(0,'08:15:00'),day(0,'08:16:49'),109,1,1,0,presence),
  M('RF-0110','RB-02','estoque','doca 1','completed',day(0,'11:05:00'),day(0,'11:07:03'),123,1,1,0,presence),
  M('RF-0109','RB-03','triagem','inspeção','aborted',day(0,'16:22:00'),day(0,'16:22:51'),51,1,0,1,[{ reason: 'Linha perdida', count: 1 }]),
  M('RF-0108','RB-01','descarga','carga','completed',day(1,'07:40:00'),day(1,'07:41:13'),73,0,0,0,[]),
  M('RF-0107','RB-02','doca 1','doca 2','completed',day(1,'14:12:00'),day(1,'14:14:39'),159,1,0,0,[{ reason: 'Desvio de trajetória', count: 1 }]),
  M('RF-0106','RB-03','inspeção','rejeito','failed',day(2,'09:30:00'),null,null,0,0,1,[]),
  M('RF-0104','RB-02','doca 2','estoque','completed',day(3,'09:02:00'),day(3,'09:03:09'),69,0,0,0,[]),
  M('RF-0103','RB-03','triagem','rejeito','completed',day(4,'10:18:00'),day(4,'10:19:45'),105,0,0,0,[]),
  M('RF-0102','RB-04','doca 3','pátio','completed',day(0,'05:40:00'),day(0,'05:41:37'),97,0,0,0,[]),
];
write('missions.json', missions);

// Estado interno (detalhado) de cada missão — a projeção pública é `status`.
const internalState = { completed: 'completed', aborted: 'aborted', failed: 'failed', in_progress: 'running', indeterminate: 'uncertain' };
write('mission-states.json', missions.map((m) => ({
  missionId: m.id,
  robotId: m.robotId,
  deviceId: m.robotId,
  state: internalState[m.status],
  routeRevision: 1,
})));

// ---------------------------------------------------------------- alertas
write('alerts.json', [
  { id: 'alt-01', title: 'Linha perdida durante o trajeto', description: 'Transição FOLLOWING -> LOST_TRACK na rota RF-0109, entre triagem e inspeção.', severity: 'error', timestamp: day(0,'16:22:51'), missionId: 'RF-0109', robotId: 'RB-03', occurrenceCount: 1, acknowledged: false, relatedEventIds: ['evt-10903'] },
  { id: 'alt-02', title: 'Falha de comunicação com o ESP32', description: 'Timeout na leitura serial após 3 tentativas durante a rota RF-0106.', severity: 'critical', timestamp: day(2,'09:30:47'), missionId: 'RF-0106', robotId: 'RB-03', occurrenceCount: 1, acknowledged: false, relatedEventIds: ['evt-10602'] },
  { id: 'alt-03', title: 'Desvio de trajetória recorrente', description: 'Erro lateral acima do limite em 2 das últimas 3 rotas da doca 1.', severity: 'warning', timestamp: day(1,'14:12:55'), missionId: 'RF-0107', robotId: 'RB-02', occurrenceCount: 2, acknowledged: false, relatedEventIds: ['evt-10702'] },
  { id: 'alt-04', title: 'Paradas recorrentes por presença', description: '2 paradas preventivas por detecção de presença nas últimas rotas da frota.', severity: 'warning', timestamp: day(0,'08:15:42'), occurrenceCount: 2, acknowledged: true, acknowledgedAt: day(0,'09:00:00'), relatedEventIds: ['evt-11103','evt-11002'] },
]);

// ----------------------------------------------------------------- manifest
write('manifest.json', {
  seedNow: SEED_NOW,
  note: 'Gerado por scripts/build-seed.mjs. Não edite à mão.',
  files: ['maps', 'devices', 'robots', 'route-templates', 'active-routes', 'events', 'missions', 'mission-states', 'alerts'].map((n) => `${n}.json`),
});

console.log('seed gerado em', out);
