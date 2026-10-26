/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  CornerUpLeft,
  Flag,
  Loader2,
  MapPin,
  Plus,
  Send,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { RobotHeaderCard } from '../components/robots/RobotHeaderCard';
import { RouteGridCanvas } from '../components/robots/RouteGridCanvas';
import { ErrorState } from '../components/common/ErrorState';
import { getRobotById } from '../services/robotsService';
import { getActiveRoute, getRobotGrid, submitRoute } from '../services/routesService';
import { toErrorMessage } from '../services/api';
import { ActiveRoute, Robot, RobotGrid, RouteWaypoint } from '../types';
import {
  appendWaypoint,
  describeStep,
  formatPoint,
  parsePoint,
  removeWaypoint,
  replaceWaypoint,
  validateRoute,
} from '../utils/routeGrid';

interface RoutePlannerProps {
  robotId: string;
  refreshTrigger: number;
}

interface WaypointInputProps {
  value: string;
  label: string;
  onCommit: (raw: string) => void;
}

/**
 * Campo de coordenada de um passo da rota.
 *
 * Mantém o texto em edição separado do valor da rota porque editar um
 * ponto recalcula os trechos vizinhos: o passo que o operador acabou de
 * digitar pode acabar em outro índice, ou com outra coordenada. Quando o
 * valor canônico muda, o campo volta a refleti-lo em vez de continuar
 * mostrando o que foi digitado.
 */
const WaypointInput: React.FC<WaypointInputProps> = ({
  value,
  label,
  onCommit,
}) => {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <input
      type="text"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') setDraft(value);
      }}
      className="w-20 px-2 py-1 font-mono tabular-nums text-xs text-[#25372D] bg-[#F7FAF8] border border-[#E4ECE6] rounded focus:outline-none focus:border-[#65B98A] focus:bg-white"
      aria-label={label}
    />
  );
};

/**
 * Montagem da rota de um robô.
 *
 * Dois caminhos para a mesma lista, como pediu a operação: clicar os
 * pontos na malha, ou digitá-los na tabela. Os dois editam o mesmo
 * estado — `waypoints` — e o que vai ao backend é sempre essa sequência
 * de vértices.
 */
