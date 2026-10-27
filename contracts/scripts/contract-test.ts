/**
 * Suíte de contrato executável contra QUALQUER base URL.
 *
 *   npm run contract:test -- --base-url http://localhost:8080 [opções]
 *
 * Opções
 *   --base-url <url>        Raiz do servidor (sem /api). Obrigatória.
 *   --auth-token <token>    Bearer de OPERADOR. Sem ele, nenhum cabeçalho é enviado
 *                           (serve a servidores em modo dev, como `MOCK_NO_AUTH=1`).
 *   --viewer-token <token>  Bearer de LEITOR: habilita os testes de papel (403).
 *   --admin-token <token>   Bearer de ADMIN: habilita os testes de force-close (somente admin).
 *   --internal-token <tok>  Credencial das rotas /internal/*.
 *   --device-secret <seg>   Segredo HMAC do dispositivo: habilita os testes /device/*.
 *   --device-id <id>        Dispositivo simulado (padrão RB-02).
 *   --allow-mutations       Habilita testes que ESCREVEM (rota, controle, importação,
 *                           reconhecimento de alerta, dispositivo). Deixa dados no servidor:
 *                           use um ambiente descartável.
 *   --expect-auth           Exige que chamadas sem token recebam 401 (padrão: ligado se há token).
 *   --origin <origin>       Origem do front para o teste de CORS (padrão http://localhost:3000).
 *   --no-seed               Pula asserções que dependem do seed carregado.
 *   --only <regex>          Roda só os testes cujo nome casa.
 *   --json                  Saída em JSON.
 *   --timeout <ms>          Timeout por requisição (padrão 10000).
 *
 * Dependem do SEED (`contracts/seed`): grupo `seed` (robôs RB-01..04, métricas,
 * grades, rota RT-0041) e o fluxo de dispositivo (usa RB-02 em `pista-2`).
 * Dependem de --allow-mutations: grupos `mutate` e `device`.
 * Dependem de --device-secret: grupo `device`.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ENDPOINTS,
  ERROR_HTTP_STATUS,
  ErrorEnvelopeSchema,
  POLL_MS,
  aggregateMetrics,
  getEndpoint,
  successEnvelope,
  translateRoute,
  type Alert,
  type EndpointId,
  type Heading,
  type LogEvent,
  type Mission,
  type RobotMap,
  type Robot,
  type DeviceSyncResponse,
} from '../src/index.js';
import { buildSignedHeaders } from '../src/signing.js';

// ------------------------------------------------------------------- args
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const cfg = {
  base: (opt('base-url') ?? '').replace(/\/$/, ''),
  token: opt('auth-token'),
  viewer: opt('viewer-token'),
  admin: opt('admin-token'),
  internal: opt('internal-token'),
  secret: opt('device-secret'),
  deviceId: opt('device-id') ?? 'RB-02',
  mutate: flag('allow-mutations'),
  expectAuth: flag('expect-auth') || Boolean(opt('auth-token')),
  origin: opt('origin') ?? 'http://localhost:3000',
  seed: !flag('no-seed'),
  only: opt('only') ? new RegExp(opt('only') as string, 'i') : null,
  json: flag('json'),
  timeout: Number(opt('timeout') ?? 10000),
};

if (!cfg.base) {
  console.error('Uso: npm run contract:test -- --base-url http://localhost:8080 [--auth-token T] [--device-secret S] [--allow-mutations]');
  process.exit(2);
}

// ----------------------------------------------------------------- seed
const seedDir = join(import.meta.dirname, '..', 'seed');
const seed = <T,>(n: string): T => JSON.parse(readFileSync(join(seedDir, `${n}.json`), 'utf8')) as T;
const seedMaps = seed<RobotMap[]>('maps');
const seedDevices = seed<Array<{ id: string; mapId: string; lastConfirmedHeading: Heading }>>('devices');
const mapFor = (robotId: string): RobotMap => {
  const d = seedDevices.find((x) => x.id === robotId)!;
  return seedMaps.find((m) => m.id === d.mapId)!;
};

// ------------------------------------------------------------ framework
type Tag = 'public' | 'auth' | 'seed' | 'read' | 'mutate' | 'device' | 'internal';
interface Test {
  name: string;
  tags: Tag[];
  fn: () => Promise<void>;
}
const tests: Test[] = [];
const test = (name: string, tags: Tag[], fn: () => Promise<void>) => tests.push({ name, tags, fn });

class Assertion extends Error {}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Assertion(msg);
}
function eq<T>(actual: T, expected: T, msg: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Assertion(`${msg}\n    esperado: ${JSON.stringify(expected)}\n    recebido: ${JSON.stringify(actual)}`);
  }
}

interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

async function http(
  method: string,
  path: string,
  o: { query?: Record<string, string | number | undefined>; body?: unknown; rawBody?: string; headers?: Record<string, string>; token?: string | null } = {}
): Promise<Res> {
  const url = new URL(cfg.base + path);
  for (const [k, v] of Object.entries(o.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  const token = o.token === undefined ? cfg.token : o.token;
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: string | undefined;
  if (o.rawBody !== undefined) body = o.rawBody;
  else if (o.body !== undefined) body = JSON.stringify(o.body);
  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cfg.timeout);
  try {
    const r = await fetch(url, { method, headers, body, signal: ctl.signal });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: r.status, headers: r.headers, text, json };
  } finally {
    clearTimeout(t);
  }
}

/** Valida status, envelope e schema de `data` do endpoint. Devolve `data`. */
function okData<T = any>(res: Res, id: EndpointId, status?: number): T {
  const ep = getEndpoint(id);
  const expected = status ? [status] : ep.okStatus;
  assert(expected.includes(res.status), `${id}: status ${res.status}, esperado ${expected.join('|')} — corpo: ${res.text.slice(0, 300)}`);
  const parsed = successEnvelope(ep.response).safeParse(res.json);
  assert(parsed.success, `${id}: envelope/dados fora do contrato — ${parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 4))}`);
  return parsed.data.data as T;
}

function errorIs(res: Res, status: number, code?: string) {
  assert(res.status === status, `status ${res.status}, esperado ${status} — corpo: ${res.text.slice(0, 300)}`);
  const parsed = ErrorEnvelopeSchema.safeParse(res.json);
  assert(parsed.success, `envelope de erro fora do contrato: ${res.text.slice(0, 300)}`);
  if (code) {
    eq(parsed.data.error, code as never, 'código de erro');
    eq(ERROR_HTTP_STATUS[parsed.data.error], status, 'status HTTP canônico do código');
  }
}

const idem = () => ({ 'Idempotency-Key': `ct-${randomBytes(6).toString('hex')}` });
const op = (method: string, path: string, o: Parameters<typeof http>[2] = {}) => http(method, path, o);

// ============================================================== PÚBLICO
test('health: envelope e schema', ['public'], async () => {
  okData(await http('GET', '/api/health', { token: null }), 'health');
});

test('rota inexistente devolve 404 com envelope de erro', ['public'], async () => {
  errorIs(await http('GET', '/api/nao-existe', { token: null }), 404);
});

