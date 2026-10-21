/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import {
  Clock,
  CheckCircle2,
  PauseCircle,
  TrendingUp,
  AlertTriangle,
  Zap,
  MapPin,
  Compass,
} from 'lucide-react';
import { KpiCard } from '../components/common/KpiCard';
import { getMissions } from '../services/missionsService';
import { getLogs } from '../services/logsService';
import { getDashboardMetrics } from '../services/metricsService';
import { toErrorMessage } from '../services/api';
import { ErrorState } from '../components/common/ErrorState';
import { DashboardMetrics, LogEvent, Mission } from '../types';
import { formatDuration, formatPercent } from '../utils/formatters';

interface PerformanceProps {
  refreshTrigger: number;
}

export const Performance: React.FC<PerformanceProps> = ({ refreshTrigger }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [logs, setLogs] = useState<LogEvent[]>([]);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [mMetrics, mMissions, mLogs] = await Promise.all([
          getDashboardMetrics(),
          getMissions(),
          getLogs(),
        ]);
        if (mounted) {
          setMetrics(mMetrics);
          setMissions(mMissions);
          setLogs(mLogs);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(toErrorMessage(err));
          setMetrics(null);
          setMissions([]);
          setLogs([]);
          setLoading(false);
        }
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, [refreshTrigger, retryCount]);

  // Stops per mission average
  const avgStopsPerMission = useMemo(() => {
    if (!missions.length) return '0.0';
    const total = missions.reduce((acc, m) => acc + m.stopCount, 0);
    return (total / missions.length).toFixed(1);
  }, [missions]);

  // Trips by Origin & Destination
  const routeDistribution = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of missions) {
      const key = `${m.origin} → ${m.destination}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return Array.from(map.entries()).map(([route, count]) => ({ route, count }));
  }, [missions]);

  // Hourly distribution of operations
  const hourlyActivity = useMemo(() => {
    const hours = Array.from({ length: 12 }, (_, i) => i + 7); // 07:00 to 18:00
    const counts = new Map<number, number>();

    for (const m of missions) {
      const d = new Date(m.startedAt);
      if (!isNaN(d.getTime())) {
        const h = d.getHours();
        counts.set(h, (counts.get(h) || 0) + 1);
      }
    }

    return hours.map((hour) => ({
      hour: `${hour.toString().padStart(2, '0')}:00`,
      missões: counts.get(hour) || 0,
    }));
  }, [missions]);

  // Duration trend with moving average
  const durationTrend = useMemo(() => {
    return missions
      .filter((m) => m.status === 'completed' && m.durationSeconds !== null)
      .slice(0, 15)
      .reverse()
      .map((m, idx, arr) => {
        // Simple 3-point moving average
        const window = arr.slice(Math.max(0, idx - 2), idx + 1);
        const avg = Math.round(
          window.reduce((acc, curr) => acc + (curr.durationSeconds || 0), 0) / window.length
        );

        return {
          missionId: m.id,
          duracao: m.durationSeconds,
          mediaMovel: avg,
        };
      });
  }, [missions]);

  // Error breakdown by category
  const errorBreakdown = useMemo(() => {
    let sensor = 0;
    let motor = 0;
    let obstacle = 0;
    let timeout = 0;
    let other = 0;

    for (const l of logs) {
      if (l.severity === 'error' || l.severity === 'critical') {
        const msg = l.message.toLowerCase();
        if (msg.includes('sensor') || msg.includes('odometria')) sensor++;
        else if (msg.includes('motor') || msg.includes('tração')) motor++;
        else if (msg.includes('obstáculo') || msg.includes('colisão')) obstacle++;
        else if (msg.includes('tempo') || msg.includes('timeout') || msg.includes('limite')) timeout++;
        else other++;
      }
    }

    return [
      { name: 'Obstáculo Bloqueante', value: obstacle, color: '#D96B6B' },
      { name: 'Tempo Limite Excedido', value: timeout, color: '#E7B85C' },
      { name: 'Falha de Sensor', value: sensor, color: '#3498DB' },
      { name: 'Anomalia Motor/Tração', value: motor, color: '#9B59B6' },
      { name: 'Outros Erros', value: other, color: '#95A5A6' },
    ].filter((item) => item.value > 0);
  }, [logs]);

  return (
    <div className="space-y-6">
      {/* Top Header */}
      <div className="bg-white p-5 rounded-xl border border-[#E4ECE6]">
        <h2 className="text-base font-bold text-[#245C43]">
          Métricas de Desempenho e Eficiência
        </h2>
        <p className="text-xs text-[#78877D]">
          Indicadores estatísticos consolidados das operações de transporte de pacotes.
        </p>
      </div>

      {error ? (
        <ErrorState
          message={error}
          onRetry={() => setRetryCount((prev) => prev + 1)}
        />
      ) : (
      <>

      {/* KPI Historical Metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <KpiCard
          title="Viagens Concluídas"
          value={metrics ? metrics.completedMissions : 0}
          description="Total de entregas completas"
          icon={CheckCircle2}
          loading={loading}
          highlight
        />

        <KpiCard
          title="Tempo Médio"
          value={metrics ? formatDuration(metrics.avgDurationSeconds) : '—'}
          description="Média de percurso válido"
          icon={Clock}
          loading={loading}
        />

        <KpiCard
          title="Mediana de Duração"
          value={metrics ? formatDuration(metrics.medianDurationSeconds) : '—'}
          description="Resistente a valores atípicos"
          icon={Compass}
          loading={loading}
        />

        <KpiCard
          title="Média Paradas / Viagem"
          value={avgStopsPerMission}
          description="Paradas por percurso realizado"
          icon={PauseCircle}
          loading={loading}
        />

        <KpiCard
          title="Menor Duração"
          value={metrics ? formatDuration(metrics.minDurationSeconds) : '—'}
          description="Melhor tempo registrado"
          icon={Zap}
          loading={loading}
        />

        <KpiCard
          title="Maior Duração"
          value={metrics ? formatDuration(metrics.maxDurationSeconds) : '—'}
          description="Pior tempo registrado"
          icon={Clock}
          loading={loading}
        />

        <KpiCard
          title="Taxa de Conclusão"
          value={metrics ? formatPercent(metrics.completionRate) : '0%'}
          description="Sucesso operacional"
          icon={TrendingUp}
          loading={loading}
        />

        <KpiCard
          title="Falhas Registradas"
          value={metrics ? metrics.totalErrors : 0}
          description="Total de erros críticos"
          icon={AlertTriangle}
          loading={loading}
        />
      </div>

      {/* Charts Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Duration Trend with Moving Average */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Tendência de Duração por Viagem
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Tempo real de execução versus Média Móvel dos últimos 3 percursos
          </p>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={durationTrend} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E4ECE6" />
                <XAxis dataKey="missionId" tick={{ fill: '#78877D', fontSize: 10 }} tickLine={false} />
                <YAxis tick={{ fill: '#78877D', fontSize: 11 }} tickLine={false} unit="s" />
                <Tooltip
                  formatter={(val, name) => [
                    `${val}s`,
                    name === 'duracao' ? 'Duração Real' : 'Média Móvel',
                  ]}
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    borderRadius: '8px',
                    border: '1px solid #E4ECE6',
                    fontSize: '12px',
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="duracao"
                  name="duracao"
                  stroke="#245C43"
                  strokeWidth={2}
                  dot={{ r: 3, fill: '#65B98A' }}
                />
                <Line
                  type="monotone"
                  dataKey="mediaMovel"
                  name="mediaMovel"
                  stroke="#E7B85C"
                  strokeWidth={2}
                  strokeDasharray="4 4"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Hourly Distribution of Operations */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Horários de Maior Atividade
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Distribuição de missões por faixa horária
          </p>

          <div className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hourlyActivity} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E4ECE6" />
                <XAxis dataKey="hour" tick={{ fill: '#78877D', fontSize: 10 }} tickLine={false} />
                <YAxis tick={{ fill: '#78877D', fontSize: 11 }} tickLine={false} allowDecimals={false} />
                <Tooltip
                  formatter={(val) => [`${val} missões`, 'Volume']}
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    borderRadius: '8px',
                    border: '1px solid #E4ECE6',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="missões" fill="#65B98A" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Route & Errors Matrix (2 Columns) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Route distribution */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Volume por Rota (Origem e Destino)
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Fluxo de viagens entre postos de carga e descarga
          </p>

          <div className="space-y-3">
            {routeDistribution.map((item, idx) => {
              const pct = metrics && metrics.totalMissions > 0
                ? Math.round((item.count / metrics.totalMissions) * 100)
                : 0;

              return (
                <div key={idx} className="p-3 bg-[#F7FAF8] rounded-lg border border-[#E4ECE6] space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2 font-bold text-[#25372D]">
                      <MapPin className="w-3.5 h-3.5 text-[#245C43]" />
                      <span>{item.route}</span>
                    </div>
                    <span className="font-mono tabular-nums text-[#78877D]">
                      <strong className="text-[#25372D]">{item.count}</strong> viagens ({pct}%)
                    </span>
                  </div>

                  <div className="w-full bg-[#E4ECE6] h-2 rounded-full overflow-hidden">
                    <div
                      className="bg-[#65B98A] h-full rounded-full transition-all duration-300"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Error Breakdown */}
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 flex flex-col">
          <h3 className="text-sm font-bold text-[#25372D] mb-1">
            Categorização de Falhas
          </h3>
          <p className="text-xs text-[#78877D] mb-4">
            Origem técnica dos eventos de erro e interrupção
          </p>

          <div className="h-44 w-full flex items-center justify-center">
            {errorBreakdown.length === 0 ? (
              <div className="text-xs text-[#4AAB79] font-medium flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                <span>Nenhum erro registrado no histórico recente</span>
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={errorBreakdown}
                    innerRadius={45}
                    outerRadius={65}
                    paddingAngle={4}
                    dataKey="value"
                  >
                    {errorBreakdown.map((entry, index) => (
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

          <div className="mt-auto pt-3 border-t border-[#E4ECE6] space-y-1.5">
            {errorBreakdown.map((item, idx) => (
              <div key={idx} className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="text-[#25372D]">{item.name}</span>
                </div>
                <span className="font-mono tabular-nums font-bold text-[#25372D]">
                  {item.value}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>

      </>
      )}
    </div>
  );
};
