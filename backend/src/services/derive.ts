import type { InternalEventEnvelope } from '@roboflow/contracts';
import { isTerminal } from '../domain/mission.js';
import type { CommandDoc, MissionDoc, RobotDoc, RollupDoc } from '../domain/types.js';
import { C } from '../store/types.js';
import { upsertAlert } from './alerts.js';
import { isOnline, iso, type Deps } from './common.js';
import { expireCommand } from './lifecycle.js';

/** Limite de paradas por presença na mesma missão que gera alerta de recorrência. */
export const RECURRENCE_THRESHOLD = 3;

export const dayOf = (isoDate: string): string => isoDate.slice(0, 10);
/** `{robotId}_{yyyymmdd}` (dia) e `{robotId}_all` (acumulado), conforme docs/FIRESTORE_MODEL.md. */
export const rollupId = (day: string, robotId: string): string => `${robotId}_${day.replaceAll('-', '')}`;
export const rollupAllId = (robotId: string): string => `${robotId}_all`;
const MAX_DURATIONS = 1000;

function emptyRollup(id: string, scope: RollupDoc['scope'], day: string, robotId: string): RollupDoc {
  return {
    id, scope, day, robotId,
    total: 0, completed: 0, failed: 0, aborted: 0, durations: [],
    stops: 0, presenceStops: 0, otherStops: 0, unknownStops: 0, errors: 0,
  };
}

function addToRollup(r: RollupDoc, m: MissionDoc): void {
  r.total += 1;
  if (m.state === 'completed') {
    r.completed += 1;
    if (m.durationSeconds !== null) r.durations = [...r.durations, m.durationSeconds].slice(-MAX_DURATIONS);
  } else if (m.state === 'failed') r.failed += 1;
  else r.aborted += 1;
  r.stops += m.stopCount;
  r.presenceStops += m.presenceStopCount;
  r.otherStops += m.otherStopCount;
  r.unknownStops += m.unknownStopCount;
  r.errors += m.errorCount;
}

/**
 * Efeitos derivados de uma missão, TODOS idempotentes (dependem só do estado
 * atual e de IDs determinísticos), então a reentrega at-least-once do Pub/Sub
 * e a varredura do Scheduler nunca duplicam nada:
 *  - alerta de paradas recorrentes por presença;
 *  - rollup diário (aplicado uma única vez: flag `rolledUp`, na mesma transação).
 */
export async function deriveForMission(deps: Deps, missionId: string): Promise<{ rolledUp: boolean }> {
  const now = deps.clock();
  return deps.store.runTransaction(async (tx) => {
    const m = await tx.get<MissionDoc>(C.missions, missionId);
    if (!m) return { rolledUp: false };

    if (m.presenceStopCount >= RECURRENCE_THRESHOLD) {
      await upsertAlert(
        tx,
        {
          id: `rec-${m.id}`,
          title: 'Paradas recorrentes por presença',
          description: `${m.presenceStopCount} paradas preventivas por presença na missão ${m.id}.`,
          severity: 'warning',
          missionId: m.id,
          robotId: m.robotId,
          occurrenceCount: m.presenceStopCount,
        },
        now,
      );
    }

    let rolledUp = false;
    if (isTerminal(m.state) && !m.rolledUp) {
      const day = dayOf(m.startedAt);
      const dayId = rollupId(day, m.robotId);
      const allId = rollupAllId(m.robotId);
      const dayDoc = (await tx.get<RollupDoc>(C.rollups, dayId)) ?? emptyRollup(dayId, 'day', day, m.robotId);
      const allDoc = (await tx.get<RollupDoc>(C.rollups, allId)) ?? emptyRollup(allId, 'all', 'all', m.robotId);
      addToRollup(dayDoc, m);
      addToRollup(allDoc, m);
      tx.set(C.rollups, dayId, dayDoc);
      tx.set(C.rollups, allId, allDoc);
      m.rolledUp = true;
      tx.set(C.missions, m.id, m);
      rolledUp = true;
    }
    return { rolledUp };
  });
}

/** Consumidor de `/internal/events`: resolve a missão do evento e deriva os efeitos. */
export async function consumeEnvelope(deps: Deps, env: InternalEventEnvelope): Promise<{ processed: boolean }> {
  const ev = env.event;
  let missionId: string | undefined = 'missionId' in ev ? ev.missionId : undefined;

  if (!missionId && (ev.type === 'ack' || ev.type === 'reject')) {
    const cmd = await deps.store.get<CommandDoc>(C.commands, ev.replyTo);
    missionId = cmd?.missionId;
  }
  if (!missionId) {
    const robot = await deps.store.get<RobotDoc>(C.robots, env.deviceId);
    missionId = robot?.activeMissionId ?? undefined;
  }
  if (!missionId) return { processed: false };
  await deriveForMission(deps, missionId);
  return { processed: true };
}

export interface SweepResult {
  checked: number;
  markedOffline: number;
  expiredCommands: number;
  rolledUp: number;
}

/**
 * Chamada pelo Cloud Scheduler: detecta dispositivos sem poll, expira
 * comandos vencidos e faz o "catch-up" de rollups cuja mensagem Pub/Sub se
 * perdeu. Não altera o estado de missões por timeout (perda de comunicação
 * NÃO conclui nem aborta a missão: só gera alerta).
 */
export async function offlineCheck(deps: Deps): Promise<SweepResult> {
  const now = deps.clock();
  const robots = await deps.store.query<RobotDoc>(C.robots, { limit: 200 });
  let markedOffline = 0;
  let expiredCommands = 0;

  for (const r of robots) {
    const online = isOnline(r, now, deps.cfg);
    if (!online && r.lastSeenAt) markedOffline += 1;

    if (!online && r.activeMissionId) {
      const missionId = r.activeMissionId;
      await deps.store.runTransaction(async (tx) => {
        await upsertAlert(
          tx,
          {
            id: `offline-${r.id}-${missionId}`,
            title: 'Dispositivo sem comunicação durante a missão',
            description: `O robô ${r.id} não consulta o servidor desde ${r.lastSeenAt}. O firmware conclui o trecho atual e segura no próximo cruzamento.`,
            severity: 'error',
            missionId,
            robotId: r.id,
            occurrenceCount: 1,
          },
          now,
        );
      });
    }

    if (r.pendingCommandIds.length > 0) {
      expiredCommands += await deps.store.runTransaction(async (tx) => {
        const robot = await tx.get<RobotDoc>(C.robots, r.id);
        if (!robot) return 0;
        let n = 0;
        for (const id of [...robot.pendingCommandIds]) {
          const cmd = await tx.get<CommandDoc>(C.commands, id);
          if (cmd && cmd.status === 'pending' && Date.parse(cmd.expiresAt) <= now.getTime()) {
            if (await expireCommand(tx, cmd, robot, now, 'EXPIRED')) n += 1;
          }
        }
        return n;
      });
    }
  }

  const stale = await deps.store.query<MissionDoc>(C.missions, {
    filters: [
      { field: 'active', op: '==', value: false },
      { field: 'rolledUp', op: '==', value: false },
    ],
    limit: 50,
  });
  let rolledUp = 0;
  for (const m of stale) {
    const r = await deriveForMission(deps, m.id);
    if (r.rolledUp) rolledUp += 1;
  }

  deps.log.info({ checked: robots.length, markedOffline, expiredCommands, rolledUp }, 'offline-check concluído');
  return { checked: robots.length, markedOffline, expiredCommands, rolledUp };
}

export { iso };