test('CORS: preflight reflete a origem permitida e nunca usa curinga', ['public'], async () => {
  const r = await http('OPTIONS', '/api/robots', {
    token: null,
    headers: { Origin: cfg.origin, 'Access-Control-Request-Method': 'GET' },
  });
  assert(r.status === 204 || r.status === 200, `preflight devolveu ${r.status}`);
  const allow = r.headers.get('access-control-allow-origin');
  assert(allow === cfg.origin, `Access-Control-Allow-Origin = ${allow}, esperado ${cfg.origin}`);
  assert(allow !== '*', 'CORS com curinga não é aceito');
  const methods = r.headers.get('access-control-allow-methods') ?? '';
  for (const m of ['GET', 'POST', 'PATCH', 'OPTIONS']) assert(methods.includes(m), `método ${m} ausente em Allow-Methods`);
  const hdrs = (r.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  assert(hdrs.includes('content-type') && hdrs.includes('authorization') && hdrs.includes('idempotency-key'), `Allow-Headers incompleto: ${hdrs}`);
});

test('CORS: origem desconhecida não recebe Allow-Origin', ['public'], async () => {
  const r = await http('OPTIONS', '/api/robots', { token: null, headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  assert(r.headers.get('access-control-allow-origin') !== 'https://evil.example', 'origem não autorizada foi refletida');
});

// ================================================================ AUTH
test('sem token => 401 UNAUTHENTICATED', ['auth'], async () => {
  assert(cfg.expectAuth, 'servidor sem autenticação (use --expect-auth/--auth-token)');
  errorIs(await http('GET', '/api/robots', { token: null }), 401, 'UNAUTHENTICATED');
});
test('token inválido => 401', ['auth'], async () => {
  assert(cfg.expectAuth, 'servidor sem autenticação');
  errorIs(await http('GET', '/api/robots', { token: 'token-invalido' }), 401, 'UNAUTHENTICATED');
});
test('leitor lê mas não comanda (403 FORBIDDEN)', ['auth'], async () => {
  assert(cfg.viewer, 'sem --viewer-token');
  okData(await http('GET', '/api/robots', { token: cfg.viewer }), 'listRobots');
  errorIs(await http('POST', '/api/robots/RB-02/route/preview', { token: cfg.viewer, body: { waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } }), 403, 'FORBIDDEN');
  errorIs(await http('PATCH', '/api/alerts/alt-01/acknowledge', { token: cfg.viewer }), 403, 'FORBIDDEN');
});

test('position e force-close exigem papel: leitor 403; force-close só admin', ['auth'], async () => {
  assert(cfg.expectAuth, 'servidor sem autenticação');
  if (cfg.viewer) {
    errorIs(await http('POST', '/api/robots/RB-03/position', { token: cfg.viewer, body: { x: 0, y: 3, heading: 'N' } }), 403, 'FORBIDDEN');
    errorIs(await http('POST', '/api/missions/RF-0111/force-close', { token: cfg.viewer, headers: idem() }), 403, 'FORBIDDEN');
  }
  if (cfg.token) errorIs(await http('POST', '/api/missions/RF-0111/force-close', { token: cfg.token, headers: idem() }), 403, 'FORBIDDEN');
  errorIs(await http('POST', '/api/robots/RB-03/position', { token: null, body: { x: 0, y: 3, heading: 'N' } }), 401, 'UNAUTHENTICATED');
});

// ================================================================ LEITURA
let robots: Robot[] = [];
let missions: Mission[] = [];
let logs: LogEvent[] = [];
let alerts: Alert[] = [];

test('GET /robots: schema e frota do seed', ['read'], async () => {
  robots = okData<Robot[]>(await op('GET', '/api/robots'), 'listRobots');
  if (!cfg.seed) return;
  for (const id of ['RB-01', 'RB-02', 'RB-03', 'RB-04']) assert(robots.some((r) => r.id === id), `robô ${id} ausente`);
  const rb4 = robots.find((r) => r.id === 'RB-04')!;
  eq(rb4.status, 'offline', 'RB-04 offline');
  eq(rb4.batteryPercent, null, 'RB-04 não reporta bateria (null)');
});

test('GET /robots/:id: 200 e 404 com envelope', ['read'], async () => {
  const id = robots[0]?.id ?? 'RB-01';
  okData(await op('GET', `/api/robots/${id}`), 'getRobot');
  errorIs(await op('GET', '/api/robots/RB-NAO-EXISTE'), 404, 'NOT_FOUND');
});

test('GET /missions: schema; listas continuam arrays', ['read'], async () => {
  missions = okData<Mission[]>(await op('GET', '/api/missions', { query: { period: 'all' } }), 'listMissions');
  assert(Array.isArray(missions), 'lista deve ser array');
});

test('GET /logs: schema, mais recente primeiro', ['read'], async () => {
  logs = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { period: 'all' } }), 'listLogs');
  for (let i = 1; i < logs.length; i++) {
    assert(Date.parse(logs[i - 1]!.timestamp) >= Date.parse(logs[i]!.timestamp), `logs fora de ordem em ${i}`);
  }
});

test('GET /alerts: schema', ['read'], async () => {
  alerts = okData<Alert[]>(await op('GET', '/api/alerts'), 'listAlerts');
});

test('filtro robotId vale para missões, logs, alertas e métricas', ['read'], async () => {
  const rid = missions[0]?.robotId ?? 'RB-01';
  const m = okData<Mission[]>(await op('GET', '/api/missions', { query: { robotId: rid, period: 'all' } }), 'listMissions');
  assert(m.every((x) => x.robotId === rid), 'missão de outro robô na lista filtrada');
  const l = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { robotId: rid, period: 'all' } }), 'listLogs');
  assert(l.every((x) => x.robotId === rid), 'log de outro robô');
  const a = okData<Alert[]>(await op('GET', '/api/alerts', { query: { robotId: rid } }), 'listAlerts');
  assert(a.every((x) => x.robotId === rid), 'alerta de outro robô');
  const dm = okData<any>(await op('GET', '/api/dashboard/metrics', { query: { robotId: rid, period: 'all' } }), 'dashboardMetrics');
  eq(dm.totalMissions, m.length, 'totalMissions do robô = tamanho da lista');
});

test('filtros de status, severidade, tipo e missionId', ['read'], async () => {
  for (const status of ['completed', 'in_progress', 'aborted', 'failed'] as const) {
    const m = okData<Mission[]>(await op('GET', '/api/missions', { query: { status, period: 'all' } }), 'listMissions');
    assert(m.every((x) => x.status === status), `filtro status=${status} vazou outros`);
  }
  const sev = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { severity: 'warning', period: 'all' } }), 'listLogs');
  assert(sev.every((e) => e.severity === 'warning'), 'severity=warning vazou');
  const et = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { eventType: 'stop_preventive', period: 'all' } }), 'listLogs');
  assert(et.every((e) => e.eventType === 'stop_preventive'), 'eventType vazou');
  const withMission = logs.find((e) => e.missionId && e.missionId !== 'unassigned');
  if (withMission) {
    const mm = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { missionId: withMission.missionId, period: 'all' } }), 'listLogs');
    assert(mm.length > 0 && mm.every((e) => e.missionId === withMission.missionId), 'missionId vazou');
  }
  const un = okData<Alert[]>(await op('GET', '/api/alerts', { query: { status: 'unacknowledged' } }), 'listAlerts');
  assert(un.every((a) => !a.acknowledged), 'unacknowledged devolveu reconhecido');
  const ack = okData<Alert[]>(await op('GET', '/api/alerts', { query: { status: 'acknowledged' } }), 'listAlerts');
  assert(ack.every((a) => a.acknowledged), 'acknowledged devolveu pendente');
  // `all` equivale a omitido
  const all1 = okData<Mission[]>(await op('GET', '/api/missions', { query: { status: 'all', period: 'all' } }), 'listMissions');
  eq(all1.length, missions.length, 'status=all = sem filtro');
});

