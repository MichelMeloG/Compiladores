import {
  deviceEventDocId,
  deviceStateToRoverState,
  isCriticalEvent,
  projectDeviceEvent,
  type DeviceCommandMessage,
  type DeviceEventMessage,
  type DeviceEventsResponse,
  type DeviceHelloResponse,
  type DeviceSyncResponse,
  type HelloMessage,
  type InternalEventEnvelope,
} from '@roboflow/contracts';
import { AppError } from '../errors.js';
import { countStop, isActive, isTerminal, tryTransition } from '../domain/mission.js';
import type { CommandDoc, MissionDoc, RobotDoc } from '../domain/types.js';
import { C, type Tx } from '../store/types.js';
import { upsertAlert } from './alerts.js';
import { addDays, emitEvent, iso, lastSeenDue, removePending, type Deps, type EventInput } from './common.js';
import { expireCommand, finishMission, markUncertain, nodePoint } from './lifecycle.js';

export interface DeviceAuth {
  deviceId: string;
  sessionId: string;
  /** X-Sequence da requisição. */
  sequence: number;
  /** X-Timestamp (epoch em segundos). */
  timestamp: number;
}

const LIVE_WRITE_MS = 5000;
const MAX_FAULTS = 10;

/** Intervalo de poll ditado pelo servidor: curto com missão/comando, longo em repouso. */
export function pollInterval(deps: Deps, robot: RobotDoc): number {
  const active = robot.activeMissionId !== null || robot.pendingCommandIds.length > 0;
  return active ? deps.cfg.pollActiveMs : deps.cfg.pollIdleMs;
}

function syncBase(deps: Deps, robot: RobotDoc, now: Date) {
  return {
    sessionId: robot.sessionId ?? '',
    serverTime: iso(now),
    nextPollMs: pollInterval(deps, robot),
    ackedSequence: robot.ackedSeq,
    resync: false,
  };
}

// ---------------------------------------------------------------------------
// Entrega de comandos (poll, hello e resposta de eventos)
// ---------------------------------------------------------------------------

/** O comando ainda faz sentido para o estado atual da missão? */
function commandStillValid(cmd: CommandDoc, m: MissionDoc | undefined): boolean {
  if (!m || !m.active) return false;
  switch (cmd.type) {
    case 'load_route':
      return m.state === 'queued' || m.state === 'loading';
    case 'start':
      return m.state === 'ready';
    case 'stop':
      return m.state === 'running' || m.state === 'uncertain';
    case 'resume':
      return m.state === 'blocked' || m.state === 'paused';
    case 'abort':
      return true;
  }
}

/**
 * Seleciona os comandos pendentes entregáveis, marca a entrega e devolve as
 * mensagens do protocolo. Comandos vencidos ou sem sentido são expirados.
 */
