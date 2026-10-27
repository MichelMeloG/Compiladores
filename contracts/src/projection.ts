/**
 * Projeção dos eventos do dispositivo para os enums PÚBLICOS do frontend
 * (backend/README.md §9.1). Nenhum valor novo de enum é criado: detalhes extras
 * vão no `payload` do `LogEvent`.
 *
 * Regras:
 *  - `action_started` -> `command`; `action_completed` intermediária -> `state_change`;
 *  - `block_started` com obstáculo -> `presence_detected` + `stop_preventive`
 *    (uma parada por TRANSIÇÃO de bloqueio, nunca por amostra de telemetria);
 *  - `ack` de `resume` -> `resume` (só quando a retomada foi aceita);
 *  - `mission_completed` -> `destination_reached` + `mission_end`;
 *  - `fault` -> `error` (ou `warning` quando a gravidade é `warning`);
 *  - telemetria, snapshot e hello não geram linha de log.
 */
import type { EventSeverity, EventType, RoverState } from './common.js';
import type { DeviceEventMessage } from './device.js';
import type { DeviceCommandType, DeviceState } from './mission.js';

export interface ProjectedLogEvent {
  eventType: EventType;
  severity: EventSeverity;
  roverState: RoverState;
  command?: string;
  message: string;
  payload?: Record<string, unknown>;
}

export interface ProjectionContext {
  /** Tipo do comando respondido, quando o evento é `ack`/`reject`. */
  ackedCommandType?: DeviceCommandType;
  /** Destino esperado da ação (`x,y`) para mensagens de progresso. */
  totalActions?: number;
}

export function deviceStateToRoverState(state: DeviceState, blockReasons?: string[]): RoverState {
  switch (state) {
    case 'initializing':
    case 'ready':
      return 'idle';
    case 'running':
      return 'moving';
    case 'blocked':
      return blockReasons?.includes('obstacle') ? 'obstacle_hold' : 'stopped';
    case 'paused':
      return 'stopped';
    case 'finished':
      return 'completed';
    case 'fault':
      return 'error';
  }
}

export function projectDeviceEvent(
  event: DeviceEventMessage,
  ctx: ProjectionContext = {}
): ProjectedLogEvent[] {
  switch (event.type) {
    case 'action_started':
      return [
        {
          eventType: 'command',
          severity: 'info',
          roverState: 'moving',
          command: event.command ?? `acao ${event.actionIndex}`,
          message: `Ação ${event.actionIndex + 1} iniciada.`,
          payload: { actionIndex: event.actionIndex },
        },
      ];

    case 'action_completed': {
      const last = ctx.totalActions !== undefined && event.actionIndex + 1 >= ctx.totalActions;
      // A última chegada é descrita por `mission_completed`; aqui só o progresso.
      if (last) return [];
      return [
        {
          eventType: 'state_change',
          severity: 'info',
          roverState: 'navigating',
          message: `Cruzamento (${event.expectedNode.replace(',', ', ')}) alcançado.`,
          payload: { actionIndex: event.actionIndex, expectedNode: event.expectedNode },
        },
      ];
    }

    case 'mission_completed':
      return [
        {
          eventType: 'destination_reached',
          severity: 'info',
          roverState: 'completed',
          message: 'Chegada ao destino confirmada.',
          payload: { completedActions: event.completedActions },
        },
        {
          eventType: 'mission_end',
          severity: 'info',
          roverState: 'idle',
          message: 'Rota concluída.',
          payload: { completedActions: event.completedActions },
        },
      ];

    case 'block_started': {
      const out: ProjectedLogEvent[] = [];
      const payload = { blockId: event.blockId, reasons: event.reasons };
      if (event.reasons.includes('obstacle')) {
        out.push({
          eventType: 'presence_detected',
          severity: 'warning',
          roverState: 'obstacle_hold',
          message:
            event.distanceCm != null
              ? `PROX ${Math.round(event.distanceCm)}cm — obstáculo detectado à frente.`
              : 'Obstáculo detectado à frente.',
          payload,
        });
      }
      out.push({
        eventType: 'stop_preventive',
        severity: 'warning',
        roverState: event.reasons.includes('obstacle') ? 'obstacle_hold' : 'stopped',
        command: 'stop()',
        message: 'Parada preventiva executada. Aguardando liberação.',
        payload,
      });
      return out;
    }

    case 'ack':
      if (ctx.ackedCommandType === 'resume') {
        return [
          {
            eventType: 'resume',
            severity: 'info',
            roverState: 'moving',
            command: 'resume_line_following()',
            message: 'Retomada aceita, seguimento de linha retomado.',
          },
        ];
      }
      if (ctx.ackedCommandType === 'stop' || ctx.ackedCommandType === 'abort') {
        return [
          {
            eventType: 'state_change',
            severity: 'info',
            roverState: 'stopped',
            message:
              ctx.ackedCommandType === 'abort' ? 'Cancelamento confirmado.' : 'Parada confirmada.',
          },
        ];
      }
      return [];

    case 'reject':
      return [
        {
          eventType: 'warning',
          severity: 'warning',
          roverState: 'unknown',
          message: `Comando recusado pelo dispositivo: ${event.reason}.`,
          payload: { replyTo: event.replyTo, reason: event.reason },
        },
      ];

    case 'fault':
      return [
        {
          eventType: event.severity === 'warning' ? 'warning' : 'error',
          severity: event.severity,
          roverState: 'error',
          message: event.message,
          payload: { code: event.code },
        },
      ];

    case 'block_cleared':
    case 'telemetry':
    case 'snapshot':
      return [];
  }
}