test('parâmetros inválidos => 400 INVALID_QUERY', ['read'], async () => {
  errorIs(await op('GET', '/api/missions', { query: { period: '90d' } }), 400, 'INVALID_QUERY');
  errorIs(await op('GET', '/api/missions', { query: { status: 'bogus' } }), 400, 'INVALID_QUERY');
  errorIs(await op('GET', '/api/logs', { query: { severity: 'fatal' } }), 400, 'INVALID_QUERY');
  errorIs(await op('GET', '/api/alerts', { query: { status: 'pending' } }), 400, 'INVALID_QUERY');
});

test('período customizado: limite final EXCLUSIVO [start, end)', ['read'], async () => {
  assert(logs.length > 0, 'sem logs');
  const t0 = logs[0]!.timestamp;
  const ms = Date.parse(t0);
  const empty = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { period: 'custom', startDate: t0, endDate: t0 } }), 'listLogs');
  eq(empty.length, 0, '[t, t) deve ser vazio');
  const one = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { period: 'custom', startDate: t0, endDate: new Date(ms + 1).toISOString() } }), 'listLogs');
  assert(one.some((e) => e.id === logs[0]!.id), '[t, t+1ms) deve conter o evento em t');
  const before = okData<LogEvent[]>(await op('GET', '/api/logs', { query: { period: 'custom', startDate: new Date(ms - 1000).toISOString(), endDate: t0 } }), 'listLogs');
  assert(!before.some((e) => e.id === logs[0]!.id), 'o limite final não pode incluir o evento em endDate');
});

test('paginação opcional: limit/cursor sem mudar o formato (array)', ['read'], async () => {
  if (missions.length < 3) return;
  const page1 = await op('GET', '/api/missions', { query: { limit: 2, period: 'all' } });
  const d1 = okData<Mission[]>(page1, 'listMissions');
  assert(d1.length <= 2, 'limit=2 devolveu mais de 2');
  const cursor = page1.json.nextCursor as string | undefined;
  assert(cursor, 'faltou nextCursor com mais registros disponíveis');
  const d2 = okData<Mission[]>(await op('GET', '/api/missions', { query: { limit: 2, cursor, period: 'all' } }), 'listMissions');
  assert(d2.every((m) => !d1.some((x) => x.id === m.id)), 'página 2 repete itens da página 1');
  errorIs(await op('GET', '/api/missions', { query: { limit: 9999 } }), 400, 'INVALID_QUERY');
});

test('GET /missions/:id: linha do tempo e 404', ['read'], async () => {
  const withEvents = missions.find((m) => m.eventCount > 0) ?? missions[0];
  assert(withEvents, 'sem missões');
  const m = okData<Mission>(await op('GET', `/api/missions/${withEvents.id}`), 'getMission');
  assert(Array.isArray(m.events), 'detalhe deve trazer events');
  assert(m.events!.every((e) => e.missionId === m.id), 'evento de outra missão na linha do tempo');
  if (cfg.seed) eq(m.events!.length, m.eventCount, 'eventCount = tamanho da linha do tempo');
  errorIs(await op('GET', '/api/missions/RF-NAO-EXISTE'), 404, 'NOT_FOUND');
});

test('métricas: invariantes e consistência com as listas (period=all)', ['read'], async () => {
  const fm = okData<any>(await op('GET', '/api/fleet/metrics', { query: { period: 'all' } }), 'fleetMetrics');
  eq(fm.totalStops, fm.presenceStops + fm.otherStops + fm.unknownStops, 'totalStops = presença + outras + desconhecidas');
  assert(fm.completionRate >= 0 && fm.completionRate <= 100, 'completionRate fora de 0–100 (é percentual, não fração)');
  eq(fm.totalMissions, missions.length, 'totalMissions = tamanho de /missions');
  eq(fm.perRobot.length, fm.totalRobots, 'perRobot tem uma entrada por robô, inclusive sem missões');
  eq(fm.perRobot.reduce((s: number, r: any) => s + r.totalMissions, 0), fm.totalMissions, 'soma perRobot = total');
  eq(fm.onlineRobots + fm.offlineRobots + fm.errorRobots <= fm.totalRobots, true, 'contagens de robôs somam no máximo o total');

  const local = aggregateMetrics(missions, logs, alerts);
  for (const k of ['totalMissions', 'completedMissions', 'inProgressMissions', 'failedMissions', 'abortedMissions', 'indeterminateMissions', 'avgDurationSeconds', 'medianDurationSeconds', 'minDurationSeconds', 'maxDurationSeconds', 'totalStops', 'presenceStops', 'otherStops', 'unknownStops', 'completionRate', 'activeAlertsCount', 'totalErrors'] as const) {
    eq((fm as any)[k], (local as any)[k], `métrica ${k} difere do cálculo de referência sobre os registros`);
  }
  const dm = okData<any>(await op('GET', '/api/dashboard/metrics', { query: { period: 'all' } }), 'dashboardMetrics');
  eq(dm.totalMissions, fm.totalMissions, '/dashboard/metrics sem robotId = frota');
});


test('GET /robots/:id/events: diagnóstico sem missão', ['read'], async () => {
  const id = robots[0]?.id ?? 'RB-01';
  okData(await op('GET', `/api/robots/${id}/events`), 'getRobotEvents');
  errorIs(await op('GET', '/api/robots/RB-NAO-EXISTE/events'), 404, 'NOT_FOUND');
});

// ================================================================ MALHA E ROTA
test('GET /robots/:id/grid: seed da pista-1 e 404', ['read', 'seed'], async () => {
  assert(cfg.seed, 'sem seed');
  const g = okData<any>(await op('GET', '/api/robots/RB-01/grid'), 'getGrid');
  eq([g.cols, g.rows], [5, 4], 'RB-01 opera numa malha 5x4');
  assert(g.points.some((p: any) => p.kind === 'station' && p.label === 'carga' && p.x === 0 && p.y === 0), 'estação "carga" em (0,0)');
  assert(g.points.some((p: any) => p.kind === 'blocked' && p.x === 2 && p.y === 2), 'bloqueio em (2,2)');
  errorIs(await op('GET', '/api/robots/RB-NAO-EXISTE/grid'), 404, 'NOT_FOUND');
});

test('GET /robots/:id/route: rota do seed (200) e ausência (404, situação normal)', ['read', 'seed'], async () => {
  assert(cfg.seed, 'sem seed');
  const r = okData<any>(await op('GET', '/api/robots/RB-01/route'), 'getRoute');
  eq(r.routeId, 'RT-0041', 'rota carregada no RB-01');
  eq(r.currentWaypointIndex, 3, 'índice do último waypoint alcançado');
  errorIs(await op('GET', '/api/robots/RB-04/route'), 404, 'NOT_FOUND');
});

const L = [{ x: 4, y: 0 }, { x: 3, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }];

