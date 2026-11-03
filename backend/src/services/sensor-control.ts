import type { MotorOutput, SensorInput } from '@roboflow/contracts';
import type { CommandDoc, MissionDoc, RobotDoc, SensorControl } from '../domain/types.js';
import { countStop, tryTransition } from '../domain/mission.js';
import { AppError } from '../errors.js';
import { C, type Tx } from '../store/types.js';
import { emitEvent, iso, removePending, type Deps } from './common.js';
import { applyAck, collectCommands } from './device.js';
import { finishMission, markUncertain } from './lifecycle.js';

const SPEED = 150;
const STABLE_SAMPLES = 4;
const COMMUNICATION_LIMIT_MS = 1500;

function newControl(input: SensorInput, now: number, previous?: SensorControl): SensorControl {
  return {
    boot: input.boot, retiredBoots: previous ? [...previous.retiredBoots, previous.boot].slice(-16) : [],
    sequence: 0, applied: 0, lastAt: now, missionId: null, phase: 'idle', phaseAt: now,
    stable: 0, leftOldLine: false, pendingCommand: null, output: { sequence: 0, left: 0, right: 0 },
  };
}

function beginAction(s: SensorControl, m: MissionDoc, now: number): void {
  s.phase = m.actions[m.completedActions] === 'F' ? 'leaving' : 'centering';
  s.phaseAt = now; s.stable = 0; s.leftOldLine = false;
}

function event(tx: Tx, robot: RobotDoc, m: MissionDoc, now: Date, message: string): void {
  emitEvent(tx, robot.id, m, { eventType: 'state_change', severity: 'info', message }, now, { source: 'system' });
}

function accept(deps: Deps, tx: Tx, robot: RobotDoc, m: MissionDoc, c: CommandDoc, now: Date): void {
  c.status = 'accepted'; c.resolvedAt = iso(now); removePending(robot, c.id);
  applyAck(deps, tx, robot, m, c, robot.sessionId!, now);
  tx.set(C.commands, c.id, c);
  event(tx, robot, m, now, `Controlador no backend: ${c.type} aplicado.`);
}

