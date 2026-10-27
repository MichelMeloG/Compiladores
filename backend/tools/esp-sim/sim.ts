/**
 * Simulador de ESP32 (protocolo HTTPS por poll, ADR 0001/0002/0005).
 *
 * Mesmo código para os testes (transporte `app.inject`) e para a CLI
 * (transporte `fetch`). Implementa o lado do firmware que importa para o
 * backend: sessão por boot, assinatura HMAC, fila carregada localmente,
 * execução por cruzamento, bloqueio por obstáculo, retenção e retransmissão
 * de eventos críticos, e perda de fila no reboot.
 */
import { buildSignedHeaders } from '@roboflow/contracts/signing';

export interface HttpRequest {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  body: any;
}
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

export class SimHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: any,
  ) {
    super(`HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

export type DeviceState = 'initializing' | 'ready' | 'running' | 'blocked' | 'paused' | 'finished' | 'fault';

interface LoadedRoute {
  missionId: string;
  routeRevision: number;
  actions: string[];
  expectedNodes: string[];
  startNode: string;
  initialHeading: string;
}

export interface SimOptions {
  deviceId: string;
  secret: string;
  transport: Transport;
  /** Relógio em ms (injetável: os testes usam um relógio falso). */
  now?: () => number;
  firmwareVersion?: string;
  capabilities?: { supportsReverse: boolean; maxActions: number; maxMessageBytes: number };
}

const CRITICAL = new Set([
  'hello',
  'ack',
  'reject',
  'action_completed',
  'mission_completed',
  'block_started',
  'block_cleared',
  'fault',
  'snapshot',
]);

export class EspSim {
  state: DeviceState = 'initializing';
  sessionId = '';
  route: LoadedRoute | null = null;
  completed = 0;
  blockId: string | null = null;
  lastResponse: any = null;
  /** Comandos recebidos (para asserções). */
  readonly received: any[] = [];

  private bootCount = 0;
  private reqSeq = 0;
  private evtSeq = 0;
  private bootAt = 0;
  private blockCount = 0;
  private pending: Record<string, unknown>[] = [];
  private lose = false;
  private dupe = false;
  private acked = 0;

  constructor(private readonly o: SimOptions) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  private caps() {
    return this.o.capabilities ?? { supportsReverse: false, maxActions: 64, maxMessageBytes: 4096 };
  }

  // -------------------------------------------------------------- transporte

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    this.reqSeq += 1;
    const headers = buildSignedHeaders(
      this.o.secret,
      { deviceId: this.o.deviceId, sessionId: this.sessionId },
      { method, path, timestamp: Math.floor(this.now() / 1000), sequence: this.reqSeq, ...(raw !== undefined ? { body: raw } : {}) },
    );
    const res = await this.o.transport({
      method,
      path,
      headers: { ...headers, ...(raw !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(raw !== undefined ? { body: raw } : {}),
    });
    if (res.status >= 400) throw new SimHttpError(res.status, res.body);
    return res.body?.success === true ? res.body.data : res.body; // desembrulha { success, data }
  }

  /** Cabeçalhos assinados de uma requisição com corpo adulterado (testes de segurança). */
  signedRaw(method: 'GET' | 'POST', path: string, signedBody: string | undefined, sentBody: string | undefined, seqOffset = 1) {
    return {
      method,
      path,
      headers: {
        ...buildSignedHeaders(
          this.o.secret,
          { deviceId: this.o.deviceId, sessionId: this.sessionId },
          { method, path, timestamp: Math.floor(this.now() / 1000), sequence: this.reqSeq + seqOffset, ...(signedBody !== undefined ? { body: signedBody } : {}) },
        ),
        'content-type': 'application/json',
      },
      ...(sentBody !== undefined ? { body: sentBody } : {}),
    };
  }

  // ----------------------------------------------------------------- eventos

  private queue(type: string, extra: Record<string, unknown> = {}): number {
    this.evtSeq += 1;
    this.pending.push({
      v: 1,
      type,
      messageId: `evt-${this.sessionId}-${this.evtSeq}`,
      deviceId: this.o.deviceId,
      sessionId: this.sessionId,
      sequence: this.evtSeq,
      uptimeMs: Math.max(0, this.now() - this.bootAt),
      ...extra,
    });
    return this.evtSeq;
  }

  private mref(): Record<string, unknown> {
    return this.route ? { missionId: this.route.missionId, routeRevision: this.route.routeRevision } : {};
  }

  /**
   * Envia os eventos pendentes (críticos permanecem até serem confirmados).
   * Se a resposta trouxer comandos, executa-os e envia os acks na sequência.
   */
  async flush(): Promise<any> {
    let res: any = this.lastResponse;
    for (let round = 0; round < 5 && this.pending.length > 0; round++) {
      const batch = this.pending.slice(0, 16);
      if (this.lose) {
        this.lose = false;
        // Requisição perdida na rede: nada chega ao servidor; os críticos ficam retidos.
        this.pending = this.pending.filter((e) => CRITICAL.has(String(e['type'])));
        return undefined;
      }
      res = await this.call('POST', '/device/events', { events: batch });
      if (this.dupe) {
        this.dupe = false;
        await this.call('POST', '/device/events', { events: batch }); // retransmissão duplicada do lote
      }
      this.afterSync(res);
      const sent = new Set(batch.map((e) => e['sequence'] as number));
      this.pending = this.pending.filter(
        (e) => !sent.has(e['sequence'] as number) || (CRITICAL.has(String(e['type'])) && (e['sequence'] as number) > this.acked),
      );
      if (!this.takeCommands(res.commands ?? [])) break;
    }
    return res;
  }

  /** Executa comandos ainda não tratados. Retorna true se houve algum. */
  private takeCommands(cmds: any[]): boolean {
    let any = false;
    for (const c of cmds) {
      if (this.received.some((r) => r.messageId === c.messageId)) continue; // reentrega: idempotente
      this.received.push(c);
      this.apply(c);
      any = true;
    }
    return any;
  }

  private afterSync(res: any): void {
    this.lastResponse = res;
    if (typeof res.ackedSequence === 'number') this.acked = Math.max(this.acked, res.ackedSequence);
    if (res.resync) this.queueSnapshot();
  }

  // --------------------------------------------------------------- ciclo base

  /** Novo boot: nova sessão, fila perdida, hello. */
  async boot(): Promise<any> {
    this.bootCount += 1;
    this.sessionId = `boot-${this.bootCount}-${Math.floor(this.now() / 1000).toString(36)}`;
    this.reqSeq = 0;
    this.evtSeq = 1; // o hello é o evento #1 da sessão
    this.acked = 0;
    this.pending = [];
    this.route = null;
    this.completed = 0;
    this.blockId = null;
    this.state = 'ready';
    this.bootAt = this.now();
    const body = {
      v: 1,
      type: 'hello',
      messageId: `hello-${this.sessionId}`,
      deviceId: this.o.deviceId,
      sessionId: this.sessionId,
      sequence: 1,
      uptimeMs: 100,
      firmwareVersion: this.o.firmwareVersion ?? 'sim-1.0.0',
      protocolVersion: 1,
      capabilities: this.caps(),
      state: 'ready',
    };
    const res = await this.call('POST', '/device/hello', body);
    this.afterSync(res);
    this.takeCommands(res.commands ?? []);
    await this.flush();
    return res;
  }

  /** Reconexão sem reboot (mesma sessão): informa o que lembra da missão. */
  async reconnect(): Promise<any> {
    const body = {
      v: 1,
      type: 'hello',
      messageId: `hello-${this.sessionId}-r${this.reqSeq}`,
      deviceId: this.o.deviceId,
      sessionId: this.sessionId,
      sequence: ++this.evtSeq,
      uptimeMs: Math.max(0, this.now() - this.bootAt),
      firmwareVersion: this.o.firmwareVersion ?? 'sim-1.0.0',
      protocolVersion: 1,
      capabilities: this.caps(),
      state: this.state,
      ...(this.route ? { lastMission: { ...this.mref(), completedActions: this.completed } } : {}),
    };
    const res = await this.call('POST', '/device/hello', body);
    this.afterSync(res);
    this.takeCommands(res.commands ?? []);
    await this.flush();
    return res;
  }

  /** Consulta o servidor, executa os comandos recebidos e devolve acks. */
  async poll(): Promise<any> {
    const res = await this.call('GET', '/device/poll');
    this.afterSync(res);
    this.takeCommands(res.commands ?? []);
    await this.flush();
    return res;
  }

  async telemetry(distanceCm: number | null = 80): Promise<void> {
    this.queue('telemetry', {
      state: this.state,
      ...this.mref(),
      actionIndex: this.route && this.completed < this.route.actions.length ? this.completed : null,
      line: [0, 1, 0],
      distanceCm,
      distanceValid: distanceCm !== null,
      distanceAgeMs: distanceCm === null ? null : 30,
      ...(this.blockId ? { blockId: this.blockId, blockReasons: ['obstacle'] } : {}),
    });
    await this.flush();
  }

  // ----------------------------------------------------------------- comandos

  private ack(c: any): void {
    this.queue('ack', { replyTo: c.messageId, result: 'accepted', missionId: c.missionId, ...(c.routeRevision ? { routeRevision: c.routeRevision } : {}) });
  }
  private reject(c: any, reason: string): void {
    this.queue('reject', { replyTo: c.messageId, reason });
  }

  private apply(c: any): void {
    if (c.sessionId !== this.sessionId) return this.reject(c, 'INVALID_SESSION');
    switch (c.type) {
      case 'load_route':
        if (this.state === 'running' || this.state === 'blocked') return this.reject(c, 'BUSY');
        if (c.actions.some((a: string) => a === 'T') && !this.caps().supportsReverse) return this.reject(c, 'UNSUPPORTED_ACTION');
        if (c.actions.length > this.caps().maxActions) return this.reject(c, 'QUEUE_TOO_LARGE');
        this.route = {
          missionId: c.missionId,
          routeRevision: c.routeRevision,
          actions: c.actions,
          expectedNodes: c.expectedNodes,
          startNode: c.startNode,
          initialHeading: c.initialHeading,
        };
        this.completed = 0;
        this.state = 'ready';
        return this.ack(c);
      case 'start':
        if (!this.route || this.state !== 'ready') return this.reject(c, 'NO_ROUTE_LOADED');
        this.state = 'running';
        return this.ack(c);
      case 'stop':
        if (this.state === 'running') this.state = 'paused';
        return this.ack(c);
      case 'resume':
        if (this.state === 'blocked' && this.blockId !== c.blockId) return this.reject(c, 'STALE_BLOCK');
        if (this.state !== 'blocked' && this.state !== 'paused') return this.reject(c, 'INVALID_STATE');
        this.state = 'running';
        this.blockId = null;
        return this.ack(c);
      case 'abort':
        this.route = null;
        this.completed = 0;
        this.blockId = null;
        this.state = 'ready';
        return this.ack(c);
    }
  }

  // -------------------------------------------------------- execução simulada

  /** Executa UMA ação da fila (um cruzamento) e relata o progresso. */
  async doAction(): Promise<void> {
    if (!this.route || this.state !== 'running') throw new Error(`sim: não está em movimento (estado ${this.state})`);
    const i = this.completed;
    this.queue('action_started', { ...this.mref(), actionIndex: i, command: this.route.actions[i] });
    this.queue('action_completed', { ...this.mref(), actionIndex: i, expectedNode: this.route.expectedNodes[i] });
    this.completed += 1;
    if (this.completed >= this.route.actions.length) {
      this.state = 'finished';
      this.queue('mission_completed', { ...this.mref(), completedActions: this.completed });
    }
    await this.flush();
  }

  /** Executa a fila toda, uma ação por requisição. */
  async runToEnd(): Promise<void> {
    while (this.state === 'running') await this.doAction();
  }

  async block(reasons: string[] = ['obstacle'], distanceCm: number | null = 14): Promise<string> {
    this.blockCount += 1;
    this.blockId = `block-${this.sessionId}-${this.blockCount}`;
    this.state = 'blocked';
    this.queue('block_started', {
      ...(this.route ? { missionId: this.route.missionId } : {}),
      blockId: this.blockId,
      reasons,
      distanceCm,
      actionIndex: this.completed,
    });
    await this.flush();
    return this.blockId;
  }

  async clearBlock(): Promise<void> {
    if (!this.blockId) return;
    this.queue('block_cleared', { ...(this.route ? { missionId: this.route.missionId } : {}), blockId: this.blockId });
    await this.flush();
  }

  async fault(code: string, message: string, severity: 'warning' | 'error' | 'critical' = 'error'): Promise<void> {
    if (severity === 'critical') this.state = 'fault';
    this.queue('fault', { code, message, severity, ...(this.route ? { missionId: this.route.missionId } : {}) });
    await this.flush();
  }

  queueSnapshot(): void {
    this.queue('snapshot', {
      state: this.state,
      ...this.mref(),
      completedActions: this.completed,
      actionIndex: this.route && this.completed < this.route.actions.length ? this.completed : null,
      blockId: this.blockId,
    });
  }

  async snapshot(): Promise<void> {
    this.queueSnapshot();
    await this.flush();
  }

  // ------------------------------------------------- falhas de rede simuladas

  /** A próxima chamada de `flush` perde a requisição (eventos críticos ficam retidos). */
  dropNextFlush(): void {
    this.lose = true;
  }

  /** A próxima chamada de `flush` envia o lote duas vezes. */
  duplicateNextFlush(): void {
    this.dupe = true;
  }

  get pendingCritical(): number {
    return this.pending.filter((e) => CRITICAL.has(String(e['type']))).length;
  }

  /** Simula progresso local sem avisar o servidor (eventos que se perdem). */
  silentProgress(n: number): void {
    this.completed += n;
  }
}