test('prévia: o servidor traduz IGUAL à biblioteca (4 rumos e erros)', ['read', 'seed'], async () => {
  assert(cfg.seed, 'sem seed');
  const map = mapFor('RB-02');
  const cases: Array<{ name: string; waypoints: Array<{ x: number; y: number }>; heading: Heading }> = [
    { name: 'L partindo de W', waypoints: L, heading: 'W' },
    { name: 'L partindo de N', waypoints: L, heading: 'N' },
    { name: 'L partindo de E (exige ré: T,T,D)', waypoints: L, heading: 'E' },
    { name: 'L partindo de S', waypoints: L, heading: 'S' },
    { name: 'diagonal', waypoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], heading: 'E' },
    { name: 'salto', waypoints: [{ x: 4, y: 0 }, { x: 2, y: 0 }], heading: 'W' },
    { name: 'nó bloqueado', waypoints: [{ x: 1, y: 1 }, { x: 1, y: 2 }], heading: 'S' },
    { name: 'fora da malha', waypoints: [{ x: 4, y: 3 }, { x: 5, y: 3 }], heading: 'E' },
    { name: 'repetido', waypoints: [{ x: 0, y: 0 }, { x: 0, y: 0 }], heading: 'E' },
  ];
  for (const c of cases) {
    const res = await op('POST', '/api/robots/RB-02/route/preview', { body: { waypoints: c.waypoints, initialHeading: c.heading } });
    const data = okData<any>(res, 'previewRoute');
    const local = translateRoute(map, c.waypoints, c.heading);
    eq(data.executable, local.executable, `${c.name}: executable`);
    eq(data.actions, local.actions, `${c.name}: ações`);
    eq(data.finalHeading, local.finalHeading, `${c.name}: rumo final`);
    eq(data.errors.map((e: any) => e.code).sort(), local.errors.map((e) => e.code).sort(), `${c.name}: códigos de erro`);
    eq(data.expectedNodes, local.expectedNodes, `${c.name}: nós esperados`);
  }
});

test('prévia: corpo inválido => 400; robô inexistente => 404', ['read'], async () => {
  errorIs(await op('POST', '/api/robots/RB-02/route/preview', { body: { initialHeading: 'E' } }), 400, 'INVALID_BODY');
  errorIs(await op('POST', '/api/robots/RB-02/route/preview', { body: { waypoints: [{ x: 0, y: 0 }], initialHeading: 'X' } }), 400, 'INVALID_BODY');
  errorIs(await op('POST', '/api/robots/RB-NAO-EXISTE/route/preview', { body: { waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }], initialHeading: 'E' } }), 404, 'NOT_FOUND');
});

// ================================================================ INTERNO
test('/internal/* sem credencial é recusado (nunca 200)', ['internal'], async () => {
  const r = await http('POST', '/internal/offline-check', { token: null });
  assert(r.status === 401 || r.status === 403, `status ${r.status}, esperado 401/403`);
  const r2 = await http('POST', '/internal/events', { token: null, body: { message: { data: 'e30=', messageId: '1' }, subscription: 's' } });
  assert(r2.status === 401 || r2.status === 403, `status ${r2.status}, esperado 401/403`);
  // um token de OPERADOR não vale como credencial interna
  if (cfg.token) {
    const r3 = await http('POST', '/internal/offline-check', { token: cfg.token });
    assert(r3.status === 401 || r3.status === 403, 'token de operador aceito em /internal');
  }
});

test('/internal/offline-check com credencial interna', ['internal'], async () => {
  assert(cfg.internal, 'sem --internal-token');
  okData(await http('POST', '/internal/offline-check', { token: cfg.internal }), 'internalOfflineCheck');
});

// ============================================================ DISPOSITIVO
class Sim {
  sessionId = `boot-${randomBytes(3).toString('hex')}`;
  reqSeq = 0;
  evSeq = 0;
  constructor(public id: string, public secret: string) {}

  sign(method: string, path: string, body = '', over: Partial<{ ts: number; seq: number; secret: string }> = {}) {
    const seq = over.seq ?? ++this.reqSeq;
    return buildSignedHeaders(over.secret ?? this.secret, { deviceId: this.id, sessionId: this.sessionId }, {
      method,
      path,
      timestamp: over.ts ?? Math.floor(Date.now() / 1000),
      sequence: seq,
      body,
    });
  }

  call(method: string, path: string, body?: unknown, over: Parameters<Sim['sign']>[3] = {}) {
    const raw = body === undefined ? '' : JSON.stringify(body);
    return http(method, path, { token: null, rawBody: body === undefined ? undefined : raw, headers: this.sign(method, path, raw, over) });
  }

  base(type: string) {
    const sequence = ++this.evSeq;
    return { v: 1, type, messageId: `evt-${sequence}`, deviceId: this.id, sessionId: this.sessionId, sequence, uptimeMs: sequence * 100 };
  }

  hello() {
    return this.call('POST', '/device/hello', {
      ...this.base('hello'),
      firmwareVersion: '1.4.2',
      protocolVersion: 1,
      capabilities: { supportsReverse: false, maxActions: 64, maxMessageBytes: 4096 },
      state: 'ready',
    });
  }
  poll() {
    return this.call('GET', '/device/poll');
  }
  events(list: unknown[]) {
    return this.call('POST', '/device/events', { events: list });
  }
}

let sim: Sim | null = null;
const needDevice = () => {
  assert(cfg.secret, 'sem --device-secret');
  assert(cfg.mutate, 'exige --allow-mutations');
  sim ??= new Sim(cfg.deviceId, cfg.secret as string);
  return sim;
};

test('device: hello abre a sessão (schema, limites)', ['device'], async () => {
  const s = needDevice();
  const d = okData<any>(await s.hello(), 'deviceHello');
  eq(d.sessionId, s.sessionId, 'sessionId ecoado');
  assert(d.nextPollMs >= POLL_MS.min && d.nextPollMs <= POLL_MS.max, 'nextPollMs fora dos limites');
  eq(d.limits.maxActions, 64, 'limites anunciados');
  assert(d.ackedSequence >= 1, 'hello (sequence 1) deve ser confirmado');
});

test('device: assinatura inválida, relógio fora e replay são recusados', ['device'], async () => {
  const s = needDevice();
  errorIs(await s.call('GET', '/device/poll', undefined, { secret: 'segredo-errado' }), 401, 'SIGNATURE_INVALID');
  errorIs(await s.call('GET', '/device/poll', undefined, { ts: Math.floor(Date.now() / 1000) - 3600 }), 401, 'CLOCK_SKEW');
  const seq = ++s.reqSeq;
  okData(await s.call('GET', '/device/poll', undefined, { seq }), 'devicePoll');
  errorIs(await s.call('GET', '/device/poll', undefined, { seq }), 401, 'REPLAY_DETECTED');
  const bare = await http('GET', '/device/poll', { token: null });
  assert(bare.status === 401, `sem cabeçalhos: status ${bare.status}, esperado 401`);
});

test('device: corpo acima de 4096 bytes => 413', ['device'], async () => {
  const s = needDevice();
  const saved = s.evSeq; // a sequência do evento recusado não deve criar lacuna
  const big = { events: [{ ...s.base('fault'), code: 'X', message: 'y'.repeat(5000), severity: 'error' }] };
  const r = await s.call('POST', '/device/events', big);
  s.evSeq = saved;
  eq(r.status, 413, 'status');
});

test('device: sessão desconhecida em poll => 409 CONFLICT_SESSION', ['device'], async () => {
  const s = needDevice();
  const other = new Sim(s.id, s.secret);
  errorIs(await other.poll(), 409, 'CONFLICT_SESSION');
});

test('device: poll em repouso devolve intervalo longo e nenhum comando', ['device'], async () => {
  const s = needDevice();
  const d = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  eq(d.commands.length, 0, 'sem comandos pendentes');
  assert(d.nextPollMs >= POLL_MS.idle / 2, `em repouso o poll deve ser longo (recebido ${d.nextPollMs} ms)`);
});