/** Uma única transação conserva a ordem entre amostras, comandos e progresso. */
export async function handleSensors(deps: Deps, deviceId: string, input: SensorInput): Promise<MotorOutput> {
  const now = deps.clock(), t = now.getTime();
  return deps.store.runTransaction(async tx => {
    const robot = await tx.get<RobotDoc>(C.robots, deviceId);
    if (!robot) throw new AppError('SIGNATURE_INVALID', 'Credencial inválida.');
    let m = robot.activeMissionId ? await tx.get<MissionDoc>(C.missions, robot.activeMissionId) : undefined;
    const previous = robot.sensorControl;
    if (!previous && m?.active && m.motionStartedAt) {
      markUncertain(m, robot, now);
      event(tx, robot, m, now, 'Protocolo do dispositivo alterado durante a missão; confira a posição.');
    }
    if (previous?.retiredBoots.includes(input.boot)) throw new AppError('CONFLICT_SESSION', 'Boot antigo.');
    if (previous && previous.boot !== input.boot && m?.active &&
        (m.motionStartedAt || previous.output.left || previous.output.right)) {
      markUncertain(m, robot, now);
      event(tx, robot, m, now, 'ESP32 reiniciado; movimento interrompido. Confira a posição antes de retomar.');
    }
    const s = previous?.boot === input.boot ? previous : newControl(input, t, previous);
    if (input.sequence < s.sequence) throw new AppError('REPLAY_DETECTED', 'Amostra antiga.');
    if (input.sequence === s.sequence) return s.output;
    if (input.applied > s.sequence) throw new AppError('INVALID_BODY', 'Saída aplicada desconhecida.');
    const appliedPrevious = input.applied === s.sequence && s.sequence > 0;
    if (!appliedPrevious) s.stable = 0;
    robot.sessionId = input.boot;
    robot.capabilities = { supportsReverse: false, maxActions: 64, maxMessageBytes: 4096 };
    robot.protocolVersion = 1; robot.firmwareVersion = 'sensor-http-1';

    // Só confirma start/stop/resume/abort quando o ESP informa ter aplicado a resposta.
    if (s.pendingCommand && appliedPrevious && m) {
      const c = await tx.get<CommandDoc>(C.commands, s.pendingCommand);
      if (c?.status === 'pending' && Date.parse(c.expiresAt) > t) accept(deps, tx, robot, m, c, now);
      s.pendingCommand = null;
    }
    if (m?.active && m.state === 'running' && t - s.lastAt > COMMUNICATION_LIMIT_MS) {
      if (s.phase === 'turning' || s.phase === 'centering') markUncertain(m, robot, now);
      else tryTransition(m, 'paused', iso(now));
      s.stable = 0;
      event(tx, robot, m, now, 'Comunicação interrompida; aguardando intervenção do operador.');
    }
    if (m) tx.set(C.missions, m.id, m);
    const commands = await collectCommands(deps, tx, robot, now);
    // collectCommands pode ter expirado a missão ou alterado queued -> loading.
    m = robot.activeMissionId ? await tx.get<MissionDoc>(C.missions, robot.activeMissionId) : undefined;
    const hasLine = input.line.some(Boolean);
    let forceStop = false, startPending = false;
    for (const msg of commands) {
      if (!m || msg.missionId !== m.id) continue;
      const c = (await tx.get<CommandDoc>(C.commands, msg.messageId))!;
      if (c.type === 'load_route') {
        accept(deps, tx, robot, m, c, now); s.missionId = m.id; s.phase = 'idle';
      } else if (c.type === 'stop' || c.type === 'abort') {
        s.pendingCommand = c.id; forceStop = true;
      } else if ((c.type === 'start' || c.type === 'resume') && hasLine &&
                 m.state !== 'uncertain' && !(c.type === 'resume' && m.currentBlock && !m.currentBlock.cleared)) {
        if (s.pendingCommand !== c.id) {
          s.pendingCommand = c.id;
          if (s.phase === 'idle' || s.missionId !== m.id) beginAction(s, m, t);
        }
        s.missionId = m.id; startPending = true;
      }
    }

    let left = 0, right = 0;
    if (m?.active && !forceStop && (m.state === 'running' || startPending)) {
      if (s.phase === 'idle') beginAction(s, m, t);
      if ((s.phase === 'leaving' && t - s.phaseAt > 3000) ||
          (s.phase === 'following' && t - s.phaseAt > 15000)) {
        markUncertain(m, robot, now); forceStop = true;
        event(tx, robot, m, now, 'Trecho sem confirmação dos sensores; confira a posição.');
      }
      if (!hasLine && s.phase !== 'turning') {
        if (m.state === 'running') {
          tryTransition(m, 'blocked', iso(now));
          m.currentBlock = { blockId: `line-${input.boot}-${input.sequence}`, reasons: ['line_lost'],
            actionIndex: m.completedActions, startedAt: iso(now), cleared: false };
          countStop(m, ['line_lost']);
          event(tx, robot, m, now, 'Linha perdida; motores parados.');
        }
      } else {
        const crossing = input.line[0] === 1 && input.line[2] === 1;
        if (s.phase === 'centering' && appliedPrevious && t - s.phaseAt >= 120) {
          s.phase = 'turning'; s.phaseAt = t; s.stable = 0;
        }
        if (s.phase === 'turning') {
          if (!input.line[1]) s.leftOldLine = true;
          const centered = input.line[1] === 1 && !input.line[0] && !input.line[2];
          s.stable = appliedPrevious && s.leftOldLine && centered && t - s.phaseAt >= 180 ? s.stable + 1 : 0;
          if (s.stable >= STABLE_SAMPLES) { s.phase = 'leaving'; s.phaseAt = t; s.stable = 0; }
          if (t - s.phaseAt > 2500) {
            markUncertain(m, robot, now); forceStop = true;
            event(tx, robot, m, now, 'Curva sem confirmação dos sensores; confira a posição.');
          }
        } else if (appliedPrevious && m.state === 'running' && s.phase !== 'centering') {
          s.stable = (s.phase === 'leaving' ? !crossing : crossing) ? s.stable + 1 : 0;
          if (s.stable >= STABLE_SAMPLES) {
            s.stable = 0;
            if (s.phase === 'leaving') { s.phase = 'following'; s.phaseAt = t; }
            else {
              const i = m.completedActions++;
              m.lastConfirmedNode = m.expectedNodes[i]!; m.headingAtLastConfirmedNode = m.headingsAfter[i]!;
              robot.currentPoint = m.lastConfirmedNode; robot.heading = m.headingAtLastConfirmedNode;
              robot.positionConfidence = 'estimated'; s.phase = 'idle'; forceStop = true;
              event(tx, robot, m, now, `Sensores confirmaram o cruzamento ${m.lastConfirmedNode}.`);
              if (m.completedActions === m.totalActions) {
                finishMission(m, robot, 'completed', now);
                event(tx, robot, m, now, 'Último cruzamento confirmado; rota concluída.');
              }
            }
          }
        }
        if (!forceStop) {
          if (s.phase === 'turning') { left = m.actions[m.completedActions] === 'D' ? SPEED : -SPEED; right = -left; }
          else if (s.phase === 'centering' || crossing) left = right = SPEED;
          else if (input.line[0]) { left = SPEED / 2; right = SPEED; }
          else if (input.line[2]) { left = SPEED; right = SPEED / 2; }
          else left = right = SPEED;
        }
      }
    }
    if (m?.state === 'blocked' && m.currentBlock && hasLine && !m.currentBlock.cleared) {
      m.currentBlock.cleared = true;
      event(tx, robot, m, now, 'Linha reencontrada; aguardando resume.');
    }
    s.sequence = input.sequence; s.applied = input.applied; s.lastAt = t;
    s.output = { sequence: input.sequence, left, right };
    robot.sensorControl = s; robot.lastSeenAt = iso(now);
    robot.deviceState = left || right ? 'running' : m?.state === 'completed' ? 'finished' :
      m?.state === 'blocked' ? 'blocked' : m?.state === 'paused' || m?.state === 'uncertain' ? 'paused' : 'ready';
    robot.live = { at: iso(now), state: robot.deviceState, line: input.line,
      distanceCm: null, distanceValid: false, distanceAgeMs: null,
      blockId: m?.currentBlock?.blockId ?? null, blockReasons: m?.currentBlock?.reasons ?? [],
      ...(m ? { missionId: m.id, actionIndex: m.completedActions } : {}) };
    if (m) { m.updatedAt = iso(now); tx.set(C.missions, m.id, m); }
    tx.set(C.robots, robot.id, robot);
    return s.output;
  });
}
