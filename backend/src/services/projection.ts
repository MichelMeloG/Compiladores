import {
  deviceStateToRoverState,
  type Alert,
  type ExecutionState,
  type LogEvent,
  type Mission,
  type Robot,
  type RobotStatus,
} from '@roboflow/contracts';
import type { Config } from '../config.js';
import type { AlertDoc, CommandDoc, EventDoc, MissionDoc, RobotDoc } from '../domain/types.js';
import { isOnline } from './common.js';
import { toPublicCommand } from './operator.js';

export function robotStatus(r: RobotDoc, now: Date, cfg: Pick<Config, 'offlineAfterMs' | 'offlineAfterIdleMs'>): RobotStatus {
  if (r.maintenance) return 'maintenance';
  if (!isOnline(r, now, cfg)) return 'offline';
  if (r.deviceState === 'fault') return 'error';
  if (r.activeMissionId) return 'busy';
  return 'idle';
}

export function publicRobot(r: RobotDoc, now: Date, cfg: Pick<Config, 'offlineAfterMs' | 'offlineAfterIdleMs'>, activeAlerts: number): Robot {
  const state = r.live?.state ?? r.deviceState;
  return {
    id: r.id,
    name: r.name,
    ...(r.area ? { area: r.area } : {}),
    ...(r.model ? { model: r.model } : {}),
    status: robotStatus(r, now, cfg),
    ...(state ? { roverState: deviceStateToRoverState(state, r.live?.blockReasons) } : {}),
    ...(r.activeMissionId ? { currentMissionId: r.activeMissionId } : {}),
    batteryPercent: r.batteryPercent,
    currentPoint: r.currentPoint,
    ...(r.firmwareVersion ? { firmwareVersion: r.firmwareVersion } : {}),
    lastSeenAt: r.lastSeenAt ?? r.createdAt,
    activeAlertsCount: activeAlerts,
  };
}

export function publicEvent(e: EventDoc): LogEvent {
  return {
    id: e.id,
    // Eventos sem missão (diagnóstico) só saem por /robots/:id/events.
    missionId: e.missionId ?? '',
    robotId: e.robotId,
    timestamp: e.timestamp,
    eventType: e.eventType,
    severity: e.severity,
    message: e.message,
    ...(e.command ? { command: e.command } : {}),
    ...(e.roverState ? { roverState: e.roverState } : {}),
    ...(e.payload ? { payload: e.payload } : {}),
    ...(e.raw ? { raw: e.raw } : {}),
  };
}

/** Evento de dispositivo: `missionId` ausente quando não há missão. */
export function publicRobotEvent(e: EventDoc): Omit<LogEvent, 'missionId'> & { missionId?: string } {
  const { missionId, ...rest } = publicEvent(e);
  return e.missionId ? { ...rest, missionId } : rest;
}

export function publicMission(m: MissionDoc, events?: EventDoc[]): Mission {
  return {
    id: m.id,
    robotId: m.robotId,
    origin: m.origin,
    destination: m.destination,
    status: m.status,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
    durationSeconds: m.durationSeconds,
    stopCount: m.stopCount,
    presenceStopCount: m.presenceStopCount,
    errorCount: m.errorCount,
    eventCount: m.eventCount,
    stopReasons: m.stopReasons,
    ...(events ? { events: events.map(publicEvent) } : {}),
  };
}

export function publicAlert(a: AlertDoc): Alert {
  return {
    id: a.id,
    title: a.title,
    description: a.description,
    severity: a.severity,
    timestamp: a.timestamp,
    ...(a.missionId ? { missionId: a.missionId } : {}),
    ...(a.robotId ? { robotId: a.robotId } : {}),
    occurrenceCount: a.occurrenceCount,
    acknowledged: a.acknowledged,
    ...(a.acknowledgedAt ? { acknowledgedAt: a.acknowledgedAt } : {}),
    relatedEventIds: a.relatedEventIds,
  };
}

export function executionState(m: MissionDoc, robot: RobotDoc, pending: CommandDoc[]): ExecutionState {
  const done = m.completedActions >= m.totalActions;
  const settledAtNode = ['queued', 'loading', 'ready', 'completed'].includes(m.state);
  return {
    missionId: m.id,
    deviceId: m.robotId,
    sessionId: robot.sessionId,
    state: m.state,
    actionIndex: done ? null : m.completedActions,
    completedActions: m.completedActions,
    totalActions: m.totalActions,
    lastConfirmedNode: m.lastConfirmedNode,
    expectedNode: done ? null : (m.expectedNodes[m.completedActions] ?? null),
    atNode: settledAtNode,
    positionConfidence: m.positionConfidence,
    headingAtLastConfirmedNode: m.headingAtLastConfirmedNode,
    blockId: m.currentBlock?.blockId ?? null,
    blockReasons: m.currentBlock?.reasons ?? [],
    pendingCommands: pending.map(toPublicCommand),
    updatedAt: m.updatedAt,
  };
}