test('device: status do dispositivo reflete a sessão', ['device'], async () => {
  const s = needDevice();
  const st = okData<any>(await op('GET', `/api/devices/${s.id}/status`), 'getDeviceStatus');
  eq(st.sessionId, s.sessionId, 'sessionId no status');
  eq(st.connection, 'online', 'conexão');
  assert(st.dataAgeMs !== null && st.dataAgeMs < 15000, 'idade do dado exibida');
});

test('device: ackedSequence conta só eventos críticos (telemetria não avança o ack)', ['device'], async () => {
  const s = needDevice();
  const before = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll').ackedSequence;
  const tele = { ...s.base('telemetry'), state: 'ready', line: [0, 1, 0], distanceCm: 50, distanceValid: true, distanceAgeMs: 20 };
  const d1 = okData<DeviceSyncResponse>(await s.events([tele]), 'deviceEvents');
  eq(d1.ackedSequence, before, 'telemetria não avança o ackedSequence');
  // um crítico DEPOIS de uma telemetria "perdida": o ack salta para ele (não exige contiguidade)
  const fault = { ...s.base('fault'), code: 'CT_PROBE', message: 'sonda do teste de contrato', severity: 'warning' };
  const d2 = okData<DeviceSyncResponse>(await s.events([fault]), 'deviceEvents');
  eq(d2.ackedSequence, fault.sequence, 'o crítico é confirmado mesmo com lacuna de telemetria antes');
  // retransmissão do mesmo crítico: idempotente e continua confirmado
  const d3 = okData<DeviceSyncResponse>(await s.events([fault]), 'deviceEvents');
  eq(d3.ackedSequence, fault.sequence, 'retransmissão mantém o ack');
});

// ---------------------------------------------------------- fluxo ponta a ponta
let missionId = '';
let uncertainMissionId = '';
let uncertainSim: Sim | null = null;
let loadCmdId = '';
let startCmdId = '';
const routeKey = idem();
const routeBody = { waypoints: L, initialHeading: 'W' as const };

test('rota: sem Idempotency-Key => 400 IDEMPOTENCY_KEY_REQUIRED', ['mutate'], async () => {
  assert(cfg.mutate, 'exige --allow-mutations');
  errorIs(await op('POST', `/api/robots/${cfg.deviceId}/route`, { body: routeBody }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('rota inválida => 422 ROUTE_INVALID; ré sem suporte => 422 CAPABILITY_UNSUPPORTED', ['mutate'], async () => {
  assert(cfg.mutate, 'exige --allow-mutations');
  errorIs(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: { waypoints: [{ x: 4, y: 0 }], initialHeading: 'W' } }), 422, 'ROUTE_INVALID');
  errorIs(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: { waypoints: [{ x: 4, y: 0 }, { x: 2, y: 0 }], initialHeading: 'W' } }), 422, 'ROUTE_INVALID');
  errorIs(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: { waypoints: L, initialHeading: 'E' } }), 422, 'CAPABILITY_UNSUPPORTED');
  errorIs(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: { initialHeading: 'W' } }), 400, 'INVALID_BODY');
});

test('rota para robô offline: HTTP 200 com accepted:false (recusa de negócio)', ['mutate', 'seed'], async () => {
  assert(cfg.mutate && cfg.seed, 'exige --allow-mutations e seed');
  const d = okData<any>(await op('POST', '/api/robots/RB-04/route', { headers: idem(), body: { waypoints: [{ x: 0, y: 0 }, { x: 1, y: 0 }], initialHeading: 'E' } }), 'submitRoute', 200);
  eq(d.accepted, false, 'accepted');
  assert(typeof d.message === 'string' && d.message.length > 0, 'motivo da recusa em message');
});

test('rota para robô inexistente => 404', ['mutate'], async () => {
  assert(cfg.mutate, 'exige --allow-mutations');
  errorIs(await op('POST', '/api/robots/RB-NAO-EXISTE/route', { headers: idem(), body: routeBody }), 404, 'NOT_FOUND');
});

test('rota válida cria a missão e registra load_route (não inicia o movimento)', ['device'], async () => {
  needDevice();
  const res = await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: routeKey, body: routeBody });
  const d = okData<any>(res, 'submitRoute');
  eq(d.accepted, true, `aceita (${d.message ?? ''})`);
  assert(d.missionId && d.commandId, 'missionId e commandId esperados');
  missionId = d.missionId;
  loadCmdId = d.commandId;
  const exec = okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution');
  assert(['queued', 'loading'].includes(exec.state), `estado inicial ${exec.state}`);
  eq(exec.completedActions, 0, 'nada concluído ainda');
  const cmd = okData<any>(await op('GET', `/api/commands/${loadCmdId}`), 'getCommand');
  eq(cmd.type, 'load_route', 'tipo do comando');
  eq(cmd.status, 'pending', 'pendente até o dispositivo aceitar');
  const pub = okData<Mission>(await op('GET', `/api/missions/${missionId}`), 'getMission');
  eq(pub.status, 'in_progress', 'projeção pública dos estados ativos');
});

test('idempotência: mesma chave e corpo => mesmo resultado; corpo diferente => 409', ['device'], async () => {
  needDevice();
  const again = okData<any>(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: routeKey, body: routeBody }), 'submitRoute');
  eq(again.missionId, missionId, 'mesma missão');
  eq(again.commandId, loadCmdId, 'mesmo comando');
  errorIs(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: routeKey, body: { ...routeBody, waypoints: L.slice(0, 3) } }), 409, 'CONFLICT_IDEMPOTENCY');
});

test('exclusão por dispositivo: segunda rota com missão ativa => accepted:false', ['device'], async () => {
  needDevice();
  const d = okData<any>(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: routeBody }), 'submitRoute', 200);
  eq(d.accepted, false, 'não pode haver duas missões ativas');
});

test('GET /robots/:id/route reflete a rota e o estado detalhado', ['device'], async () => {
  needDevice();
  const r = okData<any>(await op('GET', `/api/robots/${cfg.deviceId}/route`), 'getRoute');
  eq(r.missionId, missionId, 'rota ligada à missão');
  eq(r.waypoints, L, 'waypoints');
  eq(r.actions, ['F', 'F', 'E'], 'ações calculadas para W: F, F, E (esquerda)');
});

test('poll entrega load_route igual à tradução da biblioteca', ['device'], async () => {
  const s = needDevice();
  const d = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  assert(d.nextPollMs <= POLL_MS.activeMission * 2, `com missão ativa o poll deve ser curto (recebido ${d.nextPollMs} ms)`);
  const c: any = d.commands.find((x) => x.type === 'load_route');
  assert(c, 'load_route não entregue');
  eq(c.messageId, loadCmdId, 'messageId = commandId');
  const local = translateRoute(mapFor(cfg.deviceId), L, 'W');
  eq(c.actions, local.actions, 'ações');
  eq(c.expectedNodes, local.expectedNodes, 'nós esperados');
  eq(c.startNode, '4,0', 'nó inicial');
  eq(c.initialHeading, 'W', 'rumo inicial');
  assert(c.validForMs > 0, 'validForMs relativo');
});

