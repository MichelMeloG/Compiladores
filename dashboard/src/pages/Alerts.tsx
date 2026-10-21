/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo } from 'react';
import {
  AlertTriangle,
  ShieldAlert,
  Info,
  CheckCircle2,
  Clock,
  RotateCcw,
  Search,
  ExternalLink,
} from 'lucide-react';
import { Alert } from '../types';
import { getAlerts, acknowledgeAlert } from '../services/alertsService';
import { toErrorMessage } from '../services/api';
import { formatDateTime } from '../utils/formatters';
import { SeverityBadge } from '../components/common/StatusBadge';
import { EmptyState } from '../components/common/EmptyState';
import { ErrorState } from '../components/common/ErrorState';

interface AlertsProps {
  refreshTrigger: number;
}

export const Alerts: React.FC<AlertsProps> = ({ refreshTrigger }) => {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [ackError, setAckError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'unacknowledged' | 'acknowledged'>('all');

  useEffect(() => {
    let mounted = true;
    const loadAlerts = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getAlerts();
        if (mounted) {
          setAlerts(data);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(toErrorMessage(err));
          setAlerts([]);
          setLoading(false);
        }
      }
    };

    loadAlerts();
    return () => {
      mounted = false;
    };
  }, [refreshTrigger, retryCount]);

  const handleAcknowledge = async (alertId: string) => {
    setAckError(null);
    try {
      await acknowledgeAlert(alertId);
    } catch (err) {
      // O reconhecimento é persistido no backend: sem confirmação,
      // o estado local não deve ser alterado.
      setAckError(toErrorMessage(err));
      return;
    }
    setAlerts((prev) =>
      prev.map((a) => (a.id === alertId ? { ...a, acknowledged: true } : a))
    );
  };

  // Metrics by severity
  const severityCounts = useMemo(() => {
    return {
      critical: alerts.filter((a) => a.severity === 'critical').length,
      error: alerts.filter((a) => a.severity === 'error').length,
      warning: alerts.filter((a) => a.severity === 'warning').length,
      info: alerts.filter((a) => a.severity === 'info').length,
      unacknowledged: alerts.filter((a) => !a.acknowledged).length,
    };
  }, [alerts]);

  // Filtered alerts
  const filteredAlerts = useMemo(() => {
    return alerts.filter((alert) => {
      if (search) {
        const q = search.toLowerCase();
        const matchesTitle = alert.title.toLowerCase().includes(q);
        const matchesDesc = alert.description.toLowerCase().includes(q);
        const matchesMission = alert.missionId && alert.missionId.toLowerCase().includes(q);
        if (!matchesTitle && !matchesDesc && !matchesMission) return false;
      }

      if (severityFilter !== 'all' && alert.severity !== severityFilter) return false;

      if (statusFilter === 'unacknowledged' && alert.acknowledged) return false;
      if (statusFilter === 'acknowledged' && !alert.acknowledged) return false;

      return true;
    });
  }, [alerts, search, severityFilter, statusFilter]);

  return (
    <div className="space-y-6">
      {/* Category Summary Banner */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white p-4 rounded-xl border border-[#E4ECE6] flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-[#78877D] block mb-1">
              Críticos
            </span>
            <span className="text-xl font-bold font-mono tabular-nums text-[#D96B6B]">
              {severityCounts.critical}
            </span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#FDEDEC] text-[#D96B6B] flex items-center justify-center">
            <ShieldAlert className="w-4.5 h-4.5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-[#E4ECE6] flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-[#78877D] block mb-1">
              Erros
            </span>
            <span className="text-xl font-bold font-mono tabular-nums text-[#922B21]">
              {severityCounts.error}
            </span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#FDEDEC] text-[#922B21] flex items-center justify-center">
            <AlertTriangle className="w-4.5 h-4.5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-[#E4ECE6] flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-[#78877D] block mb-1">
              Avisos
            </span>
            <span className="text-xl font-bold font-mono tabular-nums text-[#9A7D0A]">
              {severityCounts.warning}
            </span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#FEF5E7] text-[#9A7D0A] flex items-center justify-center">
            <AlertTriangle className="w-4.5 h-4.5" />
          </div>
        </div>

        <div className="bg-white p-4 rounded-xl border border-[#E4ECE6] flex items-center justify-between">
          <div>
            <span className="text-xs font-semibold text-[#78877D] block mb-1">
              Não Reconhecidos
            </span>
            <span className="text-xl font-bold font-mono tabular-nums text-[#245C43]">
              {severityCounts.unacknowledged}
            </span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#DDF4E5] text-[#245C43] flex items-center justify-center">
            <Info className="w-4.5 h-4.5" />
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white p-5 rounded-xl border border-[#E4ECE6] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[#245C43]">
              Central de Alertas e Problemas
            </h2>
            <p className="text-xs text-[#78877D]">
              Ocorrências agrupadas por padrão de falha, paradas imprevistas e telemetria.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              setSearch('');
              setSeverityFilter('all');
              setStatusFilter('all');
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECE6] text-xs font-medium text-[#78877D] hover:text-[#25372D] hover:bg-[#F7FAF8] transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Restaurar filtros</span>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[#E4ECE6]/70">
          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 text-[#78877D] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar por descrição ou missão..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] placeholder-[#78877D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            />
          </div>

          {/* Severity */}
          <div>
            <select
              value={severityFilter}
              onChange={(e) => setSeverityFilter(e.target.value)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todas as Severidades</option>
              <option value="critical">Crítico</option>
              <option value="error">Erro</option>
              <option value="warning">Aviso</option>
              <option value="info">Informativo</option>
            </select>
          </div>

          {/* Status (Acknowledged) */}
          <div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todos os Estados</option>
              <option value="unacknowledged">Pendentes (Não reconhecidos)</option>
              <option value="acknowledged">Reconhecidos</option>
            </select>
          </div>
        </div>

        <div className="text-[11px] text-[#78877D] bg-[#F7FAF8] p-2.5 rounded-lg border border-[#E4ECE6]">
          <strong>Aviso de Observabilidade:</strong> O reconhecimento é registrado no backend para organização da equipe e não garante a resolução física ou mecânica do carrinho.
        </div>
      </div>

      {/* Falha ao reconhecer um alerta no backend */}
      {ackError && (
        <div className="p-3 rounded-xl border border-[#F5B7B1] bg-[#FDEDEC] text-xs text-[#922B21]">
          <span className="font-semibold">Não foi possível reconhecer o alerta: </span>
          {ackError}
        </div>
      )}

      {/* Alerts Feed */}
      <div className="space-y-3">
        {loading ? (
          <div className="p-12 text-center text-xs text-[#78877D] bg-white rounded-xl border border-[#E4ECE6] animate-pulse">
            Carregando alertas...
          </div>
        ) : error ? (
          <ErrorState
            message={error}
            onRetry={() => setRetryCount((prev) => prev + 1)}
          />
        ) : filteredAlerts.length === 0 ? (
          <EmptyState
            title="Nenhum alerta registrado"
            description="Não há alertas ativos ou que atendam aos filtros selecionados."
          />
        ) : (
          filteredAlerts.map((alert) => (
            <div
              key={alert.id}
              className={`bg-white rounded-xl border p-5 transition-shadow hover:shadow-xs flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
                alert.acknowledged
                  ? 'border-[#E4ECE6] opacity-75'
                  : alert.severity === 'critical'
                  ? 'border-[#D96B6B]/40 ring-1 ring-[#D96B6B]/20'
                  : alert.severity === 'error'
                  ? 'border-[#D96B6B]/30'
                  : 'border-[#E4ECE6]'
              }`}
            >
              <div className="space-y-1.5 max-w-2xl">
                <div className="flex flex-wrap items-center gap-2">
                  <SeverityBadge severity={alert.severity} />
                  <span className="text-xs font-mono font-bold text-[#245C43]">
                    {alert.missionId ? `Missão ${alert.missionId}` : 'Sistema Geral'}
                  </span>
                  <span className="text-xs text-[#78877D] font-mono tabular-nums">
                    · {formatDateTime(alert.timestamp)}
                  </span>
                  {alert.occurrenceCount > 1 && (
                    <span className="text-[11px] font-mono tabular-nums px-2 py-0.2 rounded bg-[#F0F7F3] text-[#245C43] border border-[#E4ECE6]">
                      {alert.occurrenceCount} ocorrências agrupadas
                    </span>
                  )}
                </div>

                <h3 className="text-sm font-bold text-[#25372D]">{alert.title}</h3>
                <p className="text-xs text-[#78877D] leading-relaxed">
                  {alert.description}
                </p>
              </div>

              <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 shrink-0">
                {alert.acknowledged ? (
                  <span className="inline-flex items-center gap-1 text-xs text-[#4AAB79] font-medium bg-[#DDF4E5] px-2.5 py-1 rounded-md border border-[#BFE8D0]">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>Reconhecido</span>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleAcknowledge(alert.id)}
                    className="px-3.5 py-1.5 rounded-lg text-xs font-semibold text-[#245C43] bg-[#BFE8D0] hover:bg-[#aee0c2] transition-colors"
                  >
                    Reconhecer
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
