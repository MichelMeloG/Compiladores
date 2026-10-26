/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo } from 'react';
import {
  Route,
  CheckCircle2,
  Clock,
  PauseCircle,
  AlertTriangle,
  PlayCircle,
  XCircle,
  TrendingUp,
  Activity,
  ArrowRight,
  ShieldAlert,
  Bot,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { KpiCard } from '../components/common/KpiCard';
import { TimeFilter } from '../components/common/TimeFilter';
import { SeverityBadge } from '../components/common/StatusBadge';
import { MissionDetailModal } from '../components/missions/MissionDetailModal';
import { LogDetailModal } from '../components/logs/LogDetailModal';
import { getMissions } from '../services/missionsService';
import { getLogs } from '../services/logsService';
import { getAlerts, acknowledgeAlert } from '../services/alertsService';
import { getDashboardMetrics } from '../services/metricsService';
import { getFleetMetrics, getRobotById, getRobots } from '../services/robotsService';
import { RobotHeaderCard } from '../components/robots/RobotHeaderCard';
import { toErrorMessage } from '../services/api';
import { ErrorState } from '../components/common/ErrorState';
import {
  Alert,
  DashboardMetrics,
  FleetMetrics,
  GlobalFilterState,
  LogEvent,
  Mission,
  Robot,
  TimePeriod,
} from '../types';
import {
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatTimeOnly,
  getRobotStatusMeta,
  getRoverStateLabel,
} from '../utils/formatters';

interface DashboardProps {
  /**
   * Robô em foco. Ausente = painel da frota inteira, que é a tela
   * inicial: os mesmos indicadores, somados sobre todos os robôs, mais
   * o recorte por robô.
   */
  robotId?: string;
  onSelectRobot: (robotId: string) => void;
  onNavigateToMissions: () => void;
  onNavigateToLogs: () => void;
  onNavigateToAlerts: () => void;
  onNavigateToImport: () => void;
  refreshTrigger: number;
}

export const Dashboard: React.FC<DashboardProps> = ({
  robotId,
  onSelectRobot,
  onNavigateToLogs,
  onNavigateToAlerts,
  refreshTrigger,
}) => {
  const isFleet = robotId === undefined;
  const [period, setPeriod] = useState<TimePeriod>('all');
  const [startDate, setStartDate] = useState<string | undefined>();
  const [endDate, setEndDate] = useState<string | undefined>();
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [fleet, setFleet] = useState<FleetMetrics | null>(null);
  const [robots, setRobots] = useState<Robot[]>([]);
  const [robot, setRobot] = useState<Robot | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [recentLogs, setRecentLogs] = useState<LogEvent[]>([]);
  const [priorityAlerts, setPriorityAlerts] = useState<Alert[]>([]);

  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);
  const [selectedLog, setSelectedLog] = useState<LogEvent | null>(null);

  const filterState: GlobalFilterState = useMemo(
    () => ({ period, startDate, endDate, robotId }),
    [period, startDate, endDate, robotId]
  );

  useEffect(() => {
    let mounted = true;
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      try {
        // O painel de um robô e o da frota consomem os mesmos indicadores:
        // muda a rota que os agrega e o contexto exibido ao redor deles.
        const [mMetrics, mContext, mMissions, mLogs, mAlerts] = await Promise.all([
          isFleet ? getFleetMetrics(filterState) : getDashboardMetrics(filterState),
          isFleet ? getRobots() : getRobotById(robotId as string),
          getMissions(filterState),
          getLogs({ ...filterState, period }),
          getAlerts({ robotId, status: 'unacknowledged' }),
        ]);

        if (mounted) {
          setMetrics(mMetrics);
          setFleet(isFleet ? (mMetrics as FleetMetrics) : null);
          setRobots(isFleet ? (mContext as Robot[]) : []);
          setRobot(isFleet ? null : (mContext as Robot | null));
          setMissions(mMissions);
          setRecentLogs(mLogs.slice(0, 6));
          setPriorityAlerts(mAlerts.slice(0, 3));
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(toErrorMessage(err));
          setMetrics(null);
          setFleet(null);
          setRobots([]);
          setRobot(null);
          setMissions([]);
          setRecentLogs([]);
          setPriorityAlerts([]);
          setLoading(false);
        }
      }
    };

    fetchData();
    return () => {
      mounted = false;
    };
  }, [filterState, refreshTrigger, period, retryCount, isFleet, robotId]);

  // Handle local acknowledgment
  const handleAcknowledge = async (alertId: string) => {
    await acknowledgeAlert(alertId);
    setPriorityAlerts((prev) => prev.filter((a) => a.id !== alertId));
  };

  // Activity over time data
  const activityData = useMemo(() => {
    const map = new Map<string, { date: string; total: number; completed: number }>();
    for (const m of missions) {
      const d = new Date(m.startedAt);
      const dateKey = !isNaN(d.getTime()) ? d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : 'N/A';
      const existing = map.get(dateKey) || { date: dateKey, total: 0, completed: 0 };
      existing.total++;
      if (m.status === 'completed') existing.completed++;
      map.set(dateKey, existing);
    }
    return Array.from(map.values()).reverse();
  }, [missions]);

  // Status donut data
  const statusData = useMemo(() => {
    if (!metrics) return [];
    return [
      { name: 'Concluídas', value: metrics.completedMissions, color: '#4AAB79' },
      { name: 'Em andamento', value: metrics.inProgressMissions, color: '#3498DB' },
      { name: 'Interrompidas', value: metrics.abortedMissions, color: '#E7B85C' },
      { name: 'Com falha', value: metrics.failedMissions, color: '#D96B6B' },
    ].filter((item) => item.value > 0);
  }, [metrics]);

  // Duration evolution data (completed missions with valid duration)
  const durationData = useMemo(() => {
    return missions
      .filter((m) => m.status === 'completed' && m.durationSeconds !== null)
      .slice(0, 10)
      .reverse()
      .map((m) => ({
        id: m.id,
        duration: m.durationSeconds,
        stops: m.stopCount,
      }));
  }, [missions]);

  // Side-by-side comparison of the fleet, for the home screen only.
  const perRobotData = useMemo(() => {
    if (!fleet) return [];
    return fleet.perRobot.map((item) => ({
      robotId: item.robotId,
      name: item.robotName,
      concluidas: item.completedMissions,
      outras: Math.max(item.totalMissions - item.completedMissions, 0),
      paradas: item.totalStops,
    }));
  }, [fleet]);

  // Stops analysis data
  const stopsBarData = useMemo(() => {
    if (!metrics) return [];
    return [
      { name: 'Presença Detectada', count: metrics.presenceStops, fill: '#65B98A' },
      { name: 'Outros Motivos', count: metrics.otherStops, fill: '#BFE8D0' },
      { name: 'Não Especificado', count: metrics.unknownStops, fill: '#E4ECE6' },
    ];
  }, [metrics]);

  return (
    <div className="space-y-6">
      {/* Top Controls Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-white p-4 rounded-xl border border-[#E4ECE6]">
        <div>
          <h2 className="text-base font-bold text-[#245C43]">
            {isFleet
              ? 'Visão Geral da Frota'
              : `Painel do robô ${robot?.name ?? robotId}`}
          </h2>
          <p className="text-xs text-[#78877D]">
            {isFleet
              ? 'Atividade, percursos e alertas de todos os robôs conectados.'
              : 'Os mesmos indicadores da tela inicial, restritos a este robô.'}
          </p>
        </div>

        <TimeFilter
          period={period}
          onPeriodChange={setPeriod}
          startDate={startDate}
          endDate={endDate}
          onCustomDateChange={(start, end) => {
            setStartDate(start);
            setEndDate(end);
          }}
        />
      </div>

      {error ? (
        <ErrorState
          message={error}
          onRetry={() => setRetryCount((prev) => prev + 1)}
        />
      ) : (
      <>

      {/* Scope context: the open robot, or the roster of the whole fleet */}
      {!isFleet && robot && <RobotHeaderCard robot={robot} loading={loading} />}

      {isFleet && (
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Bot className="w-4 h-4 text-[#245C43]" />
              <h3 className="text-sm font-bold text-[#25372D]">
                Robôs conectados
              </h3>
            </div>
            {fleet && (
              <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums text-[#78877D]">
                <span className="text-[#4AAB79] font-semibold">
                  {fleet.onlineRobots} online
                </span>
                <span>{fleet.offlineRobots} offline</span>
                {fleet.errorRobots > 0 && (
                  <span className="text-[#D96B6B] font-semibold">
                    {fleet.errorRobots} com falha
                  </span>
                )}
              </div>
            )}
          </div>

          {robots.length === 0 ? (
            <div className="py-8 text-center text-xs text-[#78877D]">
              Nenhum robô conectado à central.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
              {robots.map((item) => {
                const meta = getRobotStatusMeta(item.status);
                const summary = fleet?.perRobot.find(
                  (entry) => entry.robotId === item.id
                );

                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onSelectRobot(item.id)}
                    className="text-left p-4 rounded-xl border border-[#E4ECE6] bg-[#F7FAF8] hover:bg-white hover:border-[#BFE8D0] hover:shadow-xs transition-all"
                  >
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-[#25372D] truncate">
                          {item.name}
                        </div>
                        <div className="text-[10px] font-mono tabular-nums text-[#78877D]">
                          {item.id}
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium shrink-0 ${meta.badgeClass}`}
                      >
                        <span
                          className={`w-1.5 h-1.5 rounded-full ${meta.dotClass}`}
                          aria-hidden="true"
                        />
                        {meta.label}
                      </span>
                    </div>

                    <div className="text-[11px] text-[#78877D] space-y-0.5">
                      <div className="flex items-center justify-between">
                        <span>Estado</span>
                        <span className="text-[#25372D] truncate ml-2">
                          {getRoverStateLabel(item.roverState)}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Missões</span>
                        <span className="font-mono tabular-nums text-[#25372D]">
                          {summary ? summary.totalMissions : '—'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Bateria</span>
                        <span className="font-mono tabular-nums text-[#25372D]">
                          {item.batteryPercent === null ||
                          item.batteryPercent === undefined
                            ? '—'
                            : `${Math.round(item.batteryPercent)}%`}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>Contato</span>
                        <span className="text-[#25372D]">
                          {formatRelativeTime(item.lastSeenAt)}
                        </span>
                      </div>
                    </div>

                    {item.activeAlertsCount > 0 && (
                      <div className="mt-2 pt-2 border-t border-[#E4ECE6] flex items-center gap-1.5 text-[10px] font-semibold text-[#9A7D0A]">
                        <AlertTriangle className="w-3 h-3" />
                        <span>
                          {item.activeAlertsCount} alerta
                          {item.activeAlertsCount > 1 ? 's' : ''} em aberto
                        </span>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          title="Total de Missões"
          value={metrics ? metrics.totalMissions : 0}
          description="Viagens registradas no período"
          icon={Route}
          loading={loading}
          highlight
        />

        <KpiCard
          title="Missões Concluídas"
          value={metrics ? metrics.completedMissions : 0}
          description="Chegadas confirmadas ao destino"
          icon={CheckCircle2}
          loading={loading}
        />

        <KpiCard
          title="Taxa de Conclusão"
          value={metrics ? formatPercent(metrics.completionRate) : '0%'}
          description="Eficiência de entrega de ponta a ponta"
          icon={TrendingUp}
          loading={loading}
        />

        <KpiCard
          title="Tempo Médio Percurso"
          value={metrics ? formatDuration(metrics.avgDurationSeconds) : '—'}
          description="Duração média entre origem e destino"
          icon={Clock}
          loading={loading}
        />

        <KpiCard
          title="Em Andamento"
          value={metrics ? metrics.inProgressMissions : 0}
          description={isFleet ? 'Robôs navegando ou em espera' : 'Rotas abertas deste robô'}
          icon={PlayCircle}
          loading={loading}
        />

        <KpiCard
          title="Total de Paradas"
          value={metrics ? metrics.totalStops : 0}
          description={
            metrics
              ? `${metrics.presenceStops} por detecção de presença`
              : 'Episódios de interrupção'
          }
          icon={PauseCircle}
          loading={loading}
        />

        <KpiCard
          title="Missões com Falha"
          value={metrics ? metrics.failedMissions : 0}
          description="Interrompidas ou travamento de rota"
          icon={XCircle}
          loading={loading}
        />

        <KpiCard
          title="Alertas Ativos"
          value={metrics ? metrics.activeAlertsCount : 0}
          description="Eventos que exigem atenção"
          icon={AlertTriangle}
          loading={loading}
          highlight={Boolean(metrics && metrics.activeAlertsCount > 0)}
        />
      </div>

      {/* Analytics Charts Section (2 Columns) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Activity Trend (Line/Area) */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-[#E4ECE6] p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-bold text-[#25372D]">
                Atividade Operacional por Data
              </h3>
              <p className="text-xs text-[#78877D]">
                Volume total de viagens vs. viagens concluídas
              </p>
            </div>
          </div>

          <div className="h-64 w-full">
            {activityData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#78877D]">
                Sem dados de atividade no período
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={activityData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#BFE8D0" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="#BFE8D0" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="colorComp" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#65B98A" stopOpacity={0.8} />
                      <stop offset="95%" stopColor="#65B98A" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E4ECE6" />
                  <XAxis dataKey="date" tick={{ fill: '#78877D', fontSize: 11 }} tickLine={false} />
                  <YAxis tick={{ fill: '#78877D', fontSize: 11 }} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderRadius: '8px',
                      border: '1px solid #E4ECE6',
                      fontSize: '12px',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="total"
                    name="Total de Missões"
                    stroke="#245C43"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorTotal)"
                  />
                  <Area
                    type="monotone"
                    dataKey="completed"
                    name="Concluídas"
                    stroke="#4AAB79"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorComp)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Status Distribution (Donut Chart) */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 flex flex-col">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Distribuição de Status
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Proporção de desfecho das viagens
          </p>

          <div className="h-44 w-full flex items-center justify-center">
            {statusData.length === 0 ? (
              <span className="text-xs text-[#78877D]">Sem missões registradas</span>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusData}
                    innerRadius={48}
                    outerRadius={68}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {statusData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderRadius: '8px',
                      border: '1px solid #E4ECE6',
                      fontSize: '12px',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="mt-auto pt-3 border-t border-[#E4ECE6] space-y-2">
            {statusData.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-[#25372D]">{item.name}</span>
                </div>
                <div className="font-mono tabular-nums text-[#78877D]">
                  <strong className="text-[#25372D]">{item.value}</strong> (
                  {metrics && metrics.totalMissions > 0
                    ? Math.round((item.value / metrics.totalMissions) * 100)
                    : 0}
                  %)
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Fleet-only: how the robots compare against each other */}
      {isFleet && perRobotData.length > 0 && (
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Comparativo entre robôs
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Missões concluídas, não concluídas e paradas por robô no período
          </p>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={perRobotData}
                margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
              >
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E4ECE6" />
                <XAxis
                  dataKey="name"
                  tick={{ fill: '#78877D', fontSize: 11 }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#78877D', fontSize: 11 }}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    borderRadius: '8px',
                    border: '1px solid #E4ECE6',
                    fontSize: '12px',
                  }}
                />
                <Bar
                  dataKey="concluidas"
                  name="Concluídas"
                  stackId="missions"
                  fill="#4AAB79"
                  radius={[0, 0, 0, 0]}
                />
                <Bar
                  dataKey="outras"
                  name="Não concluídas"
                  stackId="missions"
                  fill="#E7B85C"
                  radius={[4, 4, 0, 0]}
                />
                <Bar dataKey="paradas" name="Paradas" fill="#BFE8D0" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Secondary Analytics: Duration & Stops Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Duration Evolution */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Duração dos Percursos Recentes
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Tempo em segundos para viagens concluídas
          </p>

          <div className="h-56 w-full">
            {durationData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#78877D]">
                Nenhuma viagem concluída com horário registrado
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={durationData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E4ECE6" />
                  <XAxis dataKey="id" tick={{ fill: '#78877D', fontSize: 10 }} tickLine={false} />
                  <YAxis tick={{ fill: '#78877D', fontSize: 11 }} tickLine={false} unit="s" />
                  <Tooltip
                    formatter={(val) => [`${val} segundos`, 'Duração']}
                    contentStyle={{
                      backgroundColor: '#FFFFFF',
                      borderRadius: '8px',
                      border: '1px solid #E4ECE6',
                      fontSize: '12px',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="duration"
                    name="Duração"
                    stroke="#245C43"
                    strokeWidth={2}
                    dot={{ fill: '#65B98A', r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Stops by Reason */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Análise de Paradas por Categoria
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Diferenciação entre paradas preventivas de presença e outros fatores
          </p>

          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stopsBarData} layout="vertical" margin={{ top: 10, right: 20, left: 20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#E4ECE6" />
                <XAxis type="number" tick={{ fill: '#78877D', fontSize: 11 }} tickLine={false} allowDecimals={false} />
                <YAxis dataKey="name" type="category" tick={{ fill: '#25372D', fontSize: 11 }} tickLine={false} width={120} />
                <Tooltip
                  formatter={(val) => [`${val} paradas`, 'Ocorrências']}
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    borderRadius: '8px',
                    border: '1px solid #E4ECE6',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Lower Section: Priority Alerts & Recent Activity Feed */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Priority Alerts Card */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-[#E7B85C]" />
              <h3 className="text-sm font-bold text-[#25372D]">Alertas Prioritários</h3>
            </div>
            <button
              type="button"
              onClick={onNavigateToAlerts}
              className="text-xs font-semibold text-[#245C43] hover:underline"
            >
              Ver todos
            </button>
          </div>

          <div className="space-y-3 flex-1">
            {priorityAlerts.length === 0 ? (
              <div className="h-32 flex flex-col items-center justify-center text-center text-xs text-[#78877D]">
                <CheckCircle2 className="w-6 h-6 text-[#4AAB79] mb-1.5" />
                <span>Nenhum alerta pendente no momento.</span>
              </div>
            ) : (
              priorityAlerts.map((alt) => (
                <div
                  key={alt.id}
                  className="p-3 bg-[#F7FAF8] rounded-lg border border-[#E4ECE6] space-y-1.5"
                >
                  <div className="flex items-center justify-between">
                    <SeverityBadge severity={alt.severity} />
                    <span className="text-[11px] font-mono tabular-nums text-[#78877D]">
                      {formatTimeOnly(alt.timestamp)}
                    </span>
                  </div>

                  <div className="text-xs font-semibold text-[#25372D]">{alt.title}</div>
                  <p className="text-[11px] text-[#78877D] line-clamp-2 leading-relaxed">
                    {alt.description}
                  </p>

                  <div className="flex items-center justify-between pt-1 text-[11px]">
                    <span className="font-mono text-[#245C43] font-semibold">
                      {alt.missionId || 'Geral'}
                    </span>
                    <button
                      type="button"
                      onClick={() => handleAcknowledge(alt.id)}
                      className="text-xs font-semibold text-[#245C43] hover:underline"
                    >
                      Reconhecer
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Recent Events Activity Stream */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-[#E4ECE6] p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-[#245C43]" />
              <h3 className="text-sm font-bold text-[#25372D]">
                {isFleet ? 'Atividade Recente da Frota' : 'Atividade Recente do Robô'}
              </h3>
            </div>
            <button
              type="button"
              onClick={onNavigateToLogs}
              className="text-xs font-semibold text-[#245C43] hover:underline flex items-center gap-1"
            >
              <span>Ver histórico completo</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#E4ECE6] text-[#78877D] text-[11px] font-semibold uppercase">
                  <th className="py-2.5 px-3">Horário</th>
                  {isFleet && <th className="py-2.5 px-3">Robô</th>}
                  <th className="py-2.5 px-3">Missão</th>
                  <th className="py-2.5 px-3">Severidade</th>
                  <th className="py-2.5 px-3">Mensagem</th>
                  <th className="py-2.5 px-3 text-right">Comando</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E4ECE6]/50">
                {recentLogs.map((log) => (
                  <tr
                    key={log.id}
                    onClick={() => setSelectedLog(log)}
                    className="hover:bg-[#F0F7F3]/50 cursor-pointer transition-colors"
                  >
                    <td className="py-2.5 px-3 font-mono tabular-nums text-[#78877D] whitespace-nowrap">
                      {formatTimeOnly(log.timestamp)}
                    </td>
                    {isFleet && (
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelectRobot(log.robotId);
                          }}
                          className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-[#F0F7F3] text-[#245C43] hover:bg-[#DDF4E5] transition-colors"
                        >
                          {log.robotId}
                        </button>
                      </td>
                    )}
                    <td className="py-2.5 px-3 font-mono font-medium text-[#245C43] whitespace-nowrap">
                      {log.missionId}
                    </td>
                    <td className="py-2.5 px-3 whitespace-nowrap">
                      <SeverityBadge severity={log.severity} />
                    </td>
                    <td className="py-2.5 px-3 text-[#25372D] max-w-xs truncate">
                      {log.message}
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {log.command ? (
                        <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-[#F0F7F3] text-[#245C43]">
                          {log.command}
                        </span>
                      ) : (
                        <span className="text-[#78877D]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      </>
      )}

      {/* Modals */}
      {selectedMission && (
        <MissionDetailModal
          mission={selectedMission}
          onClose={() => setSelectedMission(null)}
        />
      )}

      {selectedLog && (
        <LogDetailModal
          event={selectedLog}
          onClose={() => setSelectedLog(null)}
        />
      )}
    </div>
  );
};
