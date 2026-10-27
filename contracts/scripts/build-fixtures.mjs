/**
 * Gera `contracts/fixtures/**` (exemplos VÁLIDOS e INVÁLIDOS) de forma
 * determinística a partir do seed e dos próprios schemas.
 *
 * Arquivo: fixtures/<grupo>/<nome>.valid.json | <nome>.invalid.json
 * Conteúdo: { "schema": "<nome no registro>", "description": "...", "value": ... }
 *
 * Requer `npm run build` antes (importa de ../dist).
 * Uso: npm run fixtures:build
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregateFleetMetrics, aggregateMetrics, translateRoute } from '../dist/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const seed = (n) => JSON.parse(readFileSync(join(root, 'seed', `${n}.json`), 'utf8'));
const outRoot = join(root, 'fixtures');
rmSync(outRoot, { recursive: true, force: true });

const clone = (v) => JSON.parse(JSON.stringify(v));
const without = (o, ...keys) => {
  const c = clone(o);
  for (const k of keys) delete c[k];
  return c;
};
const set = (o, patch) => ({ ...clone(o), ...patch });

function emit(group, name, kind, schema, description, value) {
  const dir = join(outRoot, group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.${kind}.json`),
    JSON.stringify({ schema, description, value }, null, 2) + '\n',
    'utf8'
  );
}
const ok = (g, n, s, d, v) => emit(g, n, 'valid', s, d, v);
const bad = (g, n, s, d, v) => emit(g, n, 'invalid', s, d, v);

const robots = seed('robots');
const missions = seed('missions');
const events = seed('events');
const alerts = seed('alerts');
const maps = seed('maps');
const activeRoutes = seed('active-routes');
const capabilities = { supportsReverse: false, maxActions: 64, maxMessageBytes: 4096 };

const metricsMissions = missions;
const dash = aggregateMetrics(metricsMissions, events, alerts);
const fleet = aggregateFleetMetrics(robots, metricsMissions, events, alerts);

// ===================================================== respostas da dashboard
ok('api', 'listRobots', 'listRobots.response', 'Frota do seed', robots);
bad('api', 'listRobots-status-invalido', 'listRobots.response', 'status fora do enum', [set(robots[0], { status: 'parado' })]);
bad('api', 'listRobots-sem-lastSeenAt', 'listRobots.response', 'lastSeenAt obrigatório', [without(robots[0], 'lastSeenAt')]);
ok('api', 'getRobot', 'getRobot.response', 'Robô offline, bateria null', robots[3]);
bad('api', 'getRobot-currentPoint', 'getRobot.response', 'currentPoint deve ser "x,y"', set(robots[0], { currentPoint: '(2, 1)' }));

ok('api', 'dashboardMetrics', 'dashboardMetrics.response', 'KPIs do seed inteiro', dash);
ok('api', 'dashboardMetrics-vazio', 'dashboardMetrics.response', 'Sem missões: durações null, taxa 0', aggregateMetrics([], [], []));
bad('api', 'dashboardMetrics-taxa-fracao', 'dashboardMetrics.response', 'completionRate é percentual 0–100, não fração >100', set(dash, { completionRate: 150 }));
bad('api', 'dashboardMetrics-sem-campo', 'dashboardMetrics.response', 'campo obrigatório ausente', without(dash, 'totalStops'));
ok('api', 'fleetMetrics', 'fleetMetrics.response', 'Frota com perRobot', fleet);
bad('api', 'fleetMetrics-sem-perRobot', 'fleetMetrics.response', 'perRobot obrigatório', without(fleet, 'perRobot'));

ok('api', 'listMissions', 'listMissions.response', 'Missões sem events', missions);
bad('api', 'listMissions-status', 'listMissions.response', 'status inválido', [set(missions[0], { status: 'running' })]);
const m1 = missions.find((m) => m.id === 'RF-0111');
ok('api', 'getMission', 'getMission.response', 'Missão com linha do tempo', { ...m1, events: events.filter((e) => e.missionId === m1.id) });
bad('api', 'getMission-evento-invalido', 'getMission.response', 'eventType desconhecido', { ...m1, events: [set(events[0], { eventType: 'inventado' })] });

const logs = [...events].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
ok('api', 'listLogs', 'listLogs.response', 'Mais recente primeiro', logs);
bad('api', 'listLogs-sem-robotId', 'listLogs.response', 'robotId obrigatório em cada evento', [without(events[0], 'robotId')]);
bad('api', 'listLogs-timestamp', 'listLogs.response', 'timestamp não ISO 8601', [set(events[0], { timestamp: '26/10/2026 18:00' })]);
ok('api', 'listAlerts', 'listAlerts.response', 'Alertas do seed', alerts);
bad('api', 'listAlerts-severity', 'listAlerts.response', 'severity inválida', [set(alerts[0], { severity: 'grave' })]);
ok('api', 'acknowledgeAlert', 'acknowledgeAlert.response', 'Reconhecimento persistido', { id: 'alt-01', acknowledged: true, acknowledgedAt: '2026-10-26T18:05:00.000Z' });
bad('api', 'acknowledgeAlert-sem-flag', 'acknowledgeAlert.response', 'acknowledged obrigatório', { id: 'alt-01' });

ok('api', 'importLogs-request', 'importLogs.request', 'Lote de eventos', { events: [events[0], events[1]] });
bad('api', 'importLogs-vazio', 'importLogs.request', 'lote vazio', { events: [] });
bad('api', 'importLogs-sem-events', 'importLogs.request', 'corpo sem events', {});
ok('api', 'importLogs-response', 'importLogs.response', 'Contagens', { importedCount: 2, ignoredCount: 0 });
bad('api', 'importLogs-response-negativo', 'importLogs.response', 'contagem negativa', { importedCount: -1 });

ok('api', 'health', 'health.response', 'Health', { status: 'ok', version: '1.0.0', robotsConnected: 4 });
bad('api', 'health-status', 'health.response', 'status diferente de ok', { status: 'degraded', version: '1', robotsConnected: 0 });

// ================================================================= consultas
ok('query', 'listMissions', 'listMissions.query', 'Filtros comuns', { period: '7d', robotId: 'RB-01', status: 'completed', limit: '25' });
ok('query', 'listMissions-all', 'listMissions.query', '"all" equivale a omitido', { status: 'all', period: 'all' });
bad('query', 'listMissions-period', 'listMissions.query', 'period inválido', { period: '90d' });
bad('query', 'listMissions-limit', 'listMissions.query', 'limit acima do teto', { limit: '9999' });
ok('query', 'listLogs', 'listLogs.query', 'Filtros de log', { eventType: 'stop_preventive', severity: 'warning', missionId: 'RF-0111' });
bad('query', 'listLogs-severity', 'listLogs.query', 'severity inválida', { severity: 'fatal' });
ok('query', 'listAlerts', 'listAlerts.query', 'Não reconhecidos', { status: 'unacknowledged' });
bad('query', 'listAlerts-status', 'listAlerts.query', 'status inválido', { status: 'pending' });
ok('query', 'dashboardMetrics-custom', 'dashboardMetrics.query', 'Período custom', { period: 'custom', startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-10-26T00:00:00.000Z' });
bad('query', 'dashboardMetrics-data', 'dashboardMetrics.query', 'data inválida', { startDate: 'ontem' });

// ==================================================================== rotas
const map1 = maps[0];
ok('api', 'getGrid', 'getGrid.response', 'Malha do robô 1', { cols: map1.cols, rows: map1.rows, points: map1.points });
bad('api', 'getGrid-cols', 'getGrid.response', 'cols deve ser positivo', { cols: 0, rows: 4 });
ok('api', 'getRoute', 'getRoute.response', 'Rota em execução com extensões', activeRoutes[0]);
ok('api', 'getRoute-minimo', 'getRoute.response', 'Apenas os campos do contrato original', without(activeRoutes[0], 'missionId', 'state', 'initialHeading', 'actions', 'mapVersion'));
bad('api', 'getRoute-status', 'getRoute.response', 'status fora do enum da rota', set(activeRoutes[0], { status: 'running_fast' }));

const wp = [[0,0],[1,0],[2,0],[2,1]].map(([x, y]) => ({ x, y }));
ok('api', 'previewRoute-request', 'previewRoute.request', 'Prévia com rumo', { waypoints: wp, initialHeading: 'E' });
ok('api', 'previewRoute-request-sem-rumo', 'previewRoute.request', 'Rumo opcional (usa o último confirmado)', { waypoints: wp });
bad('api', 'previewRoute-request-rumo', 'previewRoute.request', 'rumo inválido', { waypoints: wp, initialHeading: 'norte' });
bad('api', 'previewRoute-request-ponto', 'previewRoute.request', 'coordenada negativa', { waypoints: [{ x: -1, y: 0 }] });

const t = translateRoute(map1, wp, 'E');
const preview = { robotId: 'RB-01', mapId: 'pista-1', mapVersion: 1, waypoints: wp, actions: t.actions, expectedNodes: t.expectedNodes, initialHeading: 'E', finalHeading: t.finalHeading, executable: t.executable, errors: t.errors };
ok('api', 'previewRoute-response', 'previewRoute.response', 'Prévia executável', preview);
const tBad = translateRoute(map1, [{ x: 0, y: 0 }, { x: 0, y: 2 }], 'S');
ok('api', 'previewRoute-response-erro', 'previewRoute.response', 'Prévia não executável (salto) com errors[]', { ...preview, waypoints: [{ x: 0, y: 0 }, { x: 0, y: 2 }], actions: [], expectedNodes: [], initialHeading: 'S', finalHeading: null, executable: false, errors: tBad.errors });
bad('api', 'previewRoute-response-acao', 'previewRoute.response', 'ação inexistente', set(preview, { actions: ['F', 'X'] }));

ok('api', 'submitRoute-request', 'submitRoute.request', 'Envio com rumo e versão', { waypoints: wp, initialHeading: 'E', mapVersion: 1 });
ok('api', 'submitRoute-request-minimo', 'submitRoute.request', 'Só waypoints (contrato original)', { waypoints: wp });
bad('api', 'submitRoute-request-sem-waypoints', 'submitRoute.request', 'waypoints obrigatório', { initialHeading: 'E' });
ok('api', 'submitRoute-aceita', 'submitRoute.response', 'Aceita', { routeId: 'RT-0042', accepted: true, waypointCount: 4, message: 'Rota aceita e enfileirada no robô.', missionId: 'RF-0113', commandId: 'cmd-0001', actions: t.actions });
ok('api', 'submitRoute-recusada', 'submitRoute.response', 'Recusa de negócio: HTTP 200 com accepted:false', { routeId: '', accepted: false, waypointCount: 4, message: 'Esteira Leste está offline e não pode receber uma rota agora.' });
bad('api', 'submitRoute-sem-accepted', 'submitRoute.response', 'accepted obrigatório', { routeId: 'RT-1', waypointCount: 2 });

// ================================================================== controle
ok('api', 'control-request', 'startMission.request', 'Controle com sessão observada', { sessionId: 'boot-7' });
ok('api', 'control-request-vazio', 'startMission.request', 'Corpo vazio é válido', {});
bad('api', 'control-request-reason', 'startMission.request', 'reason longo demais', { reason: 'x'.repeat(201) });
ok('api', 'resume-request', 'resumeMission.request', 'Retomada com o bloqueio exibido', { sessionId: 'boot-7', blockId: 'block-4' });
bad('api', 'resume-request-sem-block', 'resumeMission.request', 'blockId obrigatório em resume', { sessionId: 'boot-7' });
ok('api', 'control-accepted', 'startMission.response', '202 pendente', { commandId: 'cmd-12', missionId: 'RF-0113', status: 'pending' });
for (const id of ['stopMission', 'resumeMission', 'abortMission']) ok('api', id + '-accepted', id + '.response', '202 pendente', { commandId: 'cmd-13', missionId: 'RF-0113', status: 'pending' });
bad('api', 'control-accepted-status', 'startMission.response', 'status deve ser pending', { commandId: 'cmd-12', missionId: 'RF-0113', status: 'accepted' });

const cmd = { id: 'cmd-12', type: 'start', missionId: 'RF-0113', deviceId: 'RB-01', sessionId: 'boot-7', status: 'pending', attempts: 0, createdAt: '2026-10-26T18:00:00.000Z', expiresAt: '2026-10-26T18:00:30.000Z' };
ok('api', 'getCommand-pending', 'getCommand.response', 'Comando pendente', cmd);
ok('api', 'getCommand-rejected', 'getCommand.response', 'Comando rejeitado com motivo', set(cmd, { status: 'rejected', reason: 'BLOCKED', resolvedAt: '2026-10-26T18:00:02.000Z', deliveredAt: '2026-10-26T18:00:01.000Z', attempts: 1 }));
bad('api', 'getCommand-status', 'getCommand.response', 'status fora do ciclo', set(cmd, { status: 'done' }));
bad('api', 'getCommand-tipo', 'getCommand.response', 'tipo inválido', set(cmd, { type: 'pause' }));

const exec = { missionId: 'RF-0112', deviceId: 'RB-01', sessionId: 'boot-7', state: 'blocked', actionIndex: 3, completedActions: 3, totalActions: 6, lastConfirmedNode: '2,1', expectedNode: '3,1', atNode: false, positionConfidence: 'estimated', headingAtLastConfirmedNode: 'S', blockId: 'block-4', blockReasons: ['obstacle'], pendingCommands: [], updatedAt: '2026-10-26T17:59:00.000Z' };
ok('api', 'getExecution', 'getExecution.response', 'Bloqueada por obstáculo', exec);
ok('api', 'getExecution-concluida', 'getExecution.response', 'actionIndex null ao concluir a fila', set(exec, { state: 'completed', actionIndex: null, completedActions: 6, atNode: true, expectedNode: null, blockId: null, blockReasons: [] }));
bad('api', 'getExecution-estado', 'getExecution.response', 'estado inexistente', set(exec, { state: 'moving' }));
bad('api', 'getExecution-confianca', 'getExecution.response', 'positionConfidence inválido', set(exec, { positionConfidence: 'exact' }));

const status = { deviceId: 'RB-01', robotId: 'RB-01', connection: 'online', sessionId: 'boot-7', firmwareVersion: '1.4.2', protocolVersion: 1, capabilities, state: 'blocked', activeMissionId: 'RF-0112', sensors: { line: [0, 1, 0], distanceCm: 18.2, distanceValid: true, distanceAgeMs: 25 }, blockId: 'block-4', blockReasons: ['obstacle'], lastSeenAt: '2026-10-26T17:59:58.000Z', dataAgeMs: 2000, nextPollMs: 1500 };
ok('api', 'getDeviceStatus', 'getDeviceStatus.response', 'Dispositivo online', status);
ok('api', 'getDeviceStatus-offline', 'getDeviceStatus.response', 'Nunca visto', { ...status, connection: 'offline', sessionId: null, capabilities: null, state: null, activeMissionId: null, sensors: null, blockId: null, blockReasons: [], lastSeenAt: null, dataAgeMs: null, nextPollMs: null });
bad('api', 'getDeviceStatus-linha', 'getDeviceStatus.response', 'line precisa de 3 bits 0/1', set(status, { sensors: { line: [0, 2, 0], distanceCm: 10, distanceValid: true, distanceAgeMs: 1 } }));

ok('api', 'getRobotEvents', 'getRobotEvents.response', 'Evento sem missão (diagnóstico)', [{ id: 'evt-d1', robotId: 'RB-01', timestamp: '2026-10-26T17:00:00.000Z', eventType: 'state_change', severity: 'info', message: 'Dispositivo iniciado (boot-7).' }]);
bad('api', 'getRobotEvents-sem-robotId', 'getRobotEvents.response', 'robotId obrigatório', [{ id: 'evt-d1', timestamp: '2026-10-26T17:00:00.000Z', eventType: 'state_change', severity: 'info', message: 'x' }]);

// ======================================== posição e encerramento forçado
ok('api', 'position-request', 'confirmPosition.request', 'O operador confirma cruzamento e rumo', { x: 0, y: 3, heading: 'N' });
bad('api', 'position-request-rumo', 'confirmPosition.request', 'rumo inválido', { x: 0, y: 3, heading: 'norte' });
bad('api', 'position-request-negativo', 'confirmPosition.request', 'coordenada negativa', { x: -1, y: 3, heading: 'N' });
bad('api', 'position-request-sem-rumo', 'confirmPosition.request', 'heading obrigatório', { x: 0, y: 3 });
ok('api', 'position-response', 'confirmPosition.response', 'Posição confirmada', { currentPoint: '0,3', heading: 'N', positionConfidence: 'confirmed' });
bad('api', 'position-response-confianca', 'confirmPosition.response', 'só pode ser confirmed', { currentPoint: '0,3', heading: 'N', positionConfidence: 'estimated' });
bad('api', 'position-response-ponto', 'confirmPosition.response', 'currentPoint deve ser "x,y"', { currentPoint: '(0, 3)', heading: 'N', positionConfidence: 'confirmed' });
ok('api', 'force-close-response', 'forceCloseMission.response', 'Missão incerta encerrada sem confirmação do dispositivo', { missionId: 'RF-0113', state: 'aborted' });
bad('api', 'force-close-response-estado', 'forceCloseMission.response', 'o estado resultante é sempre aborted', { missionId: 'RF-0113', state: 'completed' });

// ================================================================== erros
ok('error', 'route-invalid', 'error', 'Corpo inválido', { success: false, message: 'A rota precisa de pelo menos dois pontos.', error: 'ROUTE_INVALID' });
ok('error', 'with-details', 'error', 'Com detalhes estruturados', { success: false, message: 'Rota inválida.', error: 'ROUTE_INVALID', details: { errors: tBad.errors } });
bad('error', 'codigo-desconhecido', 'error', 'código fora do enum', { success: false, message: 'x', error: 'OOPS' });
bad('error', 'success-true', 'error', 'success deve ser false', { success: true, message: 'x', error: 'INTERNAL' });
bad('error', 'sem-mensagem', 'error', 'message obrigatório', { success: false, error: 'INTERNAL' });

// ============================================= mensagens do dispositivo (up)
const up = { v: 1, deviceId: 'RB-01', sessionId: 'boot-7', uptimeMs: 18000 };
const hello = { ...up, type: 'hello', messageId: 'evt-1', sequence: 1, firmwareVersion: '1.4.2', protocolVersion: 1, capabilities, state: 'ready' };
ok('device', 'hello', 'device.hello', 'Handshake de boot', hello);
ok('device', 'hello-com-ultima-missao', 'device.hello', 'Lembra a missão anterior', { ...hello, lastMission: { missionId: 'RF-0112', routeRevision: 1, completedActions: 3 } });
bad('device', 'hello-versao', 'device.hello', 'v diferente de 1', set(hello, { v: 2 }));
bad('device', 'hello-sequencia-zero', 'device.hello', 'sequence começa em 1', set(hello, { sequence: 0 }));
bad('device', 'hello-sem-capacidades', 'device.hello', 'capabilities obrigatório', without(hello, 'capabilities'));

ok('device', 'ack', 'device.ack', 'Aceitação de comando', { ...up, type: 'ack', messageId: 'evt-2', sequence: 2, replyTo: 'cmd-10', result: 'accepted', missionId: 'RF-0113', routeRevision: 1 });
bad('device', 'ack-resultado', 'device.ack', 'ack só aceita accepted', { ...up, type: 'ack', messageId: 'evt-2', sequence: 2, replyTo: 'cmd-10', result: 'ok' });
ok('device', 'reject', 'device.reject', 'Rejeição com motivo', { ...up, type: 'reject', messageId: 'evt-3', sequence: 3, replyTo: 'cmd-11', reason: 'STALE_BLOCK' });
bad('device', 'reject-motivo', 'device.reject', 'motivo desconhecido', { ...up, type: 'reject', messageId: 'evt-3', sequence: 3, replyTo: 'cmd-11', reason: 'NAO_QUIS' });

const tele = { ...up, type: 'telemetry', messageId: 'evt-32', sequence: 32, state: 'blocked', missionId: 'RF-0112', routeRevision: 1, actionIndex: 3, phase: 'following_segment', line: [0, 1, 0], distanceCm: 18.2, distanceValid: true, distanceAgeMs: 25, blockId: 'block-4', blockReasons: ['obstacle'] };
ok('device', 'telemetry', 'device.telemetry', 'Bloqueado por obstáculo', tele);
ok('device', 'telemetry-distancia-invalida', 'device.telemetry', 'Distância inválida usa null + distanceValid:false', set(tele, { distanceCm: null, distanceValid: false, distanceAgeMs: null }));
bad('device', 'telemetry-linha', 'device.telemetry', 'line com valor fora de 0/1', set(tele, { line: [0, 3, 0] }));
bad('device', 'telemetry-distancia-negativa', 'device.telemetry', 'distância negativa', set(tele, { distanceCm: -4 }));
bad('device', 'telemetry-estado', 'device.telemetry', 'estado do firmware desconhecido', set(tele, { state: 'blocked_by_obstacle' }));
bad('device', 'telemetry-sem-validade', 'device.telemetry', 'distanceValid obrigatório', without(tele, 'distanceValid'));

ok('device', 'action_started', 'device.action_started', 'Início de ação', { ...up, type: 'action_started', messageId: 'evt-30', sequence: 30, missionId: 'RF-0112', routeRevision: 1, actionIndex: 3, command: 'D' });
ok('device', 'action_completed', 'device.action_completed', 'Chegada ao cruzamento', { ...up, type: 'action_completed', messageId: 'evt-31', sequence: 31, missionId: 'RF-0112', routeRevision: 1, actionIndex: 2, expectedNode: '2,1' });
bad('device', 'action_completed-no', 'device.action_completed', 'expectedNode deve ser "x,y"', { ...up, type: 'action_completed', messageId: 'evt-31', sequence: 31, missionId: 'RF-0112', routeRevision: 1, actionIndex: 2, expectedNode: 'B' });
bad('device', 'action_completed-sem-indice', 'device.action_completed', 'actionIndex obrigatório', { ...up, type: 'action_completed', messageId: 'evt-31', sequence: 31, missionId: 'RF-0112', routeRevision: 1, expectedNode: '2,1' });
ok('device', 'mission_completed', 'device.mission_completed', 'Fim da fila', { ...up, type: 'mission_completed', messageId: 'evt-40', sequence: 40, missionId: 'RF-0112', routeRevision: 1, completedActions: 6 });
ok('device', 'block_started', 'device.block_started', 'Início de bloqueio', { ...up, type: 'block_started', messageId: 'evt-33', sequence: 33, missionId: 'RF-0112', blockId: 'block-4', reasons: ['obstacle'], distanceCm: 18.2, actionIndex: 3 });
bad('device', 'block_started-sem-motivo', 'device.block_started', 'reasons não pode ser vazio', { ...up, type: 'block_started', messageId: 'evt-33', sequence: 33, blockId: 'block-4', reasons: [] });
ok('device', 'block_cleared', 'device.block_cleared', 'Fim de bloqueio', { ...up, type: 'block_cleared', messageId: 'evt-34', sequence: 34, blockId: 'block-4' });
ok('device', 'fault', 'device.fault', 'Falha do sensor', { ...up, type: 'fault', messageId: 'evt-35', sequence: 35, code: 'ULTRASONIC_TIMEOUT', message: 'Sem eco do HC-SR04', severity: 'error' });
bad('device', 'fault-gravidade', 'device.fault', 'severity info não existe em fault', { ...up, type: 'fault', messageId: 'evt-35', sequence: 35, code: 'X', message: 'y', severity: 'info' });
ok('device', 'snapshot', 'device.snapshot', 'Reconciliação', { ...up, type: 'snapshot', messageId: 'evt-36', sequence: 36, state: 'paused', missionId: 'RF-0112', routeRevision: 1, completedActions: 3, actionIndex: 3 });
bad('device', 'evento-tipo-desconhecido', 'device.event', 'type inexistente', { ...up, type: 'heartbeat', messageId: 'evt-37', sequence: 37 });

// ============================================ comandos da nuvem (down)
const down = { v: 1, deviceId: 'RB-01', sessionId: 'boot-7', missionId: 'RF-0113', validForMs: 5000 };
const load = { ...down, type: 'load_route', messageId: 'cmd-10', routeRevision: 1, actions: ['F', 'F', 'D', 'E', 'F', 'E'], expectedNodes: ['1,0', '2,0', '2,1', '3,1', '4,1', '4,0'], startNode: '0,0', initialHeading: 'E' };
ok('command', 'load_route', 'command.load_route', 'Carregamento da fila', load);
bad('command', 'load_route-comprimentos', 'command.load_route', 'actions e expectedNodes com tamanhos diferentes', set(load, { expectedNodes: ['1,0'] }));
bad('command', 'load_route-acao', 'command.load_route', 'ação inexistente', set(load, { actions: ['F', 'X'], expectedNodes: ['1,0', '2,0'] }));
bad('command', 'load_route-vazia', 'command.load_route', 'fila vazia', set(load, { actions: [], expectedNodes: [] }));
bad('command', 'load_route-rumo', 'command.load_route', 'rumo inicial inválido', set(load, { initialHeading: 'L' }));
ok('command', 'start', 'command.start', 'Início', { ...down, type: 'start', messageId: 'cmd-11', routeRevision: 1 });
ok('command', 'stop', 'command.stop', 'Parada', { ...down, type: 'stop', messageId: 'cmd-12' });
ok('command', 'resume', 'command.resume', 'Retomada amarrada ao bloqueio', { ...down, type: 'resume', messageId: 'cmd-13', routeRevision: 1, blockId: 'block-4' });
bad('command', 'resume-sem-block', 'command.resume', 'blockId obrigatório', { ...down, type: 'resume', messageId: 'cmd-13', routeRevision: 1 });
ok('command', 'abort', 'command.abort', 'Cancelamento', { ...down, type: 'abort', messageId: 'cmd-14' });
bad('command', 'validade-zero', 'command.stop', 'validForMs deve ser positivo', { ...down, type: 'stop', messageId: 'cmd-12', validForMs: 0 });
bad('command', 'tipo-desconhecido', 'command.any', 'tipo inexistente', { ...down, type: 'heartbeat', messageId: 'cmd-15' });

// ===================================================== respostas /device/*
const sync = { sessionId: 'boot-7', serverTime: '2026-10-26T18:00:00.000Z', nextPollMs: 1500, ackedSequence: 33, commands: [load], resync: false };
ok('device', 'poll-response', 'devicePoll.response', 'Poll com comando', sync);
ok('device', 'poll-response-ocioso', 'devicePoll.response', 'Repouso: sem comandos e poll longo', { ...sync, commands: [], nextPollMs: 30000 });
bad('device', 'poll-response-intervalo', 'devicePoll.response', 'nextPollMs abaixo do mínimo', set(sync, { nextPollMs: 100 }));
bad('device', 'poll-response-sem-ack', 'devicePoll.response', 'ackedSequence obrigatório', without(sync, 'ackedSequence'));
ok('device', 'hello-response', 'deviceHello.response', 'Aceita a sessão', { ...sync, commands: [], accepted: true, reconcileRequired: true, limits: capabilities });
ok('device', 'events-request', 'deviceEvents.request', 'Lote com crítico + telemetria', { events: [tele, { ...up, type: 'block_started', messageId: 'evt-33', sequence: 33, blockId: 'block-4', reasons: ['obstacle'] }] });
bad('device', 'events-request-vazio', 'deviceEvents.request', 'lote vazio', { events: [] });
bad('device', 'events-request-grande', 'deviceEvents.request', 'mais de 16 eventos', { events: Array.from({ length: 17 }, (_, i) => ({ ...tele, messageId: `e${i}`, sequence: 100 + i })) });
ok('device', 'events-response', 'deviceEvents.response', 'Resposta com rejeitados', { ...sync, commands: [], rejected: [{ sequence: 12, reason: 'sessão antiga' }] });

// ================================================================= internos
ok('internal', 'pubsub-push', 'internalEvents.request', 'Entrega push', { message: { data: 'eyJhIjoxfQ==', messageId: '123', publishTime: '2026-10-26T18:00:00.000Z', attributes: { deviceId: 'RB-01' } }, subscription: 'projects/compiladores-512823/subscriptions/agv-events-push' });
bad('internal', 'pubsub-push-sem-message', 'internalEvents.request', 'message obrigatório', { subscription: 's' });
ok('internal', 'envelope', 'internal.event', 'Evento publicado pelo ingest', { eventId: 'RB-01_boot-7_33', deviceId: 'RB-01', sessionId: 'boot-7', sequence: 33, receivedAt: '2026-10-26T18:00:00.000Z', event: { ...up, type: 'block_started', messageId: 'evt-33', sequence: 33, blockId: 'block-4', reasons: ['obstacle'] } });
ok('internal', 'events-response', 'internalEvents.response', 'Processado (2xx confirma a entrega ao Pub/Sub)', { processed: true });
ok('internal', 'offline-check', 'internalOfflineCheck.response', 'Resultado do Scheduler', { checked: 4, markedOffline: 1 });

// ================================================================== mapas
ok('map', 'pista-1', 'map', 'Mapa do seed', maps[0]);
ok('map', 'com-trecho-fechado', 'map', 'Aresta fechada em um sentido', { ...maps[0], closedEdges: [{ from: { x: 3, y: 0 }, to: { x: 4, y: 0 }, bidirectional: false }] });
bad('map', 'versao-zero', 'map', 'version começa em 1', set(maps[0], { version: 0 }));
bad('map', 'ponto-invalido', 'map', 'kind desconhecido', set(maps[0], { points: [{ x: 0, y: 0, kind: 'parede' }] }));

console.log('fixtures geradas em', outRoot);
