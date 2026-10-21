/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState, useMemo } from 'react';
import {
  Search,
  Filter,
  ArrowUpDown,
  RotateCcw,
  ExternalLink,
  MapPin,
  Clock,
  PauseCircle,
  AlertCircle,
} from 'lucide-react';
import { Mission, MissionStatus, TimePeriod } from '../types';
import { getMissions } from '../services/missionsService';
import { toErrorMessage } from '../services/api';
import { formatDateTime, formatDuration } from '../utils/formatters';
import { MissionStatusBadge } from '../components/common/StatusBadge';
import { Pagination } from '../components/common/Pagination';
import { EmptyState } from '../components/common/EmptyState';
import { ErrorState } from '../components/common/ErrorState';
import { MissionDetailModal } from '../components/missions/MissionDetailModal';

interface MissionsProps {
  refreshTrigger: number;
}

type SortField = 'startedAt' | 'duration' | 'stopCount';
type SortOrder = 'asc' | 'desc';

export const Missions: React.FC<MissionsProps> = ({ refreshTrigger }) => {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // Filters
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [originFilter, setOriginFilter] = useState<string>('all');
  const [destinationFilter, setDestinationFilter] = useState<string>('all');
  const [periodFilter, setPeriodFilter] = useState<TimePeriod>('all');

  // Sorting
  const [sortField, setSortField] = useState<SortField>('startedAt');
  const [sortOrder, setSortOrder] = useState<SortOrder>('desc');

  // Pagination
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(10);

  // Modal
  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);

  useEffect(() => {
    let mounted = true;
    const loadMissions = async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await getMissions({ period: periodFilter });
        if (mounted) {
          setMissions(data);
          setLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setError(toErrorMessage(err));
          setMissions([]);
          setLoading(false);
        }
      }
    };

    loadMissions();
    return () => {
      mounted = false;
    };
  }, [refreshTrigger, retryCount, periodFilter]);

  // Reset page when filters change
  const handleFilterChange = (setter: (val: any) => void, val: any) => {
    setter(val);
    setCurrentPage(1);
  };

  const handleClearFilters = () => {
    setSearch('');
    setStatusFilter('all');
    setOriginFilter('all');
    setDestinationFilter('all');
    setPeriodFilter('all');
    setCurrentPage(1);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  // Distinct origins and destinations
  const origins = useMemo(() => {
    const set = new Set(missions.map((m) => m.origin));
    return Array.from(set);
  }, [missions]);

  const destinations = useMemo(() => {
    const set = new Set(missions.map((m) => m.destination));
    return Array.from(set);
  }, [missions]);

  // Filtered & Sorted missions
  const filteredMissions = useMemo(() => {
    return missions.filter((m) => {
      if (search) {
        const q = search.toLowerCase();
        const matchesId = m.id.toLowerCase().includes(q);
        const matchesOrigin = m.origin.toLowerCase().includes(q);
        const matchesDest = m.destination.toLowerCase().includes(q);
        if (!matchesId && !matchesOrigin && !matchesDest) return false;
      }
      if (statusFilter !== 'all' && m.status !== statusFilter) return false;
      if (originFilter !== 'all' && m.origin !== originFilter) return false;
      if (destinationFilter !== 'all' && m.destination !== destinationFilter) return false;
      return true;
    });
  }, [missions, search, statusFilter, originFilter, destinationFilter]);

  const sortedMissions = useMemo(() => {
    return [...filteredMissions].sort((a, b) => {
      let result = 0;
      if (sortField === 'startedAt') {
        result = new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
      } else if (sortField === 'duration') {
        const durA = a.durationSeconds ?? -1;
        const durB = b.durationSeconds ?? -1;
        result = durA - durB;
      } else if (sortField === 'stopCount') {
        result = a.stopCount - b.stopCount;
      }
      return sortOrder === 'asc' ? result : -result;
    });
  }, [filteredMissions, sortField, sortOrder]);

  // Paginated records
  const paginatedMissions = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return sortedMissions.slice(start, start + pageSize);
  }, [sortedMissions, currentPage, pageSize]);

  return (
    <div className="space-y-6">
      {/* Header and Filter Toolbar */}
      <div className="bg-white p-5 rounded-xl border border-[#E4ECE6] space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-bold text-[#245C43]">
              Missões e Percursos
            </h2>
            <p className="text-xs text-[#78877D]">
              Histórico detalhado de trajetos, tempos e desfecho das viagens do carrinho.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleClearFilters}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECE6] text-xs font-medium text-[#78877D] hover:text-[#25372D] hover:bg-[#F7FAF8] transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Limpar Filtros</span>
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
              placeholder="Buscar por ID ou rota..."
              value={search}
              onChange={(e) => handleFilterChange(setSearch, e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] placeholder-[#78877D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            />
          </div>

          {/* Status Filter */}
          <div>
            <select
              value={statusFilter}
              onChange={(e) => handleFilterChange(setStatusFilter, e.target.value)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todos os Status</option>
              <option value="completed">Concluída</option>
              <option value="in_progress">Em andamento</option>
              <option value="aborted">Interrompida</option>
              <option value="failed">Com falha</option>
              <option value="indeterminate">Indeterminada</option>
            </select>
          </div>

          {/* Origin Filter */}
          <div>
            <select
              value={originFilter}
              onChange={(e) => handleFilterChange(setOriginFilter, e.target.value)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todas as Origens</option>
              {origins.map((orig) => (
                <option key={orig} value={orig}>
                  Origem: {orig}
                </option>
              ))}
            </select>
          </div>

          {/* Destination Filter */}
          <div>
            <select
              value={destinationFilter}
              onChange={(e) => handleFilterChange(setDestinationFilter, e.target.value)}
              className="w-full px-3 py-1.5 bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg text-xs text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
            >
              <option value="all">Todos os Destinos</option>
              {destinations.map((dest) => (
                <option key={dest} value={dest}>
                  Destino: {dest}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Missions Table Container */}
      <div className="bg-white rounded-xl border border-[#E4ECE6] overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-[#78877D] animate-pulse">
            Carregando missões do carrinho...
          </div>
        ) : error ? (
          <ErrorState
            message={error}
            onRetry={() => setRetryCount((prev) => prev + 1)}
          />
        ) : filteredMissions.length === 0 ? (
          <EmptyState
            title="Nenhuma missão encontrada"
            description="Não encontramos registros que correspondam aos filtros de busca atuais."
            actionText="Limpar filtros"
            onAction={handleClearFilters}
          />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-[#E4ECE6] bg-[#F7FAF8] text-[#78877D] text-[11px] font-semibold uppercase tracking-wider">
                    <th className="py-3 px-4">ID da Missão</th>
                    <th className="py-3 px-4">Trajeto</th>
                    <th
                      className="py-3 px-4 cursor-pointer hover:text-[#25372D] select-none"
                      onClick={() => handleSort('startedAt')}
                    >
                      <div className="flex items-center gap-1">
                        <span>Início</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th
                      className="py-3 px-4 cursor-pointer hover:text-[#25372D] select-none"
                      onClick={() => handleSort('duration')}
                    >
                      <div className="flex items-center gap-1">
                        <span>Duração</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th
                      className="py-3 px-4 cursor-pointer hover:text-[#25372D] select-none"
                      onClick={() => handleSort('stopCount')}
                    >
                      <div className="flex items-center gap-1">
                        <span>Paradas</span>
                        <ArrowUpDown className="w-3 h-3" />
                      </div>
                    </th>
                    <th className="py-3 px-4">Erros</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E4ECE6]/60">
                  {paginatedMissions.map((mission) => (
                    <tr
                      key={mission.id}
                      className="hover:bg-[#F0F7F3]/40 transition-colors cursor-pointer"
                      onClick={() => setSelectedMission(mission)}
                    >
                      {/* Mission ID */}
                      <td className="py-3 px-4 font-mono font-bold text-[#245C43]">
                        {mission.id}
                      </td>

                      {/* Origin -> Destination */}
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5 font-medium text-[#25372D]">
                          <span>{mission.origin}</span>
                          <span className="text-[#78877D]">→</span>
                          <span>{mission.destination}</span>
                        </div>
                      </td>

                      {/* Start time */}
                      <td className="py-3 px-4 font-mono tabular-nums text-[#78877D] whitespace-nowrap">
                        {formatDateTime(mission.startedAt)}
                      </td>

                      {/* Duration */}
                      <td className="py-3 px-4 font-mono tabular-nums font-semibold text-[#25372D] whitespace-nowrap">
                        {formatDuration(mission.durationSeconds)}
                      </td>

                      {/* Stops */}
                      <td className="py-3 px-4">
                        <span className="font-mono tabular-nums font-medium text-[#25372D]">
                          {mission.stopCount}
                        </span>
                        {mission.presenceStopCount > 0 && (
                          <span className="text-[11px] text-[#78877D] ml-1">
                            ({mission.presenceStopCount} pres.)
                          </span>
                        )}
                      </td>

                      {/* Errors */}
                      <td className="py-3 px-4">
                        {mission.errorCount > 0 ? (
                          <span className="font-mono tabular-nums font-bold text-[#D96B6B]">
                            {mission.errorCount}
                          </span>
                        ) : (
                          <span className="text-[#78877D]">0</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-4 whitespace-nowrap">
                        <MissionStatusBadge status={mission.status} />
                      </td>

                      {/* Actions */}
                      <td className="py-3 px-4 text-right">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedMission(mission);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-semibold text-[#245C43] hover:bg-[#DDF4E5] rounded-md transition-colors"
                        >
                          <span>Ver</span>
                          <ExternalLink className="w-3 h-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <Pagination
              currentPage={currentPage}
              pageSize={pageSize}
              totalItems={filteredMissions.length}
              onPageChange={setCurrentPage}
              onPageSizeChange={setPageSize}
              itemName="missões"
            />
          </>
        )}
      </div>

      {/* Modal */}
      {selectedMission && (
        <MissionDetailModal
          mission={selectedMission}
          onClose={() => setSelectedMission(null)}
        />
      )}
    </div>
  );
};
