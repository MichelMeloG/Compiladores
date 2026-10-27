/**
 * CLI do simulador de ESP32: age como o firmware contra um backend real.
 *
 *   npm run esp-sim -- --url http://localhost:8080 --device RB-02 --secret <segredo> [opções]
 *
 * Fica em loop: faz hello, consulta o servidor no ritmo ditado por `nextPollMs`,
 * carrega a fila quando chega `load_route`, e executa uma ação por `--step-ms`
 * depois do `start`. Encerra com Ctrl+C.
 *
 * Opções
 *   --url <url>            Base do backend (padrão http://localhost:8080)
 *   --device <id>          ID do dispositivo (padrão RB-02)
 *   --secret <segredo>     Segredo HMAC do dispositivo (ou env DEVICE_SECRET)
 *   --step-ms <ms>         Tempo por cruzamento (padrão 2000)
 *   --obstacle-at <n>      Simula obstáculo ao concluir a ação n (0-based); aguarda `resume`
 *   --obstacle-ms <ms>     Tempo até o obstáculo sumir (padrão 3000)
 *   --reboot-after <n>     Reinicia (nova sessão) depois da ação n
 *   --once                 Sai ao terminar a primeira missão
 *   --telemetry-ms <ms>    Intervalo da telemetria (0 desliga; padrão 5000)
 */
import { EspSim, SimHttpError, type Transport } from './sim.js';

const argv = process.argv.slice(2);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n: string) => argv.includes(`--${n}`);

const url = (opt('url') ?? 'http://localhost:8080').replace(/\/$/, '');
const deviceId = opt('device') ?? 'RB-02';
const secret = opt('secret') ?? process.env['DEVICE_SECRET'] ?? '';
const stepMs = Number(opt('step-ms') ?? 2000);
const obstacleAt = opt('obstacle-at') !== undefined ? Number(opt('obstacle-at')) : undefined;
const obstacleMs = Number(opt('obstacle-ms') ?? 3000);
const rebootAfter = opt('reboot-after') !== undefined ? Number(opt('reboot-after')) : undefined;
const telemetryMs = Number(opt('telemetry-ms') ?? 5000);

if (!secret) {
  console.error('Informe --secret (ou DEVICE_SECRET).');
  process.exit(2);
}

const transport: Transport = async (req) => {
  const res = await fetch(url + req.path, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const sim = new EspSim({ deviceId, secret, transport });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[${new Date().toISOString()}] ${deviceId} ${m}`);

async function main(): Promise<void> {
  await sim.boot();
  log(`hello ok (sessão ${sim.sessionId})`);
  let nextPoll = 1000;
  let lastTelemetry = 0;
  let lastStep = 0;
  let blockedSince = 0;
  let missionsDone = 0;

  for (;;) {
    await sleep(Math.min(nextPoll, 250));
    const now = Date.now();
    try {
      if (now - lastStep >= nextPoll || sim.state === 'ready') {
        const res = await sim.poll();
        nextPoll = res.nextPollMs ?? 1500;
        lastStep = Date.now();
        for (const c of res.commands ?? []) log(`comando ${c.type} (${c.messageId})`);
      }

      if (sim.state === 'running' && now - lastTelemetry >= stepMs) {
        await sim.doAction();
        lastTelemetry = Date.now();
        log(`cruzamento ${sim.completed}/${sim.route?.actions.length ?? '?'}`);
        const done = sim.completed - 1;
        if (obstacleAt !== undefined && done === obstacleAt && sim.state === 'running') {
          const id = await sim.block(['obstacle'], 12);
          blockedSince = Date.now();
          log(`bloqueio ${id}: obstáculo a 12 cm`);
        }
        if (rebootAfter !== undefined && done === rebootAfter) {
          log('reiniciando (nova sessão)');
          await sleep(1500);
          await sim.boot();
        }
      }
      if (sim.state === 'blocked' && blockedSince && now - blockedSince >= obstacleMs) {
        await sim.clearBlock();
        blockedSince = 0;
        log('obstáculo liberado; aguardando retomada explícita do operador');
      }
      if (sim.state === 'finished') {
        log('missão concluída');
        missionsDone += 1;
        sim.state = 'ready';
        if (flag('once')) return;
      }
      if (telemetryMs > 0 && now - lastTelemetry >= telemetryMs && sim.state !== 'ready') {
        await sim.telemetry(sim.state === 'blocked' ? 12 : 80);
        lastTelemetry = Date.now();
      }
    } catch (err) {
      if (err instanceof SimHttpError && err.body?.error === 'CONFLICT_SESSION') {
        log('sessão desconhecida pelo servidor; refazendo hello');
        await sim.boot();
      } else {
        log(`erro: ${err instanceof Error ? err.message : String(err)}`);
        await sleep(2000);
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
