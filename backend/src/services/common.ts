import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { EventSeverity, EventType, InternalEventEnvelope, RoverState } from '@roboflow/contracts';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import type { Clock } from '../lib/ids.js';
import type { Collection, Store, Tx } from '../store/types.js';
import { C } from '../store/types.js';
import type { EventDoc, IdempotencyDoc, MissionDoc, RobotDoc } from '../domain/types.js';

/** Publicador dos eventos aceitos (Pub/Sub em produção; inline/fake em dev e teste). */
export interface Publisher {
  publish(envelope: InternalEventEnvelope): Promise<void>;
}

export interface Deps {
  /** Cache de mapas: imutáveis por versão, então nunca ficam velhos. */
  mapCache: Map<string, import('../domain/types.js').MapDoc>;
  store: Store;
  cfg: Config;
  clock: Clock;
  publisher: Publisher;
  log: FastifyBaseLogger;
}

export const iso = (d: Date): string => d.toISOString();

type Activity = Pick<RobotDoc, 'lastSeenAt' | 'activeMissionId' | 'pendingCommandIds'>;
type OfflineCfg = Pick<Config, 'offlineAfterMs' | 'offlineAfterIdleMs'>;
type WriteCfg = Pick<Config, 'lastSeenWriteMs' | 'lastSeenWriteIdleMs'>;

/** Com missão ou comando pendente o dispositivo conversa rápido; em repouso, devagar (cota de escrita). */
const isActive = (r: Pick<RobotDoc, 'activeMissionId' | 'pendingCommandIds'>): boolean =>
  r.activeMissionId !== null || r.pendingCommandIds.length > 0;

/**
 * Conectado = contato recente. O limiar acompanha a cadência de gravação de
 * `lastSeenAt`: curto com missão (10 s de gravação), longo em repouso (120 s).
 */
export function isOnline(robot: Activity, now: Date, cfg: OfflineCfg): boolean {
  if (!robot.lastSeenAt) return false;
  const limit = isActive(robot) ? cfg.offlineAfterMs : cfg.offlineAfterIdleMs;
  return now.getTime() - Date.parse(robot.lastSeenAt) <= limit;
}

/** `lastSeenAt` só é regravado de tempos em tempos (cota de escrita do Firestore). */
export function lastSeenDue(robot: Activity, now: Date, cfg: WriteCfg): boolean {
  if (!robot.lastSeenAt) return true;
  const every = isActive(robot) ? cfg.lastSeenWriteMs : cfg.lastSeenWriteIdleMs;
  return now.getTime() - Date.parse(robot.lastSeenAt) >= every;
}

export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000);

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

/** JSON canônico (chaves ordenadas) para comparar corpos de requisição. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export interface IdemResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Idempotência por chave: mesma chave + mesmo corpo => mesma resposta;
 * mesma chave + corpo diferente => 409 CONFLICT_IDEMPOTENCY.
 * O registro é gravado na MESMA transação do efeito (atomicidade).
 */
export async function withIdempotency<T>(
  tx: Tx,
  scope: string,
  key: string | undefined,
  fingerprint: unknown,
  now: Date,
  run: () => Promise<{ status: number; body: T }>,
): Promise<IdemResult<T>> {
  if (!key) {
    const r = await run();
    return { ...r, replayed: false };
  }
  const id = sha256(`${scope}|${key}`);
  const requestHash = sha256(canonicalJson(fingerprint));
  const prior = await tx.get<IdempotencyDoc>(C.idempotency, id);
  if (prior) {
    if (prior.requestHash !== requestHash) {
      throw new AppError('CONFLICT_IDEMPOTENCY', 'Idempotency-Key já usada com outro corpo de requisição.');
    }
    return { status: prior.status, body: prior.body as T, replayed: true };
  }
  const r = await run();
  tx.create(C.idempotency, id, {
    id,
    requestHash,
    status: r.status,
    body: r.body,
    createdAt: iso(now),
    expireAt: addDays(now, 1),
  });
  return { ...r, replayed: false };
}

export interface EventInput {
  eventType: EventType;
  severity: EventSeverity;
  roverState?: RoverState;
  command?: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface EmitOptions {
  /** ID fixo (eventos do dispositivo: derivado de device/sessão/sequência). */
  id?: string;
  source: 'device' | 'system';
  sessionId?: string;
  sequence?: number;
  uptimeMs?: number;
}

/**
 * Cria um evento (LogEvent) dentro da transação. Com missão, usa o contador da
 * própria missão para IDs determinísticos e mantém `eventCount`.
 */
export function emitEvent(
  tx: Tx,
  robotId: string,
  mission: MissionDoc | null,
  input: EventInput,
  now: Date,
  opt: EmitOptions,
): EventDoc {
  let id = opt.id;
  if (!id) {
    if (mission) {
      mission.eventSeq += 1;
      id = `${mission.id}_b${mission.eventSeq}`;
    } else {
      id = `${robotId}_b${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`;
    }
  }
  if (mission) mission.eventCount += 1;
  const doc: EventDoc = {
    id,
    missionId: mission ? mission.id : null,
    robotId,
    timestamp: iso(now),
    eventType: input.eventType,
    severity: input.severity,
    message: input.message,
    source: opt.source,
    expireAt: addDays(now, 180),
    ...(input.roverState ? { roverState: input.roverState } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
    ...(opt.sessionId ? { sessionId: opt.sessionId } : {}),
    ...(opt.sequence !== undefined ? { sequence: opt.sequence } : {}),
    ...(opt.uptimeMs !== undefined ? { uptimeMs: opt.uptimeMs } : {}),
  };
  tx.create(C.events, id, doc);
  return doc;
}

export function addPending(robot: RobotDoc, commandId: string): void {
  if (!robot.pendingCommandIds.includes(commandId)) robot.pendingCommandIds.push(commandId);
}

export function removePending(robot: RobotDoc, commandId: string): void {
  robot.pendingCommandIds = robot.pendingCommandIds.filter((id) => id !== commandId);
}

/** Cursor opaco para paginação. */
export function encodeCursor(value: unknown, id: string): string {
  return Buffer.from(JSON.stringify({ v: value, i: id })).toString('base64url');
}

export function decodeCursor(raw: string | undefined): { value: unknown; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as { v: unknown; i: string };
    if (typeof o.i !== 'string') return undefined;
    return { value: o.v, id: o.i };
  } catch {
    return undefined;
  }
}

export type { Collection };
