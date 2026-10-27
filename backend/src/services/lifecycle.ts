import { parseNodeId } from '@roboflow/contracts';
import { isTerminal, tryTransition } from '../domain/mission.js';
import type { CommandDoc, MissionDoc, RobotDoc } from '../domain/types.js';
import { C, type Tx } from '../store/types.js';
import { emitEvent, iso, removePending } from './common.js';

/**
 * Libera o robô de uma missão que terminou e ajusta posição/confiança.
 *  - concluída: posição = último cruzamento confirmado ("estimada");
 *  - cancelada/falha depois de se mover: o robô parou em algum ponto do
 *    trecho, então a posição passa a "desconhecida" e exige confirmação;
 *  - cancelada/falha antes de qualquer movimento: posição inalterada.
 */
export function releaseRobot(robot: RobotDoc, m: MissionDoc): void {
  if (robot.activeMissionId === m.id) robot.activeMissionId = null;
  if (m.state === 'completed') {
    robot.currentPoint = m.lastConfirmedNode;
    robot.heading = m.headingAtLastConfirmedNode;
    robot.positionConfidence = 'estimated';
  } else if (m.motionStartedAt) {
    robot.currentPoint = m.lastConfirmedNode;
    robot.heading = m.headingAtLastConfirmedNode;
    robot.positionConfidence = 'unknown';
  }
}

/** Marca a missão como incerta e invalida a confiança de posição do robô. Retorna true só se houve mudança. */
export function markUncertain(m: MissionDoc, robot: RobotDoc, now: Date): boolean {
  if (m.state === 'uncertain') return false; // já incerta: nada a registrar de novo
  const ok = tryTransition(m, 'uncertain', iso(now));
  if (ok) {
    m.positionConfidence = 'unknown';
    robot.positionConfidence = 'unknown';
  }
  return ok;
}

/** Fecha a missão em estado terminal e libera o robô. */
export function finishMission(
  m: MissionDoc,
  robot: RobotDoc,
  to: 'completed' | 'aborted' | 'failed',
  now: Date,
): void {
  tryTransition(m, to, iso(now));
  if (isTerminal(m.state)) releaseRobot(robot, m);
}

/**
 * Expira um comando pendente e aplica o efeito na missão.
 * Retorna true se algo mudou.
 */
export async function expireCommand(
  tx: Tx,
  cmd: CommandDoc,
  robot: RobotDoc,
  now: Date,
  reason: string,
): Promise<boolean> {
  if (cmd.status !== 'pending') return false;
  cmd.status = 'expired';
  cmd.reason = reason;
  cmd.resolvedAt = iso(now);
  removePending(robot, cmd.id);
  tx.set(C.commands, cmd.id, cmd);

  const m = await tx.get<MissionDoc>(C.missions, cmd.missionId);
  if (m && m.active) {
    if (cmd.type === 'load_route' && (m.state === 'queued' || m.state === 'loading')) {
      finishMission(m, robot, 'failed', now);
      emitEvent(
        tx,
        robot.id,
        m,
        {
          eventType: 'error',
          severity: 'error',
          roverState: 'idle',
          message: 'A fila não foi carregada no dispositivo a tempo; missão encerrada sem movimento.',
          payload: { commandId: cmd.id, reason },
        },
        now,
        { source: 'system' },
      );
    } else {
      emitEvent(
        tx,
        robot.id,
        m,
        {
          eventType: 'warning',
          severity: 'warning',
          message: `Comando ${cmd.type} expirou sem confirmação do dispositivo.`,
          payload: { commandId: cmd.id, reason },
        },
        now,
        { source: 'system' },
      );
      if (cmd.type === 'stop' || cmd.type === 'abort') m.cancelIntent = cmd.type;
    }
    tx.set(C.missions, m.id, m);
  }
  tx.set(C.robots, robot.id, robot);
  return true;
}

export function nodePoint(id: string): { x: number; y: number } {
  const p = parseNodeId(id);
  if (!p) throw new Error(`Nó inválido: ${id}`);
  return p;
}
