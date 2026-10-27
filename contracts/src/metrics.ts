/**
 * Agregação de métricas (BACKEND_INTEGRATION.md §3.2) como função pura.
 *
 * É a definição de referência: o backend a usa nos testes para validar seus
 * rollups, e a suíte de contrato a usa para checar a consistência das
 * respostas de `/dashboard/metrics` e `/fleet/metrics` contra os registros.
 *
 * Regras:
 *  - `completionRate` em 0..100 com uma casa decimal; 0 quando não há missões;
 *  - durações só sobre missões CONCLUÍDAS com duração conhecida; sem amostra => null;
 *  - `totalStops = presenceStops + otherStops + unknownStops`;
 *  - `totalErrors` conta eventos de severidade error/critical.
 */
import type { DashboardMetrics, FleetMetrics, Mission, Robot, Alert } from './dashboard.js';
import type { EventSeverity } from './common.js';

export const PRESENCE_REASON = 'Presença detectada';

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2)
    : (sorted[mid] as number);
}

export type MetricsMission = Pick<
  Mission,
  'robotId' | 'status' | 'durationSeconds' | 'stopCount' | 'presenceStopCount' | 'stopReasons'
>;
export type MetricsEvent = { robotId: string; severity: EventSeverity };
export type MetricsAlert = Pick<Alert, 'acknowledged'> & { robotId?: string };

export function aggregateMetrics(
  missions: ReadonlyArray<MetricsMission>,
  events: ReadonlyArray<MetricsEvent>,
  alerts: ReadonlyArray<MetricsAlert>
): DashboardMetrics {
  const by = (status: Mission['status']) => missions.filter((m) => m.status === status).length;

  const durations = missions
    .filter((m) => m.status === 'completed' && m.durationSeconds !== null)
    .map((m) => m.durationSeconds as number);

  const totalStops = missions.reduce((s, m) => s + m.stopCount, 0);
  const presenceStops = missions.reduce((s, m) => s + m.presenceStopCount, 0);
  const otherStops = missions.reduce(
    (s, m) =>
      s +
      m.stopReasons
        .filter((r) => r.reason !== PRESENCE_REASON)
        .reduce((inner, r) => inner + r.count, 0),
    0
  );
  const completed = by('completed');

  return {
    totalMissions: missions.length,
    completedMissions: completed,
    inProgressMissions: by('in_progress'),
    failedMissions: by('failed'),
    abortedMissions: by('aborted'),
    indeterminateMissions: by('indeterminate'),
    avgDurationSeconds: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
      : null,
    medianDurationSeconds: median(durations),
    minDurationSeconds: durations.length ? Math.min(...durations) : null,
    maxDurationSeconds: durations.length ? Math.max(...durations) : null,
    totalStops,
    presenceStops,
    otherStops,
    unknownStops: Math.max(totalStops - presenceStops - otherStops, 0),
    completionRate: missions.length ? Math.round((completed / missions.length) * 1000) / 10 : 0,
    activeAlertsCount: alerts.filter((a) => !a.acknowledged).length,
    totalErrors: events.filter((e) => e.severity === 'error' || e.severity === 'critical').length,
  };
}

/** `onlineRobots` conta `online`, `busy` e `idle` (BACKEND_INTEGRATION.md §3.10). */
export function aggregateFleetMetrics(
  robots: ReadonlyArray<Pick<Robot, 'id' | 'name' | 'status'>>,
  missions: ReadonlyArray<MetricsMission>,
  events: ReadonlyArray<MetricsEvent>,
  alerts: ReadonlyArray<MetricsAlert>
): FleetMetrics {
  return {
    ...aggregateMetrics(missions, events, alerts),
    totalRobots: robots.length,
    onlineRobots: robots.filter((r) => ['online', 'busy', 'idle'].includes(r.status)).length,
    offlineRobots: robots.filter((r) => r.status === 'offline').length,
    errorRobots: robots.filter((r) => r.status === 'error').length,
    perRobot: robots.map((r) => {
      const scoped = aggregateMetrics(
        missions.filter((m) => m.robotId === r.id),
        events.filter((e) => e.robotId === r.id),
        alerts.filter((a) => a.robotId === r.id)
      );
      return {
        robotId: r.id,
        robotName: r.name,
        totalMissions: scoped.totalMissions,
        completedMissions: scoped.completedMissions,
        totalStops: scoped.totalStops,
        totalErrors: scoped.totalErrors,
        completionRate: scoped.completionRate,
        avgDurationSeconds: scoped.avgDurationSeconds,
      };
    }),
  };
}