export async function collectCommands(
  deps: Deps,
  tx: Tx,
  robot: RobotDoc,
  now: Date,
): Promise<DeviceCommandMessage[]> {
  const out: { cmd: CommandDoc; msg: DeviceCommandMessage }[] = [];
  for (const id of [...robot.pendingCommandIds]) {
    const cmd = await tx.get<CommandDoc>(C.commands, id);
    if (!cmd) {
      removePending(robot, id);
      continue;
    }
    if (cmd.status !== 'pending') {
      removePending(robot, id);
      continue;
    }
    if (Date.parse(cmd.expiresAt) <= now.getTime()) {
      await expireCommand(tx, cmd, robot, now, 'EXPIRED');
      continue;
    }
    const m = await tx.get<MissionDoc>(C.missions, cmd.missionId);
    if (!commandStillValid(cmd, m)) {
      await expireCommand(tx, cmd, robot, now, 'MISSION_STATE_CHANGED');
      continue;
    }
    const mission = m as MissionDoc;
    const base = {
      v: 1 as const,
      messageId: cmd.id,
      deviceId: robot.id,
      sessionId: robot.sessionId ?? '',
      missionId: mission.id,
      validForMs: Math.max(1, Date.parse(cmd.expiresAt) - now.getTime()),
    };
    let msg: DeviceCommandMessage;
    switch (cmd.type) {
      case 'load_route':
        msg = {
          ...base,
          type: 'load_route',
          routeRevision: mission.routeRevision,
          actions: mission.actions,
          expectedNodes: mission.expectedNodes,
          startNode: mission.startNode,
          initialHeading: mission.initialHeading,
        };
        break;
      case 'start':
        msg = { ...base, type: 'start', routeRevision: mission.routeRevision };
        break;
      case 'resume':
        msg = { ...base, type: 'resume', routeRevision: mission.routeRevision, blockId: cmd.blockId ?? '' };
        break;
      case 'stop':
        msg = { ...base, type: 'stop' };
        break;
      case 'abort':
        msg = { ...base, type: 'abort' };
        break;
    }
    cmd.attempts += 1;
    cmd.sessionId = robot.sessionId;
    cmd.deliveredAt = cmd.deliveredAt ?? iso(now);
    tx.set(C.commands, cmd.id, cmd);
    if (cmd.type === 'load_route' && mission.state === 'queued') {
      tryTransition(mission, 'loading', iso(now));
      tx.set(C.missions, mission.id, mission);
    }
    out.push({ cmd, msg });
  }
  out.sort((a, b) => a.cmd.createdAt.localeCompare(b.cmd.createdAt));
  tx.set(C.robots, robot.id, robot);
  return out.map((o) => o.msg);
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export async function handlePoll(deps: Deps, auth: DeviceAuth, snapshot: RobotDoc): Promise<DeviceSyncResponse> {
  const now = deps.clock();
  const seenStale = lastSeenDue(snapshot, now, deps.cfg);

  // Caminho barato: nada pendente e contato recente => zero escritas.
  if (snapshot.pendingCommandIds.length === 0 && !seenStale) {
    return { ...syncBase(deps, snapshot, now), commands: [] };
  }

  return deps.store.runTransaction(async (tx) => {
    const robot = await tx.get<RobotDoc>(C.robots, auth.deviceId);
    if (!robot) throw new AppError('NOT_FOUND', 'Dispositivo desconhecido.');
    if (robot.sessionId !== auth.sessionId) {
      throw new AppError('CONFLICT_SESSION', 'Sessão desconhecida: envie /device/hello.');
    }
    robot.lastSeenAt = iso(now);
    const commands = await collectCommands(deps, tx, robot, now);
    tx.set(C.robots, robot.id, robot);
    return { ...syncBase(deps, robot, now), commands };
  });
}

// ---------------------------------------------------------------------------
// Hello (novo boot ou reconexão)
// ---------------------------------------------------------------------------

export async function handleHello(deps: Deps, auth: DeviceAuth, hello: HelloMessage): Promise<DeviceHelloResponse> {
  const now = deps.clock();
  const nowIso = iso(now);

  return deps.store.runTransaction(async (tx) => {
    const robot = await tx.get<RobotDoc>(C.robots, auth.deviceId);
    if (!robot) throw new AppError('NOT_FOUND', 'Dispositivo desconhecido.');
    // Um hello capturado e reenviado depois de um mais novo traria a sessão antiga de volta.
    if (auth.timestamp < robot.lastHelloTs) {
      throw new AppError('REPLAY_DETECTED', 'Hello mais antigo que o último aceito.');
    }

    const rebooted = robot.sessionId !== hello.sessionId;
    const mission = robot.activeMissionId ? await tx.get<MissionDoc>(C.missions, robot.activeMissionId) : undefined;

    if (rebooted) {
      // Comandos já ENTREGUES à sessão antiga e sem resposta: resultado incerto.
      const deliveredStart: string[] = [];
      for (const id of [...robot.pendingCommandIds]) {
        const cmd = await tx.get<CommandDoc>(C.commands, id);
        if (!cmd || cmd.status !== 'pending') {
          removePending(robot, id);
          continue;
        }
        if (cmd.sessionId !== null) {
          cmd.status = 'uncertain';
          cmd.reason = 'SESSION_CHANGED';
          cmd.resolvedAt = nowIso;
          if (cmd.type === 'start' || cmd.type === 'resume') deliveredStart.push(cmd.id);
          removePending(robot, id);
          tx.set(C.commands, cmd.id, cmd);
        }
      }
      if (mission && mission.active) {
        await applyReboot(tx, robot, mission, deliveredStart.length > 0, now);
      }
      robot.sessionId = hello.sessionId;
      robot.ackedSeq = hello.sequence; // o próprio hello é o evento crítico #N da sessão
      robot.live = null;
    }

    robot.lastRequestSeq = Math.max(rebooted ? 0 : robot.lastRequestSeq, auth.sequence);
    robot.lastHelloTs = auth.timestamp;
    robot.capabilities = hello.capabilities;
    robot.deviceState = hello.state;
    robot.firmwareVersion = hello.firmwareVersion;
    robot.protocolVersion = hello.protocolVersion;
    robot.lastSeenAt = nowIso;

    // Reconexão na mesma sessão: o firmware informa o que lembra da missão.
    if (!rebooted && mission && mission.active && hello.lastMission?.missionId === mission.id) {
      await reconcile(
        tx,
        robot,
        mission,
        { state: hello.state, completedActions: hello.lastMission.completedActions, blockId: undefined },
        now,
      );
    }

    const reconcileRequired = mission !== undefined && mission.active && mission.state === 'uncertain';
    if (mission) tx.set(C.missions, mission.id, mission);

    const commands = await collectCommands(deps, tx, robot, now);
    tx.set(C.robots, robot.id, robot);
    return {
      ...syncBase(deps, robot, now),
      accepted: true as const,
      reconcileRequired,
      limits: hello.capabilities,
      commands,
    };
  });
}

/** Efeito de um reinício do firmware sobre a missão ativa (a fila e o motor foram perdidos). */
async function applyReboot(tx: Tx, robot: RobotDoc, m: MissionDoc, startWasDelivered: boolean, now: Date): Promise<void> {
  const nowIso = iso(now);
  const note = (message: string, severity: 'warning' | 'error') =>
    emitEvent(
      tx,
      robot.id,
      m,
      { eventType: severity === 'error' ? 'error' : 'warning', severity, roverState: 'unknown', message },
      now,
      { source: 'system' },
    );

  switch (m.state) {
    case 'queued':
      return; // o load_route nunca foi entregue: segue valendo para a nova sessão
    case 'loading':
      finishMission(m, robot, 'failed', now);
      note('O dispositivo reiniciou durante o carregamento; a missão foi encerrada sem movimento.', 'error');
      return;
    case 'ready':
      if (startWasDelivered) {
        markUncertain(m, robot, now);
        note('O dispositivo reiniciou depois de receber o início; o estado físico é incerto.', 'error');
        await upsertUncertainAlert(tx, m, now);
      } else {
        finishMission(m, robot, 'failed', now);
        note('O dispositivo reiniciou e perdeu a fila carregada; a missão foi encerrada sem movimento.', 'error');
      }
      return;
    case 'running':
    case 'blocked':
    case 'paused':
      markUncertain(m, robot, now);
      note('O dispositivo reiniciou durante a missão. Motores parados; é preciso reconciliar e reposicionar.', 'error');
      await upsertUncertainAlert(tx, m, now);
      return;
    case 'uncertain':
      m.updatedAt = nowIso;
      return;
    default:
      return;
  }
}

async function upsertUncertainAlert(tx: Tx, m: MissionDoc, now: Date): Promise<void> {
  await upsertAlert(
    tx,
    {
      id: `unc-${m.id}`,
      title: 'Posição incerta após falha de comunicação',
      description: `A missão ${m.id} está em estado incerto. O robô não retoma sozinho; reconcilie ou reposicione.`,
      severity: 'error',
      missionId: m.id,
      robotId: m.robotId,
      occurrenceCount: 1,
    },
    now,
  );
}

// ---------------------------------------------------------------------------
// Reconciliação (snapshot ou hello na mesma sessão)
// ---------------------------------------------------------------------------

interface SnapshotLike {
  state: string;
  completedActions?: number | undefined;
  blockId?: string | null | undefined;
}

function expectedDeviceState(m: MissionDoc): string | null {
  switch (m.state) {
    case 'running':
      return 'running';
    case 'blocked':
      return 'blocked';
    case 'paused':
      return 'paused';
    case 'ready':
      return 'ready';
    default:
      return null;
  }
}

function catchUpTo(m: MissionDoc, robot: RobotDoc, n: number): void {
  const clamped = Math.max(0, Math.min(n, m.totalActions));
  m.completedActions = clamped;
  if (clamped === 0) {
    m.lastConfirmedNode = m.startNode;
    m.headingAtLastConfirmedNode = m.initialHeading;
  } else {
    m.lastConfirmedNode = m.expectedNodes[clamped - 1] as string;
    m.headingAtLastConfirmedNode = m.headingsAfter[clamped - 1] as typeof m.initialHeading;
  }
  robot.currentPoint = m.lastConfirmedNode;
  robot.heading = m.headingAtLastConfirmedNode;
}

/** O dispositivo é a verdade sobre o seu estado: alinha a missão a ele, sem retomar o movimento. */
async function reconcile(tx: Tx, robot: RobotDoc, m: MissionDoc, snap: SnapshotLike, now: Date): Promise<void> {
  if (!m.active) return;
  const nowIso = iso(now);
  const expected = expectedDeviceState(m);
  const aheadOfUs = snap.completedActions !== undefined && snap.completedActions !== m.completedActions;
  const stateMismatch = expected !== null && snap.state !== expected && !(m.state === 'ready' && snap.state === 'ready');

  if (m.state !== 'uncertain') {
    // Lacuna detectada: algum evento crítico se perdeu.
    if (!aheadOfUs && !stateMismatch) return;
    markUncertain(m, robot, now);
    emitEvent(
      tx,
      robot.id,
      m,
      {
        eventType: 'warning',
        severity: 'warning',
        message: 'Divergência entre o servidor e o dispositivo (evento crítico perdido); missão marcada como incerta para reconciliação.',
      },
      now,
      { source: 'system' },
    );
    await upsertUncertainAlert(tx, m, now);
  }

  if (snap.completedActions !== undefined) catchUpTo(m, robot, snap.completedActions);

  switch (snap.state) {
    case 'paused':
      tryTransition(m, 'paused', nowIso);
      break;
    case 'blocked':
      if (snap.blockId && tryTransition(m, 'blocked', nowIso)) {
        m.currentBlock = {
          blockId: snap.blockId,
          reasons: [],
          startedAt: nowIso,
          actionIndex: m.completedActions,
          cleared: false,
        };
        countStop(m, []);
      }
      break;
    case 'finished':
      if (m.completedActions >= m.totalActions) {
        finishMission(m, robot, 'completed', now);
      }
      break;
    case 'fault':
      finishMission(m, robot, 'failed', now);
      break;
    default:
      break;
  }
  m.updatedAt = nowIso;
  emitEvent(
    tx,
    robot.id,
    m,
    {
      eventType: 'state_change',
      severity: 'info',
      roverState: deviceStateToRoverState(snap.state as never),
      message: `Reconciliação com o dispositivo: estado ${snap.state}, ${m.completedActions}/${m.totalActions} ações confirmadas.`,
    },
    now,
    { source: 'system' },
  );
}

// ---------------------------------------------------------------------------
// Eventos do dispositivo
// ---------------------------------------------------------------------------

export interface IngestResult {
  response: DeviceEventsResponse;
  /** Eventos aceitos (novos) a publicar para alertas e rollups. */
  accepted: InternalEventEnvelope[];
}

export async function handleEvents(
  deps: Deps,
  auth: DeviceAuth,
  events: DeviceEventMessage[],
): Promise<IngestResult> {
  const now = deps.clock();
  const nowIso = iso(now);
  const sorted = [...events].sort((a, b) => a.sequence - b.sequence);

  const result = await deps.store.runTransaction(async (tx) => {
    const robot = await tx.get<RobotDoc>(C.robots, auth.deviceId);
    if (!robot) throw new AppError('NOT_FOUND', 'Dispositivo desconhecido.');
    if (robot.sessionId !== auth.sessionId) {
      throw new AppError('CONFLICT_SESSION', 'Sessão desconhecida: envie /device/hello.');
    }

    const missions = new Map<string, MissionDoc | undefined>();
    const getMission = async (id: string | null | undefined): Promise<MissionDoc | undefined> => {
      if (!id) return undefined;
      if (!missions.has(id)) missions.set(id, await tx.get<MissionDoc>(C.missions, id));
      return missions.get(id);
    };

    const rejected: { sequence: number; reason: string }[] = [];
    const accepted: InternalEventEnvelope[] = [];
    let resync = false;
    let criticalProcessed = false;
    let liveDue = false;
    let robotDirty = false;

    for (const ev of sorted) {
      if (ev.deviceId !== auth.deviceId || ev.sessionId !== auth.sessionId) {
        rejected.push({ sequence: ev.sequence, reason: 'SESSION_MISMATCH' });
        continue;
      }
      const critical = isCriticalEvent(ev.type);
      const docId = deviceEventDocId(ev.deviceId, ev.sessionId, ev.sequence);

      if (ev.type === 'telemetry') {
        const prev = robot.live;
        const changed =
          !prev ||
          prev.state !== ev.state ||
          (prev.blockId ?? null) !== (ev.blockId ?? null) ||
          now.getTime() - Date.parse(prev.at) >= LIVE_WRITE_MS;
        if (changed) {
          robot.live = {
            at: nowIso,
            state: ev.state,
            ...(ev.missionId ? { missionId: ev.missionId } : {}),
            actionIndex: ev.actionIndex ?? null,
            ...(ev.phase ? { phase: ev.phase } : {}),
            line: ev.line,
            distanceCm: ev.distanceCm,
            distanceValid: ev.distanceValid,
            distanceAgeMs: ev.distanceAgeMs,
            blockId: ev.blockId ?? null,
            blockReasons: ev.blockReasons ?? [],
          };
          robot.deviceState = ev.state;
          liveDue = true;
        }
        continue;
      }

      // Duplicata: sequência crítica já confirmada ou evento já persistido.
      if (critical && ev.sequence <= robot.ackedSeq) continue;
      // Dedupe por ID determinístico: críticos em `deviceEvents` (bruto), demais pelo evento projetado.
      const seen = critical ? await tx.get(C.deviceEvents, docId) : await tx.get(C.events, docId);
      if (seen) {
        if (critical) criticalProcessed = true;
        continue;
      }

      const emitDevice = (m: MissionDoc | undefined, extra: Parameters<typeof projectDeviceEvent>[1] = {}) => {
        const outs = projectDeviceEvent(ev, { ...extra, ...(m ? { totalActions: m.totalActions } : {}) });
        outs.forEach((o, i) =>
          emitEvent(tx, robot.id, m ?? null, o as EventInput, now, {
            id: i === 0 ? docId : `${docId}_${i}`,
            source: 'device',
            sessionId: ev.sessionId,
            sequence: ev.sequence,
            uptimeMs: ev.uptimeMs,
          }),
        );
        return outs.length;
      };
      const emitCustom = (m: MissionDoc | undefined, input: EventInput, withId = true) =>
        emitEvent(tx, robot.id, m ?? null, input, now, {
          ...(withId ? { id: docId } : {}),
          source: 'device',
          sessionId: ev.sessionId,
          sequence: ev.sequence,
          uptimeMs: ev.uptimeMs,
        });

      switch (ev.type) {
        // ------------------------------------------------------------- respostas
        case 'ack':
        case 'reject': {
          const cmd = await tx.get<CommandDoc>(C.commands, ev.replyTo);
          if (!cmd || cmd.robotId !== robot.id) {
            rejected.push({ sequence: ev.sequence, reason: 'UNKNOWN_COMMAND' });
            break;
          }
          if (cmd.status !== 'pending') break; // já resolvido: duplicata
          if (cmd.sessionId !== ev.sessionId) {
            rejected.push({ sequence: ev.sequence, reason: 'STALE_COMMAND_SESSION' });
            break;
          }
          const m = await getMission(cmd.missionId);
          cmd.resolvedAt = nowIso;
          removePending(robot, cmd.id);
          robotDirty = true;
          if (ev.type === 'reject') {
            cmd.status = 'rejected';
            cmd.reason = ev.reason;
            tx.set(C.commands, cmd.id, cmd);
            if (m && m.active) {
              if (cmd.type === 'load_route') finishMission(m, robot, 'failed', now);
              emitDevice(m);
            }
            break;
          }
          cmd.status = 'accepted';
          tx.set(C.commands, cmd.id, cmd);
          if (!m || !m.active) break;
          applyAck(deps, tx, robot, m, cmd, ev.sessionId, now);
          const n = emitDevice(m, { ackedCommandType: cmd.type });
          if (n === 0) {
            if (cmd.type === 'start') {
              emitCustom(m, { eventType: 'state_change', severity: 'info', roverState: 'moving', message: 'Movimento iniciado; seguindo a linha.' });
            } else if (cmd.type === 'load_route') {
              emitCustom(m, { eventType: 'state_change', severity: 'info', roverState: 'idle', message: 'Fila carregada no dispositivo; aguardando o início.' });
            }
          }
          break;
        }

        // -------------------------------------------------------------- progresso
        case 'action_started': {
          const m = await getMission(ev.missionId);
          if (!m || !m.active) break;
          if (ev.actionIndex !== m.completedActions) break; // fora da sequência esperada
          emitDevice(m);
          break;
        }
        case 'action_completed': {
          const m = await getMission(ev.missionId);
          if (!m || !m.active) break;
          if (ev.actionIndex < m.completedActions) break; // duplicata
          if (ev.actionIndex > m.completedActions) {
            // Salto de índice: nunca presumir conclusão.
            if (markUncertain(m, robot, now)) {
              emitCustom(m, {
                eventType: 'error',
                severity: 'error',
                roverState: 'unknown',
                message: `Salto de índice: esperada a ação ${m.completedActions}, recebida a ${ev.actionIndex}. Reconciliação necessária.`,
              });
              await upsertUncertainAlert(tx, m, now);
            }
            resync = true;
            break;
          }
          if (ev.expectedNode !== m.expectedNodes[ev.actionIndex]) {
            if (markUncertain(m, robot, now)) {
              emitCustom(m, {
                eventType: 'error',
                severity: 'error',
                roverState: 'unknown',
                message: `Cruzamento divergente: esperado ${m.expectedNodes[ev.actionIndex]}, informado ${ev.expectedNode}.`,
              });
              await upsertUncertainAlert(tx, m, now);
            }
            resync = true;
            break;
          }
          m.completedActions += 1;
          m.lastConfirmedNode = ev.expectedNode;
          m.headingAtLastConfirmedNode = m.headingsAfter[ev.actionIndex] as typeof m.initialHeading;
          robot.currentPoint = ev.expectedNode;
          robot.heading = m.headingAtLastConfirmedNode;
          if (m.state !== 'uncertain') robot.positionConfidence = 'estimated';
          m.updatedAt = nowIso;
          robotDirty = true;
          emitDevice(m);
          break;
        }
        case 'mission_completed': {
          const m = await getMission(ev.missionId);
          if (!m || !m.active) break;
          if (m.completedActions !== m.totalActions || ev.completedActions !== m.totalActions) {
            if (markUncertain(m, robot, now)) {
              emitCustom(m, {
                eventType: 'error',
                severity: 'error',
                roverState: 'unknown',
                message: `Conclusão informada com ${ev.completedActions}/${m.totalActions} ações, mas o servidor confirmou ${m.completedActions}. Reconciliação necessária.`,
              });
              await upsertUncertainAlert(tx, m, now);
            }
            resync = true;
            break;
          }
          if (m.state === 'uncertain') {
            // Já incerta por outro motivo: só o snapshot reconcilia.
            resync = true;
            break;
          }
          finishMission(m, robot, 'completed', now);
          robotDirty = true;
          emitDevice(m);
          break;
        }

        // --------------------------------------------------------------- bloqueios
        case 'block_started': {
          const m = await getMission(ev.missionId ?? robot.activeMissionId);
          if (!m || !m.active) {
            emitDevice(undefined);
            break;
          }
          const block = {
            blockId: ev.blockId,
            reasons: [...ev.reasons],
            startedAt: nowIso,
            actionIndex: ev.actionIndex ?? m.completedActions,
            cleared: false,
          };
          if (m.state === 'running') {
            tryTransition(m, 'blocked', nowIso);
            m.currentBlock = block;
            countStop(m, ev.reasons); // uma parada por TRANSIÇÃO de bloqueio
            emitDevice(m);
          } else if (m.state === 'blocked') {
            // Mesmo episódio: acumula motivos, sem nova parada.
            const cur = m.currentBlock;
            m.currentBlock = {
              ...block,
              blockId: ev.blockId,
              reasons: [...new Set([...(cur?.reasons ?? []), ...ev.reasons])],
              startedAt: cur?.startedAt ?? nowIso,
            };
          } else if (m.state === 'paused' || m.state === 'ready' || m.state === 'uncertain') {
            m.currentBlock = block; // parado por pedido/estado: só registra o bloqueio
          }
          m.updatedAt = nowIso;
          break;
        }
        case 'block_cleared': {
          const m = await getMission(ev.missionId ?? robot.activeMissionId);
          if (m && m.active && m.currentBlock?.blockId === ev.blockId) {
            m.currentBlock = { ...m.currentBlock, cleared: true };
            m.updatedAt = nowIso;
            emitCustom(m, {
              eventType: 'state_change',
              severity: 'info',
              roverState: 'stopped',
              message: 'Bloqueio liberado no dispositivo. A retomada exige pedido explícito do operador.',
              payload: { blockId: ev.blockId },
            });
          }
          break;
        }

        // ------------------------------------------------------------------ falhas
        case 'fault': {
          const m = await getMission(ev.missionId ?? robot.activeMissionId);
          const active = m && m.active ? m : undefined;
          emitDevice(active);
          if (active) {
            active.errorCount += ev.severity === 'warning' ? 0 : 1;
            active.faults = [
              ...active.faults,
              { eventId: docId, code: ev.code, message: ev.message, severity: ev.severity },
            ].slice(-MAX_FAULTS);
            if (ev.severity === 'critical') {
              finishMission(active, robot, 'failed', now);
              robotDirty = true;
            }
            active.updatedAt = nowIso;
          }
          if (ev.severity !== 'warning') {
            await upsertAlert(
              tx,
              {
                id: `fault-${docId}`,
                title: `Falha do dispositivo: ${ev.code}`,
                description: ev.message,
                severity: ev.severity === 'critical' ? 'critical' : 'error',
                ...(active ? { missionId: active.id } : {}),
                robotId: robot.id,
                relatedEventIds: [docId],
                occurrenceCount: 1,
              },
              now,
            );
          }
          break;
        }

        case 'snapshot': {
          robot.deviceState = ev.state;
          robotDirty = true;
          const m = await getMission(ev.missionId ?? robot.activeMissionId);
          if (m && m.active) {
            await reconcile(tx, robot, m, { state: ev.state, completedActions: ev.completedActions, blockId: ev.blockId }, now);
          }
          break;
        }
      }

      if (critical) {
        criticalProcessed = true;
        tx.create(C.deviceEvents, docId, {
          id: docId,
          deviceId: ev.deviceId,
          sessionId: ev.sessionId,
          sequence: ev.sequence,
          type: ev.type,
          receivedAt: nowIso,
          event: ev,
          expireAt: addDays(now, 30),
        });
        accepted.push({
          eventId: docId,
          deviceId: ev.deviceId,
          sessionId: ev.sessionId,
          sequence: ev.sequence,
          receivedAt: nowIso,
          event: ev,
        });
      }
    }

    // Persistência: só o que mudou (cota de escrita do Firestore).
    if (criticalProcessed) {
      const maxCritical = sorted.filter((e) => isCriticalEvent(e.type) && e.sessionId === auth.sessionId).map((e) => e.sequence);
      if (maxCritical.length) robot.ackedSeq = Math.max(robot.ackedSeq, ...maxCritical);
      robotDirty = true;
    }
    if (lastSeenDue(robot, now, deps.cfg)) {
      robot.lastSeenAt = nowIso;
      robotDirty = true;
    }
    if (robotDirty || liveDue) {
      robot.lastRequestSeq = Math.max(robot.lastRequestSeq, auth.sequence);
      tx.set(C.robots, robot.id, robot);
    }
    for (const m of missions.values()) if (m) tx.set(C.missions, m.id, m);

    const commands = await collectCommands(deps, tx, robot, now);
    const response: DeviceEventsResponse = {
      ...syncBase(deps, robot, now),
      resync,
      commands,
      rejected,
    };
    return { response, accepted };
  });

  return result;
}

/** Efeito do `ack` aceito sobre a missão. */
function applyAck(
  _deps: Deps,
  _tx: Tx,
  robot: RobotDoc,
  m: MissionDoc,
  cmd: CommandDoc,
  sessionId: string,
  now: Date,
): void {
  const nowIso = iso(now);
  switch (cmd.type) {
    case 'load_route':
      if (m.state === 'queued') tryTransition(m, 'loading', nowIso);
      tryTransition(m, 'ready', nowIso);
      m.sessionId = sessionId;
      break;
    case 'start':
      if (tryTransition(m, 'running', nowIso)) m.motionStartedAt = nowIso;
      break;
    case 'stop':
      tryTransition(m, 'paused', nowIso);
      if (m.cancelIntent === 'stop') delete m.cancelIntent;
      break;
    case 'resume':
      if (tryTransition(m, 'running', nowIso)) m.currentBlock = null;
      break;
    case 'abort':
      finishMission(m, robot, 'aborted', now);
      delete m.cancelIntent;
      break;
  }
  m.updatedAt = nowIso;
}

export { isActive, isTerminal, nodePoint };
