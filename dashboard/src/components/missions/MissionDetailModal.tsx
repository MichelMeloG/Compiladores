/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  X,
  Clock,
  AlertTriangle,
  PauseCircle,
  Activity,
  MapPin,
  ArrowRight,
  ShieldAlert,
} from 'lucide-react';
import { LogEvent, Mission } from '../../types';
import { getMissionById } from '../../services/missionsService';
import { toErrorMessage } from '../../services/api';
import { formatDateTime, formatDuration } from '../../utils/formatters';
import { MissionStatusBadge, SeverityBadge } from '../common/StatusBadge';

interface MissionDetailModalProps {
  mission: Mission | null;
  onClose: () => void;
  onSelectEvent?: (eventId: string) => void;
}

export const MissionDetailModal: React.FC<MissionDetailModalProps> = ({
  mission,
  onClose,
}) => {
  const missionId = mission?.id;
  const listedEvents = mission?.events;

  const [events, setEvents] = useState<LogEvent[]>(listedEvents ?? []);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);

  /**
   * A listagem (`GET /missions`) pode devolver as missões sem a linha do
   * tempo, para manter a resposta leve. Nesse caso o detalhe é buscado sob
   * demanda em `GET /missions/:id` ao abrir o modal.
   */
  useEffect(() => {
    if (!missionId) return;

    if (listedEvents && listedEvents.length > 0) {
      setEvents(listedEvents);
      setEventsError(null);
      return;
    }

    let mounted = true;
    const loadDetail = async () => {
      setLoadingEvents(true);
      setEventsError(null);
      try {
        const detail = await getMissionById(missionId);
        if (mounted) {
          setEvents(detail?.events ?? []);
          setLoadingEvents(false);
        }
      } catch (err) {
        if (mounted) {
          setEventsError(toErrorMessage(err));
          setEvents([]);
          setLoadingEvents(false);
        }
      }
    };

    loadDetail();
    return () => {
      mounted = false;
    };
  }, [missionId, listedEvents]);

  if (!mission) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/40 backdrop-blur-xs">
      <div className="relative w-full max-w-3xl max-h-[90vh] bg-white rounded-2xl shadow-xl border border-[#E4ECE6] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E4ECE6] bg-[#F7FAF8]">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-bold font-mono tabular-nums text-[#25372D]">
              {mission.id}
            </h2>
            <MissionStatusBadge status={mission.status} />
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#78877D] hover:text-[#25372D] hover:bg-white transition-colors"
            aria-label="Fechar modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Route Schematic Visualizer */}
          <div className="p-4 bg-[#F0F7F3] rounded-xl border border-[#E4ECE6]">
            <div className="text-xs font-semibold text-[#78877D] uppercase tracking-wider mb-3">
              Percurso Operacional
            </div>
            <div className="flex items-center justify-between relative px-4 py-3">
              {/* Origin */}
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-[#245C43] text-white flex items-center justify-center font-bold text-xs shadow-xs">
                  <MapPin className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-[#25372D]">{mission.origin}</div>
                  <div className="text-[11px] text-[#78877D] font-mono tabular-nums">
                    {formatDateTime(mission.startedAt)}
                  </div>
                </div>
              </div>

              {/* Connecting Line with stops */}
              <div className="flex-1 mx-6 flex items-center relative">
                <div className="w-full h-0.5 bg-[#BFE8D0]" />
                {mission.stopCount > 0 && (
                  <div className="absolute inset-0 flex items-center justify-center gap-2">
                    <span className="px-2 py-0.5 rounded-md bg-white border border-[#E7B85C] text-[#9A7D0A] text-[10px] font-medium font-mono tabular-nums shadow-xs flex items-center gap-1">
                      <PauseCircle className="w-3 h-3 text-[#E7B85C]" />
                      {mission.stopCount} {mission.stopCount === 1 ? 'parada' : 'paradas'}
                    </span>
                  </div>
                )}
                <ArrowRight className="w-4 h-4 text-[#245C43] absolute right-0 -mr-2" />
              </div>

              {/* Destination */}
              <div className="flex items-center gap-2 text-right">
                <div>
                  <div className="text-xs font-bold text-[#25372D]">{mission.destination}</div>
                  <div className="text-[11px] text-[#78877D] font-mono tabular-nums">
                    {mission.endedAt ? formatDateTime(mission.endedAt) : 'Em trânsito'}
                  </div>
                </div>
                <div
                  className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs shadow-xs ${
                    mission.status === 'completed'
                      ? 'bg-[#4AAB79] text-white'
                      : mission.status === 'failed'
                      ? 'bg-[#D96B6B] text-white'
                      : 'bg-[#BFE8D0] text-[#245C43]'
                  }`}
                >
                  <MapPin className="w-4 h-4" />
                </div>
              </div>
            </div>
          </div>

          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="p-3 bg-white rounded-lg border border-[#E4ECE6]">
              <div className="flex items-center gap-1.5 text-xs text-[#78877D] mb-1">
                <Clock className="w-3.5 h-3.5" />
                <span>Duração</span>
              </div>
              <div className="text-lg font-bold font-mono tabular-nums text-[#25372D]">
                {formatDuration(mission.durationSeconds)}
              </div>
            </div>

            <div className="p-3 bg-white rounded-lg border border-[#E4ECE6]">
              <div className="flex items-center gap-1.5 text-xs text-[#78877D] mb-1">
                <PauseCircle className="w-3.5 h-3.5" />
                <span>Paradas</span>
              </div>
              <div className="text-lg font-bold font-mono tabular-nums text-[#25372D]">
                {mission.stopCount}
              </div>
              <div className="text-[10px] text-[#78877D]">
                ({mission.presenceStopCount} por presença)
              </div>
            </div>

            <div className="p-3 bg-white rounded-lg border border-[#E4ECE6]">
              <div className="flex items-center gap-1.5 text-xs text-[#78877D] mb-1">
                <ShieldAlert className="w-3.5 h-3.5" />
                <span>Erros</span>
              </div>
              <div
                className={`text-lg font-bold font-mono tabular-nums ${
                  mission.errorCount > 0 ? 'text-[#D96B6B]' : 'text-[#25372D]'
                }`}
              >
                {mission.errorCount}
              </div>
            </div>

            <div className="p-3 bg-white rounded-lg border border-[#E4ECE6]">
              <div className="flex items-center gap-1.5 text-xs text-[#78877D] mb-1">
                <Activity className="w-3.5 h-3.5" />
                <span>Total de Logs</span>
              </div>
              <div className="text-lg font-bold font-mono tabular-nums text-[#25372D]">
                {mission.eventCount}
              </div>
            </div>
          </div>

          {/* Stop Reasons Analysis */}
          {mission.stopReasons.length > 0 && (
            <div className="p-4 bg-white rounded-xl border border-[#E4ECE6]">
              <h3 className="text-xs font-semibold text-[#78877D] uppercase tracking-wider mb-2">
                Motivos das Paradas Registradas
              </h3>
              <div className="space-y-1.5">
                {mission.stopReasons.map((r, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between text-xs py-1 px-2 rounded-md bg-[#F7FAF8]"
                  >
                    <span className="text-[#25372D] font-medium">{r.reason}</span>
                    <span className="font-mono tabular-nums font-semibold text-[#245C43]">
                      {r.count} {r.count === 1 ? 'ocorrência' : 'ocorrências'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Event Timeline */}
          <div>
            <h3 className="text-xs font-semibold text-[#78877D] uppercase tracking-wider mb-3">
              Linha do Tempo de Eventos
            </h3>

            {loadingEvents && (
              <p className="text-xs text-[#78877D] animate-pulse">
                Carregando linha do tempo da missão...
              </p>
            )}

            {eventsError && (
              <p className="text-xs text-[#922B21] bg-[#FDEDEC] border border-[#F5B7B1] rounded-lg p-3">
                Não foi possível carregar os eventos desta missão: {eventsError}
              </p>
            )}

            {!loadingEvents && !eventsError && events.length === 0 && (
              <p className="text-xs text-[#78877D]">
                Nenhum evento registrado para esta missão.
              </p>
            )}

            <div className="relative pl-6 space-y-4 before:absolute before:left-2 before:top-2 before:bottom-2 before:w-0.5 before:bg-[#E4ECE6]">
              {events.map((event) => (
                <div key={event.id} className="relative flex items-start gap-3">
                  {/* Timeline Node */}
                  <div
                    className={`absolute -left-6 top-1 w-3.5 h-3.5 rounded-full border-2 border-white ring-2 ${
                      event.severity === 'critical' || event.severity === 'error'
                        ? 'bg-[#D96B6B] ring-[#FDEDEC]'
                        : event.severity === 'warning'
                        ? 'bg-[#E7B85C] ring-[#FEF5E7]'
                        : 'bg-[#65B98A] ring-[#DDF4E5]'
                    }`}
                  />

                  <div className="flex-1 p-3 bg-white rounded-lg border border-[#E4ECE6]">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono tabular-nums text-[#78877D]">
                          {formatDateTime(event.timestamp)}
                        </span>
                        <SeverityBadge severity={event.severity} />
                      </div>

                      {event.command && (
                        <span className="px-2 py-0.5 rounded bg-[#F0F7F3] font-mono text-xs font-semibold text-[#245C43]">
                          {event.command}
                        </span>
                      )}
                    </div>

                    <p className="text-xs text-[#25372D] leading-relaxed">
                      {event.message}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[#E4ECE6] bg-[#F7FAF8] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-[#25372D] hover:bg-[#E4ECE6] rounded-lg transition-colors"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