test('ack do load_route: comando aceito, missão pronta, eventos confirmados', ['device'], async () => {
  const s = needDevice();
  const d = okData<DeviceSyncResponse>(await s.events([{ ...s.base('ack'), replyTo: loadCmdId, result: 'accepted', missionId, routeRevision: 1 }]), 'deviceEvents');
  assert(d.ackedSequence >= s.evSeq, `ackedSequence ${d.ackedSequence} < ${s.evSeq}`);
  eq(okData<any>(await op('GET', `/api/commands/${loadCmdId}`), 'getCommand').status, 'accepted', 'comando aceito');
  eq(okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution').state, 'ready', 'missão pronta, motores parados');
});

test('start: sessão divergente => 409 CONFLICT_SESSION; válido => 202 e idempotente', ['device'], async () => {
  const s = needDevice();
  errorIs(await op('POST', `/api/missions/${missionId}/start`, { headers: idem(), body: { sessionId: 'boot-antigo' } }), 409, 'CONFLICT_SESSION');
  const key = idem();
  const r1 = await op('POST', `/api/missions/${missionId}/start`, { headers: key, body: { sessionId: s.sessionId } });
  const a = okData<any>(r1, 'startMission', 202);
  eq(a.status, 'pending', 'pendente até o ESP32 confirmar');
  startCmdId = a.commandId;
  const r2 = okData<any>(await op('POST', `/api/missions/${missionId}/start`, { headers: key, body: { sessionId: s.sessionId } }), 'startMission', 202);
  eq(r2.commandId, startCmdId, 'mesma chave => mesmo comando');
  errorIs(await op('POST', `/api/missions/${missionId}/start`, { headers: idem(), body: {} }), 409, 'CONFLICT_STATE');
  errorIs(await op('POST', `/api/missions/${missionId}/start`, { body: {} }), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  // pedido de start não muda o estado até o ESP32 confirmar
  eq(okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution').state, 'ready', 'ainda ready');
});

test('ack do start: missão em execução', ['device'], async () => {
  const s = needDevice();
  const p = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  assert(p.commands.some((c) => c.type === 'start' && c.messageId === startCmdId), 'start não entregue');
  okData(await s.events([{ ...s.base('ack'), replyTo: startCmdId, result: 'accepted', missionId, routeRevision: 1 }]), 'deviceEvents');
  eq(okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution').state, 'running', 'running');
});

test('progresso: conclusão duplicada não avança; posição só muda com confirmação', ['device'], async () => {
  const s = needDevice();
  const done0 = { ...s.base('action_completed'), missionId, routeRevision: 1, actionIndex: 0, expectedNode: '3,0' };
  okData(await s.events([{ ...s.base('action_started'), missionId, routeRevision: 1, actionIndex: 0, command: 'F' }, done0]), 'deviceEvents');
  let ex = okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution');
  eq(ex.completedActions, 1, 'uma ação concluída');
  eq(ex.lastConfirmedNode, '3,0', 'último nó confirmado');
  eq(ex.expectedNode, '2,0', 'próximo nó esperado');
  eq(ex.atNode, false, 'em deslocamento: atNode=false');
  // reenvio do MESMO lote (retransmissão): idempotente
  const before = okData<Mission>(await op('GET', `/api/missions/${missionId}`), 'getMission').eventCount;
  const dup = okData<DeviceSyncResponse>(await s.events([done0]), 'deviceEvents');
  assert(dup.ackedSequence >= done0.sequence, 'duplicata ainda deve ser confirmada');
  ex = okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution');
  eq(ex.completedActions, 1, 'duplicata não altera a posição');
  eq(okData<Mission>(await op('GET', `/api/missions/${missionId}`), 'getMission').eventCount, before, 'duplicata não gera evento');
  eq(okData<any>(await op('GET', `/api/robots/${cfg.deviceId}`), 'getRobot').currentPoint, '3,0', 'currentPoint do robô');
});

let blockId = '';
test('bloqueio por obstáculo: uma parada por transição, não por amostra', ['device'], async () => {
  const s = needDevice();
  blockId = `block-${randomBytes(2).toString('hex')}`;
  const tele = () => ({ ...s.base('telemetry'), state: 'blocked', missionId, routeRevision: 1, actionIndex: 1, line: [0, 1, 0], distanceCm: 18.2, distanceValid: true, distanceAgeMs: 25, blockId, blockReasons: ['obstacle'] });
  okData(await s.events([{ ...s.base('block_started'), missionId, blockId, reasons: ['obstacle'], distanceCm: 18.2, actionIndex: 1 }, tele(), tele(), tele()]), 'deviceEvents');
  const ex = okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution');
  eq(ex.state, 'blocked', 'blocked');
  eq(ex.blockId, blockId, 'bloqueio exibido');
  const m = okData<Mission>(await op('GET', `/api/missions/${missionId}`), 'getMission');
  eq(m.stopCount, 1, 'stopCount conta a transição, não as 3 telemetrias');
  eq(m.presenceStopCount, 1, 'parada por presença');
  eq(m.status, 'in_progress', 'projeção pública');
  eq(m.events!.filter((e) => e.eventType === 'stop_preventive').length, 1, 'um stop_preventive');
  assert(m.events!.some((e) => e.eventType === 'presence_detected'), 'presence_detected');
  const st = okData<any>(await op('GET', `/api/devices/${s.id}/status`), 'getDeviceStatus');
  eq(st.sensors.distanceCm, 18.2, 'sensores no status');
});

test('resume: bloqueio antigo => 409 STALE_BLOCK; correto => 202 e só vale após o ack', ['device'], async () => {
  const s = needDevice();
  errorIs(await op('POST', `/api/missions/${missionId}/resume`, { headers: idem(), body: { blockId: 'block-antigo' } }), 409, 'STALE_BLOCK');
  errorIs(await op('POST', `/api/missions/${missionId}/resume`, { headers: idem(), body: {} }), 400, 'INVALID_BODY');
  const a = okData<any>(await op('POST', `/api/missions/${missionId}/resume`, { headers: idem(), body: { blockId, sessionId: s.sessionId } }), 'resumeMission', 202);
  eq(okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution').state, 'blocked', 'segue bloqueada até o ack');
  const p = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  const c: any = p.commands.find((x) => x.type === 'resume');
  assert(c && c.blockId === blockId, 'resume entregue com o blockId');
  okData(await s.events([{ ...s.base('block_cleared'), missionId, blockId }, { ...s.base('ack'), replyTo: a.commandId, result: 'accepted', missionId, routeRevision: 1 }]), 'deviceEvents');
  eq(okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution').state, 'running', 'retomada efetiva');
  const m = okData<Mission>(await op('GET', `/api/missions/${missionId}`), 'getMission');
  assert(m.events!.some((e) => e.eventType === 'resume'), 'evento resume só após aceitação');
});

test('conclusão: última chegada + mission_completed encerram a missão', ['device'], async () => {
  const s = needDevice();
  okData(await s.events([
    { ...s.base('action_completed'), missionId, routeRevision: 1, actionIndex: 1, expectedNode: '2,0' },
    { ...s.base('action_completed'), missionId, routeRevision: 1, actionIndex: 2, expectedNode: '2,1' },
    { ...s.base('mission_completed'), missionId, routeRevision: 1, completedActions: 3 },
  ]), 'deviceEvents');
  const ex = okData<any>(await op('GET', `/api/missions/${missionId}/execution`), 'getExecution');
  eq(ex.state, 'completed', 'completed');
  eq(ex.actionIndex, null, 'actionIndex null ao concluir a fila');
  eq(ex.completedActions, 3, 'três ações');
  const m = okData<Mission>(await op('GET', `/api/missions/${missionId}`), 'getMission');
  eq(m.status, 'completed', 'status público');
  assert(m.endedAt && m.durationSeconds !== null, 'endedAt e duração conhecidos');
  const types = m.events!.map((e) => e.eventType);
  assert(types.includes('destination_reached') && types.includes('mission_end'), 'destination_reached e mission_end');
  eq(okData<any>(await op('GET', `/api/robots/${cfg.deviceId}/route`), 'getRoute').status, 'completed', 'rota concluída');
  eq(okData<any>(await op('GET', `/api/robots/${cfg.deviceId}`), 'getRobot').currentPoint, '2,1', 'robô no destino');
});

test('salto de índice => reconciliação (uncertain/indeterminate), nunca conclusão presumida', ['device'], async () => {
  const s = needDevice();
  const key = idem();
  const sub = okData<any>(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: key, body: { waypoints: [{ x: 2, y: 1 }, { x: 2, y: 0 }, { x: 3, y: 0 }, { x: 4, y: 0 }], initialHeading: 'N' } }), 'submitRoute');
  eq(sub.accepted, true, `segunda missão aceita (${sub.message ?? ''})`);
  const mid = sub.missionId as string;
  const p = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  const load = p.commands.find((c) => c.type === 'load_route')!;
  okData(await s.events([{ ...s.base('ack'), replyTo: load.messageId, result: 'accepted', missionId: mid, routeRevision: 1 }]), 'deviceEvents');
  const st = okData<any>(await op('POST', `/api/missions/${mid}/start`, { headers: idem(), body: {} }), 'startMission', 202);
  await s.poll();
  okData(await s.events([{ ...s.base('ack'), replyTo: st.commandId, result: 'accepted', missionId: mid, routeRevision: 1 }]), 'deviceEvents');
  const skip = okData<DeviceSyncResponse>(await s.events([{ ...s.base('action_completed'), missionId: mid, routeRevision: 1, actionIndex: 2, expectedNode: '4,0' }]), 'deviceEvents');
  eq(skip.resync, true, 'servidor pede snapshot');
  const ex = okData<any>(await op('GET', `/api/missions/${mid}/execution`), 'getExecution');
  eq(ex.state, 'uncertain', 'uncertain');
  eq(ex.completedActions, 0, 'não presume progresso');
  eq(ex.positionConfidence, 'unknown', 'posição incerta');
  eq(okData<Mission>(await op('GET', `/api/missions/${mid}`), 'getMission').status, 'indeterminate', 'projeção pública');
  // incerta mantém o dispositivo reservado
  const again = okData<any>(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: routeBody }), 'submitRoute', 200);
  eq(again.accepted, false, 'missão incerta mantém a reserva');
  // limpeza: abort explícito, confirmado pelo dispositivo
  const ab = okData<any>(await op('POST', `/api/missions/${mid}/abort`, { headers: idem(), body: {} }), 'abortMission', 202);
  const p2 = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  assert(p2.commands.some((c) => c.type === 'abort'), 'abort entregue');
  okData(await s.events([{ ...s.base('ack'), replyTo: ab.commandId, result: 'accepted', missionId: mid, routeRevision: 1 }]), 'deviceEvents');
  eq(okData<any>(await op('GET', `/api/missions/${mid}/execution`), 'getExecution').state, 'aborted', 'aborted após confirmação');
});

test('comando vencido/rejeitado não deixa pendência: reject do dispositivo', ['device'], async () => {
  const s = needDevice();
  const sub = okData<any>(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: routeBody }), 'submitRoute');
  eq(sub.accepted, true, 'aceita');
  await s.poll();
  okData(await s.events([{ ...s.base('reject'), replyTo: sub.commandId, reason: 'QUEUE_TOO_LARGE' }]), 'deviceEvents');
  eq(okData<any>(await op('GET', `/api/commands/${sub.commandId}`), 'getCommand').status, 'rejected', 'rejected');
  eq(okData<any>(await op('GET', `/api/missions/${sub.missionId}/execution`), 'getExecution').state, 'failed', 'fila recusada => failed');
});

