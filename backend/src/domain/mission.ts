import {
  ACTIVE_STATES,
  MISSION_TRANSITIONS,
  PRESENCE_REASON,
  publicMissionStatus,
  type MissionState,
} from '@roboflow/contracts';
import { conflictState } from '../errors.js';
import type { MissionDoc } from './types.js';

/**
 * Extensões à tabela de `@roboflow/contracts` (registradas em CONTRACT_GAPS.md):
 *  - `running -> aborted`  abort confirmado com o robô em movimento;
 *  - `loading -> aborted`  abort durante o carregamento;
 *  - `uncertain -> completed | blocked` reconciliação por snapshot do dispositivo.
 */
const EXTRA: Partial<Record<MissionState, readonly MissionState[]>> = {
  running: ['aborted'],
  loading: ['aborted'],
  uncertain: ['completed', 'blocked'],
};

export function canMove(from: MissionState, to: MissionState): boolean {
  return MISSION_TRANSITIONS[from].includes(to) || (EXTRA[from]?.includes(to) ?? false);
}

export const isActive = (s: MissionState): boolean => ACTIVE_STATES.includes(s);
export const isTerminal = (s: MissionState): boolean => !isActive(s);

/** Muda o estado. Lança 409 se a transição não for permitida. */
export function transition(m: MissionDoc, to: MissionState, nowIso: string): void {
  if (m.state === to) return;
  if (!canMove(m.state, to)) {
    throw conflictState(`Transição inválida da missão: ${m.state} -> ${to}.`);
  }
  m.state = to;
  m.status = publicMissionStatus(to);
  m.active = isActive(to);
  m.updatedAt = nowIso;
  if (!m.active) {
    if (to === 'completed') {
      m.endedAt = nowIso;
      m.durationSeconds = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(m.startedAt)) / 1000));
    } else if (!m.closedWithoutConfirmation) {
      m.endedAt = nowIso;
      m.durationSeconds = Math.max(0, Math.round((Date.parse(nowIso) - Date.parse(m.startedAt)) / 1000));
    }
  }
}

/** Tenta a transição; devolve false (em vez de lançar) se não for permitida. */
export function tryTransition(m: MissionDoc, to: MissionState, nowIso: string): boolean {
  if (m.state === to) return true;
  if (!canMove(m.state, to)) return false;
  transition(m, to, nowIso);
  return true;
}

// ---------------------------------------------------------------------------
// Classificação das paradas (uma vez por episódio de bloqueio)
// ---------------------------------------------------------------------------

const REASON_PRIORITY = ['obstacle', 'line_lost', 'sensor_invalid', 'sensor_stale', 'fault', 'stop_requested'];

const REASON_LABEL: Record<string, string> = {
  obstacle: PRESENCE_REASON,
  line_lost: 'Perda de linha',
  sensor_invalid: 'Leitura de sensor inválida',
  sensor_stale: 'Leitura de sensor vencida',
  fault: 'Falha do dispositivo',
  stop_requested: 'Parada solicitada',
};

export type StopClass = 'presence' | 'other' | 'unknown';

export function classifyStop(reasons: readonly string[]): { cls: StopClass; label: string | null } {
  if (reasons.includes('obstacle')) return { cls: 'presence', label: PRESENCE_REASON };
  const primary = REASON_PRIORITY.find((r) => reasons.includes(r));
  if (primary) return { cls: 'other', label: REASON_LABEL[primary] as string };
  return { cls: 'unknown', label: null };
}

/** Registra UM episódio de parada na missão. */
export function countStop(m: MissionDoc, reasons: readonly string[]): void {
  const { cls, label } = classifyStop(reasons);
  m.stopCount += 1;
  if (cls === 'presence') m.presenceStopCount += 1;
  else if (cls === 'other') m.otherStopCount += 1;
  else m.unknownStopCount += 1;
  if (label) {
    const entry = m.stopReasons.find((r) => r.reason === label);
    if (entry) entry.count += 1;
    else m.stopReasons.push({ reason: label, count: 1 });
  }
}