export const RoutePlanner: React.FC<RoutePlannerProps> = ({
  robotId,
  refreshTrigger,
}) => {
  const [robot, setRobot] = useState<Robot | null>(null);
  const [grid, setGrid] = useState<RobotGrid | null>(null);
  const [activeRoute, setActiveRoute] = useState<ActiveRoute | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  const [waypoints, setWaypoints] = useState<RouteWaypoint[]>([]);
  const [editError, setEditError] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const [newX, setNewX] = useState('');
  const [newY, setNewY] = useState('');

  useEffect(() => {
    let mounted = true;

    const load = async () => {
      setLoading(true);
      setLoadError(null);
      try {
        const [mRobot, mGrid, mRoute] = await Promise.all([
          getRobotById(robotId),
          getRobotGrid(robotId),
          // Uma rota ausente não é falha: o robô pode simplesmente não ter uma.
          getActiveRoute(robotId).catch(() => null),
        ]);

        if (!mounted) return;

        setRobot(mRobot);
        setGrid(mGrid);
        setActiveRoute(mRoute);
        setWaypoints(mRoute?.waypoints ?? []);
        setEditError(null);
        setSendResult(null);
        setSendError(null);
        setLoading(false);
      } catch (err) {
        if (!mounted) return;
        setLoadError(toErrorMessage(err));
        setRobot(null);
        setGrid(null);
        setLoading(false);
      }
    };

    load();
    return () => {
      mounted = false;
    };
  }, [robotId, refreshTrigger, retryCount]);

  const robotAt = useMemo<RouteWaypoint | null>(() => {
    if (!robot?.currentPoint) return null;
    return parsePoint(robot.currentPoint);
  }, [robot]);

  const applyEdit = useCallback(
    (result: { waypoints: RouteWaypoint[]; error: string | null }) => {
      setWaypoints(result.waypoints);
      setEditError(result.error);
      setSendResult(null);
      setSendError(null);
    },
    []
  );

  const handleSelectPoint = useCallback(
    (point: RouteWaypoint) => {
      if (!grid) return;
      applyEdit(appendWaypoint(waypoints, point, grid));
    },
    [grid, waypoints, applyEdit]
  );

  const handleRemove = (index: number) => {
    if (!grid) return;
    applyEdit(removeWaypoint(waypoints, index, grid));
  };

  const handleReplace = (index: number, raw: string) => {
    if (!grid) return;
    const parsed = parsePoint(raw);
    if (!parsed) {
      setEditError(`"${raw}" não é uma coordenada válida. Use o formato x,y.`);
      return;
    }
    applyEdit(replaceWaypoint(waypoints, index, parsed, grid));
  };

  const handleAppendManual = () => {
    if (!grid) return;
    const parsed = parsePoint(`${newX},${newY}`);
    if (!parsed) {
      setEditError('Informe as duas coordenadas do ponto antes de adicionar.');
      return;
    }
    applyEdit(appendWaypoint(waypoints, parsed, grid));
    setNewX('');
    setNewY('');
  };

  const handleUndo = () => {
    if (waypoints.length === 0) return;
    applyEdit({ waypoints: waypoints.slice(0, -1), error: null });
  };

  const handleClear = () => {
    applyEdit({ waypoints: [], error: null });
  };

  const validationError = useMemo(() => {
    if (!grid || waypoints.length === 0) return null;
    return validateRoute(waypoints, grid);
  }, [waypoints, grid]);

  const canSend = Boolean(grid) && waypoints.length >= 2 && !validationError;

  const handleSend = async () => {
    if (!canSend) return;

    setSending(true);
    setSendError(null);
    setSendResult(null);

    try {
      const result = await submitRoute(robotId, waypoints);
      if (result.accepted) {
        setSendResult(
          `Rota enviada ao robô: ${result.waypointCount} pontos${
            result.routeId ? ` (${result.routeId})` : ''
          }.`
        );
        setActiveRoute({
          routeId: result.routeId,
          robotId,
          waypoints,
          createdAt: new Date().toISOString(),
          status: 'queued',
        });
      } else {
        setSendError(result.message || 'O robô recusou a rota enviada.');
      }
    } catch (err) {
      setSendError(toErrorMessage(err));
    } finally {
      setSending(false);
    }
  };

  if (loadError) {
    return (
      <ErrorState
        message={loadError}
        onRetry={() => setRetryCount((prev) => prev + 1)}
      />
    );
  }

  if (loading || !grid) {
    return (
      <div className="space-y-6">
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 animate-pulse">
          <div className="h-5 w-48 bg-[#E4ECE6] rounded mb-3" />
          <div className="h-3 w-72 bg-[#F0F7F3] rounded" />
        </div>
        <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 h-96 animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {robot && <RobotHeaderCard robot={robot} />}

      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        {/* The clickable lattice */}
        <div className="xl:col-span-3 bg-white rounded-xl border border-[#E4ECE6] p-5">
          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 mb-4">
            <div>
              <h3 className="text-sm font-bold text-[#25372D]">
                Malha de navegação
              </h3>
              <p className="text-xs text-[#78877D] max-w-md">
                Clique nos pontos na ordem em que o robô deve visitá-los. O
                trecho entre dois pontos distantes é preenchido pelo caminho
                mais curto sobre os trilhos.
              </p>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleUndo}
                disabled={waypoints.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#245C43] bg-[#F0F7F3] hover:bg-[#DDF4E5] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                <CornerUpLeft className="w-3.5 h-3.5" />
                <span>Desfazer</span>
              </button>
              <button
                type="button"
                onClick={handleClear}
                disabled={waypoints.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#A93226] bg-[#FDEDEC] hover:bg-[#f8dddb] disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Limpar</span>
              </button>
            </div>
          </div>

          <RouteGridCanvas
            grid={grid}
            waypoints={waypoints}
            robotAt={robotAt}
            onSelectPoint={handleSelectPoint}
            disabled={sending}
          />

          <div className="mt-4 pt-4 border-t border-[#E4ECE6] flex flex-wrap items-center gap-x-5 gap-y-2 text-[11px] text-[#78877D]">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#245C43]" />
              Origem (A)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#E7B85C] border border-[#9A7D0A]" />
              Destino (B)
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#65B98A]" />
              Passo intermediário
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#DDF4E5] border border-[#245C43]" />
              Estação
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded-full bg-[#F2F4F3] border border-[#D96B6B]" />
              Bloqueado
            </span>
            {robotAt && (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-full border-2 border-dashed border-[#3498DB]" />
                Posição atual
              </span>
            )}
          </div>
        </div>

        {/* The same route, as an editable list */}
        <div className="xl:col-span-2 bg-white rounded-xl border border-[#E4ECE6] p-5 flex flex-col">
          <div className="mb-4">
            <h3 className="text-sm font-bold text-[#25372D]">
              Lista de pontos da rota
            </h3>
            <p className="text-xs text-[#78877D]">
              A mesma rota em forma de lista. Edite uma coordenada ou acrescente
              pontos à mão — a malha ao lado acompanha.
            </p>
          </div>

          <div className="flex-1 min-h-0">
            {waypoints.length === 0 ? (
              <div className="h-48 flex flex-col items-center justify-center text-center text-xs text-[#78877D] border border-dashed border-[#E4ECE6] rounded-lg">
                <MapPin className="w-5 h-5 mb-2 text-[#B9C4BD]" />
                <span>Nenhum ponto na rota ainda.</span>
                <span className="mt-0.5">
                  Clique na malha ou adicione um ponto abaixo.
                </span>
              </div>
            ) : (
              <div className="max-h-96 overflow-y-auto -mx-1 px-1">
                <table className="w-full text-left border-collapse text-xs">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-[#E4ECE6] text-[#78877D] text-[10px] font-semibold uppercase">
                      <th className="py-2 pr-2 w-10">#</th>
                      <th className="py-2 pr-2">Ponto (x, y)</th>
                      <th className="py-2 pr-2">Sentido</th>
                      <th className="py-2 w-8" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E4ECE6]/60">
                    {waypoints.map((wp, index) => {
                      const isOrigin = index === 0;
                      const isDestination = index === waypoints.length - 1;

                      return (
                        <tr key={`${wp.x}-${wp.y}-${index}`} className="group">
                          <td className="py-1.5 pr-2">
                            <span className="inline-flex items-center justify-center w-6 h-6 rounded-md font-mono tabular-nums text-[10px] font-bold bg-[#F0F7F3] text-[#245C43]">
                              {index}
                            </span>
                          </td>

                          <td className="py-1.5 pr-2">
                            <div className="flex items-center gap-1.5">
                              <WaypointInput
                                value={`${wp.x},${wp.y}`}
                                label={`Coordenada do passo ${index}`}
                                onCommit={(raw) => handleReplace(index, raw)}
                              />
                              {isOrigin && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#245C43] text-white">
                                  A
                                </span>
                              )}
                              {isDestination && !isOrigin && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#E7B85C] text-[#4A3A08]">
                                  B
                                </span>
                              )}
                            </div>
                          </td>

                          <td className="py-1.5 pr-2 text-[#78877D] whitespace-nowrap">
                            {index === 0
                              ? '—'
                              : describeStep(waypoints[index - 1], wp)}
                          </td>

                          <td className="py-1.5">
                            <button
                              type="button"
                              onClick={() => handleRemove(index)}
                              className="p-1 rounded text-[#B9C4BD] hover:text-[#A93226] hover:bg-[#FDEDEC] transition-colors"
                              aria-label={`Remover o passo ${index}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Manual append */}
          <div className="mt-4 pt-4 border-t border-[#E4ECE6]">
            <div className="flex items-end gap-2">
              <label className="flex-1">
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#78877D] mb-1">
                  x
                </span>
                <input
                  type="number"
                  value={newX}
                  min={0}
                  max={grid.cols - 1}
                  onChange={(event) => setNewX(event.target.value)}
                  className="w-full px-2 py-1.5 font-mono tabular-nums text-xs text-[#25372D] bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg focus:outline-none focus:border-[#65B98A] focus:bg-white"
                />
              </label>
              <label className="flex-1">
                <span className="block text-[10px] font-semibold uppercase tracking-wider text-[#78877D] mb-1">
                  y
                </span>
                <input
                  type="number"
                  value={newY}
                  min={0}
                  max={grid.rows - 1}
                  onChange={(event) => setNewY(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleAppendManual();
                  }}
                  className="w-full px-2 py-1.5 font-mono tabular-nums text-xs text-[#25372D] bg-[#F7FAF8] border border-[#E4ECE6] rounded-lg focus:outline-none focus:border-[#65B98A] focus:bg-white"
                />
              </label>
              <button
                type="button"
                onClick={handleAppendManual}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#245C43] bg-[#BFE8D0] hover:bg-[#aee0c2] rounded-lg transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Adicionar</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Summary and dispatch */}
      <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-[#25372D] mb-1">
              Envio da rota
            </h3>

            {waypoints.length >= 2 ? (
              <p className="text-xs text-[#78877D] flex items-center gap-1.5 flex-wrap">
                <Flag className="w-3.5 h-3.5 text-[#245C43] shrink-0" />
                <span className="font-mono tabular-nums text-[#25372D] font-semibold">
                  {formatPoint(waypoints[0])}
                </span>
                <ArrowRight className="w-3.5 h-3.5 shrink-0" />
                <span className="font-mono tabular-nums text-[#25372D] font-semibold">
                  {formatPoint(waypoints[waypoints.length - 1])}
                </span>
                <span>
                  · {waypoints.length} pontos · {waypoints.length - 1} trechos
                </span>
              </p>
            ) : (
              <p className="text-xs text-[#78877D]">
                Monte uma rota com pelo menos dois pontos para enviá-la.
              </p>
            )}

            {activeRoute && (
              <p className="text-[11px] text-[#78877D] mt-1">
                Rota carregada no robô:{' '}
                <span className="font-mono tabular-nums">
                  {activeRoute.routeId}
                </span>{' '}
                · {activeRoute.waypoints.length} pontos · {activeRoute.status}
              </p>
            )}
          </div>

          <button
            type="button"
            onClick={handleSend}
            disabled={!canSend || sending}
            className="flex items-center justify-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-[#245C43] hover:bg-[#1d4a36] disabled:bg-[#B9C4BD] disabled:cursor-not-allowed rounded-lg transition-colors shrink-0"
          >
            {sending ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
            <span>{sending ? 'Enviando…' : 'Enviar rota ao robô'}</span>
          </button>
        </div>

        {(editError || validationError || sendError) && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-[#FDEDEC] border border-[#F5B7B1] text-xs text-[#A93226]">
            <TriangleAlert className="w-4 h-4 shrink-0 mt-px" />
            <span>{editError || validationError || sendError}</span>
          </div>
        )}

        {sendResult && !sendError && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-[#E8F6EE] border border-[#BFE8D0] text-xs text-[#1F7A4C]">
            <CheckCircle2 className="w-4 h-4 shrink-0 mt-px" />
            <span>{sendResult}</span>
          </div>
        )}
      </div>
    </div>
  );
};