test('hello após reboot: missão em andamento vira incerta, sem retomada automática', ['device'], async () => {
  const s = needDevice();
  // prepara uma missão running
  const sub = okData<any>(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: routeBody }), 'submitRoute');
  eq(sub.accepted, true, 'aceita');
  const p = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  const load = p.commands.find((c) => c.type === 'load_route')!;
  okData(await s.events([{ ...s.base('ack'), replyTo: load.messageId, result: 'accepted', missionId: sub.missionId, routeRevision: 1 }]), 'deviceEvents');
  const st = okData<any>(await op('POST', `/api/missions/${sub.missionId}/start`, { headers: idem(), body: {} }), 'startMission', 202);
  await s.poll();
  okData(await s.events([{ ...s.base('ack'), replyTo: st.commandId, result: 'accepted', missionId: sub.missionId, routeRevision: 1 }]), 'deviceEvents');
  // reboot: nova sessão
  const rebooted = new Sim(s.id, s.secret);
  sim = rebooted;
  const h = okData<any>(await rebooted.hello(), 'deviceHello');
  eq(h.reconcileRequired, true, 'reconciliação exigida');
  const ex = okData<any>(await op('GET', `/api/missions/${sub.missionId}/execution`), 'getExecution');
  eq(ex.state, 'uncertain', 'uncertain após boot');
  const poll = okData<DeviceSyncResponse>(await rebooted.poll(), 'devicePoll');
  assert(!poll.commands.some((c) => c.type === 'start' || c.type === 'resume'), 'nenhum start/resume automático após o boot');
  uncertainMissionId = sub.missionId; // encerrada no teste seguinte
  uncertainSim = rebooted;
});

test('missão incerta mantém a reserva e se encerra: force-close (admin) ou abort confirmado', ['device'], async () => {
  needDevice();
  assert(uncertainMissionId && uncertainSim, 'depende do teste de reboot');
  const mid = uncertainMissionId;
  const again = okData<any>(await op('POST', `/api/robots/${cfg.deviceId}/route`, { headers: idem(), body: routeBody }), 'submitRoute', 200);
  eq(again.accepted, false, 'missão incerta mantém a reserva do dispositivo');

  if (cfg.admin) {
    // somente admin; outro papel recebe 403 (se o servidor tem autenticação)
    if (cfg.expectAuth && cfg.token) errorIs(await http('POST', `/api/missions/${mid}/force-close`, { token: cfg.token, headers: idem() }), 403, 'FORBIDDEN');
    errorIs(await http('POST', '/api/missions/RF-NAO-EXISTE/force-close', { token: cfg.admin, headers: idem() }), 404, 'NOT_FOUND');
    errorIs(await http('POST', `/api/missions/${missionId}/force-close`, { token: cfg.admin, headers: idem() }), 409, 'CONFLICT_STATE'); // concluída
    const d = okData<any>(await http('POST', `/api/missions/${mid}/force-close`, { token: cfg.admin, headers: idem() }), 'forceCloseMission');
    eq([d.missionId, d.state], [mid, 'aborted'], 'resultado');
    const m = okData<Mission>(await op('GET', `/api/missions/${mid}`), 'getMission');
    eq(m.status, 'aborted', 'status público');
    eq(m.endedAt, undefined, 'sem endedAt: não há confirmação do dispositivo');
    eq(m.durationSeconds, null, 'durationSeconds null');
    eq(okData<any>(await op('GET', `/api/missions/${mid}/execution`), 'getExecution').state, 'aborted', 'estado aborted');
    // o encerramento forçado libera a reserva
    const robot = okData<Robot>(await op('GET', `/api/robots/${cfg.deviceId}`), 'getRobot');
    assert(!robot.currentMissionId, 'robô ainda reservado após force-close');
    errorIs(await http('POST', `/api/missions/${mid}/force-close`, { token: cfg.admin, headers: idem() }), 409, 'CONFLICT_STATE'); // já encerrada
    return;
  }

  const s = uncertainSim;
  const ab = okData<any>(await op('POST', `/api/missions/${mid}/abort`, { headers: idem(), body: {} }), 'abortMission', 202);
  const p2 = okData<DeviceSyncResponse>(await s.poll(), 'devicePoll');
  assert(p2.commands.some((c) => c.type === 'abort'), 'abort entregue na nova sessão');
  okData(await s.events([{ ...s.base('ack'), replyTo: ab.commandId, result: 'accepted', missionId: mid, routeRevision: 1 }]), 'deviceEvents');
  eq(okData<any>(await op('GET', `/api/missions/${mid}/execution`), 'getExecution').state, 'aborted', 'aborted');
});

