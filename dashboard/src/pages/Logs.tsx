/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo } from 'react';
import {
  Search,
  RotateCcw,
  ExternalLink,
  Download,
  Terminal,
  Cpu,
  Copy,
  Check,
} from 'lucide-react';
import { EventSeverity, EventType, LogEvent, TimePeriod } from '../types';
import { getLogs } from '../services/logsService';
import { toErrorMessage } from '../services/api';
import { formatDateTime, getEventTypeLabel, getRoverStateLabel } from '../utils/formatters';
import { SeverityBadge } from '../components/common/StatusBadge';
import { Pagination } from '../components/common/Pagination';
import { EmptyState } from '../components/common/EmptyState';
import { ErrorState } from '../components/common/ErrorState';
import { LogDetailModal } from '../components/logs/LogDetailModal';

interface LogsProps {
  refreshTrigger: number;
}

export const Logs: React.FC<LogsProps> = ({ refreshTrigger }) => {
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Filters
  const [search, setSearch] = useState('');
  const [missionFilter, setMissionFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [periodFilter, setPeriodFilter] = useState<TimePeriod>('all');

  // Pagination
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(25);

  // Selected Log Modal
  const [selectedLog, setSelectedLog] = useState<LogEvent | null>(null);

  // Quick feedback on row copy
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadLogs = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getLogs({ period: periodFilter });
        if (mounted) {
          setLogs(data);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(toErrorMessage(err));
          setLogs([]);
          setLoading(false);
        }
      }
    };

    loadLogs();
    return () => {
      mounted = false;
    };
  }, [refreshTrigger, retryCount, periodFilter]);

  const handleFilterChange = (setter: (val: any) => void, val: any) => {
    setter(val);
    setCurrentPage(1);
  };

  const handleClearFilters = () => {
    setSearch('');
    setMissionFilter('all');
    setTypeFilter('all');
    setSeverityFilter('all');
    setPeriodFilter('all');
    setCurrentPage(1);
  };

  const handleCopySingle = async (e: React.MouseEvent, event: LogEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      setCopiedId(event.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Ignore
    }
  };

  // Distinct mission IDs
  const missionIds = useMemo(() => {
    const set = new Set(logs.map((l) => l.missionId));
    return Array.from(set).filter((id) => id && id !== 'unassigned');
  }, [logs]);

  // Filtered logs
  const filteredLogs = useMemo(() => {
    return logs.filter((log) => {
      if (search) {
        const q = search.toLowerCase();
        const matchesMsg = log.message.toLowerCase().includes(q);
        const matchesCmd = log.command && log.command.toLowerCase().includes(q);
        const matchesId = log.id.toLowerCase().includes(q);
        const matchesMission = log.missionId.toLowerCase().includes(q);
        if (!matchesMsg && !matchesCmd && !matchesId && !matchesMission) return false;
      }

      if (missionFilter !== 'all' && log.missionId !== missionFilter) return false;
      if (typeFilter !== 'all' && log.eventType !== typeFilter) return false;
      if (severityFilter !== 'all' && log.severity !== severityFilter) return false;

      return true;
    });
  }, [logs, search, missionFilter, typeFilter, severityFilter]);

  // Paginated records
  const paginatedLogs = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return filteredLogs.slice(start, start + pageSize);
  }, [filteredLogs, currentPage, pageSize]);

  // Export current filtered logs to JSON
  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(filteredLogs, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `rover_logs_export_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      {/* Search and Filters Bar */}
      <div className="bg-white p-5 rounded-xl border border-[#E4ECE6] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[#245C43]">
              Logs e Eventos Operacionais
            </h2>
            <p className="text-xs text-[#78877D]">
              Console de auditoria técnica com comandos executados, estados e telemetria.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              disabled={filteredLogs.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECE6] text-xs font-semibold text-[#25372D] hover:bg-[#F7FAF8] transition-colors disabled:opacity-40"
            >
              <Download className="w-3.5 h-3.5 text-[#245C43]" />
              <span>Exportar JSON</span>
            </button>

            <button
              type="button"
              onClick={handleClearFilters}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECE6] text-xs font-medium text-[#78877D] hover:text-[#25372D] hover:bg-[#F7FAF8] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Limpar</span>
            </button>
          </div>
        </div>

        {/* Filters Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-[#E4ECE6]/70">
          {/* Search */}
          <div className="relative">
            <Search className="w-4 h-4 text-[#78877D] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Buscar em mensagens e comandos..."
              value={search}
              onChange={(e) => handleFilterChange(setSearch, e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] placeholder-[#78877D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            />
          </div>

          {/* Mission filter */}
          <div>
            <select
              value={missionFilter}
              onChange={(e) => handleFilterChange(setMissionFilter, e.target.value)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todas as Missões</option>
              {missionIds.map((mId) => (
                <option key={mId} value={mId}>
                  Missão: {mId}
                </option>
              ))}
            </select>
          </div>

          {/* Event type filter */}
          <div>
            <select
              value={typeFilter}
              onChange={(e) => handleFilterChange(setTypeFilter, e.target.value)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todos os Tipos de Evento</option>
              <option value="mission_start">Início da Missão</option>
              <option value="command">Comando Executado</option>
              <option value="presence_detected">Presença Detectada</option>
              <option value="stop_preventive">Parada Preventiva</option>
              <option value="resume">Retomada</option>
              <option value="destination_reached">Destino Alcançado</option>
              <option value="error">Falha / Erro</option>
              <option value="warning">Alerta / Aviso</option>
            </select>
          </div>

          {/* Severity filter */}
          <div>
            <select
              value={severityFilter}
              onChange={(e) => handleFilterChange(setSeverityFilter, e.target.value)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todas as Severidades</option>
              <option value="info">Informativo</option>
              <option value="warning">Aviso</option>
              <option value="error">Erro</option>
              <option value="critical">Crítico</option>
            </select>
          </div>
        </div>
      </div>

      {/* Logs Table */}
      <div className="bg-white rounded-xl border border-[#E4ECE6] overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-[#78877D] animate-pulse">
            Carregando eventos do sistema...
          </div>
        ) : error ? (
          <ErrorState
            message={error}
            onRetry={() => setRetryCount((prev) => prev + 1)}
          />
        ) : filteredLogs.length === 0 ? (
          <EmptyState
            title="Nenhum registro encontrado"
            description="Tente ajustar os filtros ou a palavra-chave pesquisada para visualizar logs."
            actionText="Limpar filtros"
            onAction={handleClearFilters}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#E4ECE6] bg-[#F7FAF8] text-[#78877D] text-[11px] font-semibold uppercase tracking-wider">
                    <th className="py-3 px-4">Horário</th>
                    <th className="py-3 px-4">Missão</th>
                    <th className="py-3 px-4">Tipo</th>
                    <th className="py-3 px-4">Comando</th>
                    <th className="py-3 px-4">Estado</th>
                    <th className="py-3 px-4">Severidade</th>
                    <th className="py-3 px-4">Mensagem</th>
                    <th className="py-3 px-4 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4ECE6]/50">
                  {paginatedLogs.map((log) => (
                    <tr
                      key={log.id}
                      onClick={() => setSelectedLog(log)}
                      className="hover:bg-[#F0F7F3]/40 transition-colors cursor-pointer"
                    >
                      {/* Timestamp */}
                      <td className="py-3 px-4 font-mono tabular-nums text-[#78877D] whitespace-nowrap">
                        {formatDateTime(log.timestamp)}
                      </td>

                      {/* Mission ID */}
                      <td className="py-3 px-4 font-mono font-medium text-[#245C43] whitespace-nowrap">
                        {log.missionId}
                      </td>

                      {/* Event Type */}
                      <td className="py-3 px-4 text-[#25372D] whitespace-nowrap font-medium">
                        {getEventTypeLabel(log.eventType)}
                      </td>

                      {/* Command */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        {log.command ? (
                          <span className="font-mono text-[11px] font-semibold px-2 py-0.5 rounded bg-[#F0F7F3] text-[#245C43] border border-[#E4ECE6]">
                            {log.command}
                          </span>
                        ) : (
                          <span className="text-[#78877D]">—</span>
                        )}
                      </td>

                      {/* State */}
                      <td className="py-3 px-4 whitespace-nowrap text-[#78877D]">
                        {getRoverStateLabel(log.roverState)}
                      </td>

                      {/* Severity */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <SeverityBadge severity={log.severity} />
                      </td>

                      {/* Message */}
                      <td className="py-3 px-4 text-[#25372D] max-w-sm truncate">
                        {log.message}
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            type="button"
                            onClick={(e) => handleCopySingle(e, log)}
                            title="Copiar JSON do evento"
                            className="p-1 rounded text-[#78877D] hover:text-[#245C43] hover:bg-[#DDF4E5] transition-colors"
                          >
                            {copiedId === log.id ? (
                              <Check className="w-3.5 h-3.5 text-[#4AAB79]" />
                            ) : (
                              <Copy className="w-3.5 h-3.5" />
                            )}
                          </button>

                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedLog(log);
                            }}
                            className="p-1 rounded text-[#78877D] hover:text-[#245C43] hover:bg-[#DDF4E5] transition-colors"
                            title="Ver detalhes completos"
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              currentPage={currentPage}
              pageSize={pageSize}
              totalItems={filteredLogs.length}
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
              itemName="registros de log"
            />
          </>
        )}
      </div>

      {/* Modal */}
      {selectedLog && (
        <LogDetailModal
          event={selectedLog}
          onClose={() => setSelectedLog(null)}
        />
      )}
    </div>
  );
};