// ============================================================ ESCRITA SIMPLES
test('POST /robots/:id/position: robô com missão ativa => 409 DEVICE_BUSY', ['mutate', 'seed'], async () => {
  assert(cfg.mutate && cfg.seed, 'exige --allow-mutations e seed intacto');
  errorIs(await op('POST', '/api/robots/RB-01/position', { body: { x: 0, y: 0, heading: 'E' } }), 409, 'DEVICE_BUSY');
});

test('POST /robots/:id/position: valida corpo, malha e bloqueio; confirma a posição', ['mutate', 'seed'], async () => {
  assert(cfg.mutate && cfg.seed, 'exige --allow-mutations e seed');
  errorIs(await op('POST', '/api/robots/RB-03/position', { body: { x: 0, y: 3, heading: 'norte' } }), 400, 'INVALID_BODY');
  errorIs(await op('POST', '/api/robots/RB-03/position', { body: { x: 0, y: 3 } }), 400, 'INVALID_BODY');
  errorIs(await op('POST', '/api/robots/RB-03/position', { body: { x: 99, y: 99, heading: 'N' } }), 422, 'ROUTE_INVALID');
  errorIs(await op('POST', '/api/robots/RB-04/position', { body: { x: 1, y: 1, heading: 'N' } }), 422, 'ROUTE_INVALID'); // (1,1) bloqueado na pista-4
  errorIs(await op('POST', '/api/robots/RB-NAO-EXISTE/position', { body: { x: 0, y: 0, heading: 'N' } }), 404, 'NOT_FOUND');
  const d = okData<any>(await op('POST', '/api/robots/RB-03/position', { body: { x: 0, y: 3, heading: 'N' } }), 'confirmPosition');
  eq([d.currentPoint, d.heading, d.positionConfidence], ['0,3', 'N', 'confirmed'], 'posição confirmada');
  eq(okData<Robot>(await op('GET', '/api/robots/RB-03'), 'getRobot').currentPoint, '0,3', 'currentPoint do robô');
});

test('PATCH /alerts/:id/acknowledge persiste e não afeta movimento', ['mutate', 'seed'], async () => {
  assert(cfg.mutate && cfg.seed, 'exige --allow-mutations e seed');
  const d = okData<any>(await op('PATCH', '/api/alerts/alt-03/acknowledge'), 'acknowledgeAlert');
  eq(d.acknowledged, true, 'acknowledged');
  const list = okData<Alert[]>(await op('GET', '/api/alerts', { query: { status: 'acknowledged' } }), 'listAlerts');
  assert(list.some((a) => a.id === 'alt-03'), 'persistido');
  errorIs(await op('PATCH', '/api/alerts/alt-NAO-EXISTE/acknowledge'), 404, 'NOT_FOUND');
});

test('POST /logs/import: deduplica por id, valida e nunca cria comando', ['mutate'], async () => {
  assert(cfg.mutate, 'exige --allow-mutations');
  const ev = (id: string): LogEvent => ({ id, missionId: 'IMPORT-TESTE', robotId: 'RB-01', timestamp: '2026-01-01T10:00:00.000Z', eventType: 'mission_start', severity: 'info', message: 'Importado pelo teste de contrato.' });
  const id = `ct-import-${randomBytes(4).toString('hex')}`;
  const r1 = okData<any>(await op('POST', '/api/logs/import', { body: { events: [ev(id)] } }), 'importLogs');
  eq(r1.importedCount, 1, 'importados');
  const r2 = okData<any>(await op('POST', '/api/logs/import', { body: { events: [ev(id)] } }), 'importLogs');
  eq([r2.importedCount, r2.ignoredCount], [0, 1], 'duplicado ignorado');
  errorIs(await op('POST', '/api/logs/import', { body: { events: [] } }), 400, 'INVALID_BODY');
  errorIs(await op('POST', '/api/logs/import', { body: { events: [{ id: 'x' }] } }), 400, 'INVALID_BODY');
  errorIs(await op('POST', '/api/logs/import', { rawBody: '{nao-json' }), 400, 'INVALID_BODY');
  const big = Array.from({ length: 501 }, (_, i) => ev(`ct-big-${i}`));
  errorIs(await op('POST', '/api/logs/import', { body: { events: big } }), 413, 'PAYLOAD_TOO_LARGE');
});

// ================================================================ EXECUÇÃO
interface Outcome {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
  ms: number;
}

async function main() {
  const out: Outcome[] = [];
  const skipReason = (t: Test): string | null => {
    if (t.tags.includes('auth') && !cfg.expectAuth && !t.name.startsWith('leitor')) return 'servidor sem auth (use --auth-token)';
    if (t.name.startsWith('leitor') && !cfg.viewer) return 'sem --viewer-token';
    if (t.tags.includes('device') && !cfg.secret) return 'sem --device-secret';
    if ((t.tags.includes('device') || t.tags.includes('mutate')) && !cfg.mutate) return 'exige --allow-mutations';
    if (t.tags.includes('seed') && !cfg.seed) return '--no-seed';
    if (t.tags.includes('internal') && t.name.includes('com credencial') && !cfg.internal) return 'sem --internal-token';
    return null;
  };

  // Estado dos testes anteriores é necessário: ordem de declaração = ordem de execução.
  for (const t of tests) {
    if (cfg.only && !cfg.only.test(t.name)) continue;
    const why = skipReason(t);
    if (why) {
      out.push({ name: t.name, status: 'skip', detail: why, ms: 0 });
      continue;
    }
    const t0 = Date.now();
    try {
      await t.fn();
      out.push({ name: t.name, status: 'pass', ms: Date.now() - t0 });
    } catch (e) {
      out.push({ name: t.name, status: 'fail', detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 });
    }
  }

  const fails = out.filter((o) => o.status === 'fail');
  if (cfg.json) {
    console.log(JSON.stringify({ base: cfg.base, results: out, passed: out.filter((o) => o.status === 'pass').length, failed: fails.length, skipped: out.filter((o) => o.status === 'skip').length }, null, 2));
  } else {
    for (const o of out) {
      const mark = o.status === 'pass' ? '  ✓' : o.status === 'fail' ? '  ✗' : '  -';
      console.log(`${mark} ${o.name}${o.status === 'pass' ? ` (${o.ms} ms)` : ''}`);
      if (o.detail) console.log(`      ${o.detail.replace(/\n/g, '\n      ')}`);
    }
    console.log(`\n${out.filter((o) => o.status === 'pass').length} passaram, ${fails.length} falharam, ${out.filter((o) => o.status === 'skip').length} pulados — ${cfg.base}`);
  }
  process.exit(fails.length ? 1 : 0);
}

void ENDPOINTS;
void errorIs;
main().catch((e) => {
  console.error(e);
  process.exit(2);
});
