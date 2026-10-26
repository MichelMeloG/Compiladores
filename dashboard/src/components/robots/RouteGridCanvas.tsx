/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import { RobotGrid, RouteWaypoint } from '../../types';
import {
  formatPoint,
  indexGridPoints,
  pointKey,
  samePoint,
} from '../../utils/routeGrid';

interface RouteGridCanvasProps {
  grid: RobotGrid;
  waypoints: RouteWaypoint[];
  /** Posição atual do robô na malha, quando conhecida. */
  robotAt?: RouteWaypoint | null;
  onSelectPoint: (point: RouteWaypoint) => void;
  disabled?: boolean;
}

const CELL = 88;
const PAD_X = 56;
const PAD_Y = 48;
const VERTEX_R = 9;

/**
 * A malha clicável do chão de fábrica.
 *
 * Desenha os trilhos, os vértices e a rota traçada por cima deles. Toda a
 * matemática de rota mora em `utils/routeGrid` — aqui só há geometria de
 * tela: converter `(x, y)` da malha em coordenadas do SVG e reagir ao
 * clique.
 *
 * O SVG escala pelo `viewBox`, então a malha acompanha a largura
 * disponível sem recalcular nada em JavaScript.
 */
export const RouteGridCanvas: React.FC<RouteGridCanvasProps> = ({
  grid,
  waypoints,
  robotAt,
  onSelectPoint,
  disabled = false,
}) => {
  const [hovered, setHovered] = useState<string | null>(null);

  const width = PAD_X * 2 + (grid.cols - 1) * CELL;
  const height = PAD_Y * 2 + (grid.rows - 1) * CELL;

  const cx = (x: number) => PAD_X + x * CELL;
  const cy = (y: number) => PAD_Y + y * CELL;

  const special = useMemo(() => indexGridPoints(grid), [grid]);

  /** Quantas vezes a rota passa por cada vértice, e em que passo. */
  const visits = useMemo(() => {
    const map = new Map<string, number[]>();
    waypoints.forEach((wp, index) => {
      const key = pointKey(wp);
      const list = map.get(key) ?? [];
      list.push(index);
      map.set(key, list);
    });
    return map;
  }, [waypoints]);

  const origin = waypoints[0];
  const destination =
    waypoints.length > 1 ? waypoints[waypoints.length - 1] : undefined;

  const vertices: RouteWaypoint[] = useMemo(() => {
    const list: RouteWaypoint[] = [];
    for (let y = 0; y < grid.rows; y++) {
      for (let x = 0; x < grid.cols; x++) {
        list.push({ x, y });
      }
    }
    return list;
  }, [grid.rows, grid.cols]);

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-auto max-w-full"
        style={{ minWidth: Math.min(width, 420) }}
        role="group"
        aria-label="Malha de navegação do robô"
      >
        <defs>
          <marker
            id="route-arrow"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#245C43" />
          </marker>
        </defs>

        {/* Rails: the robot only travels along these lines */}
        <g>
          {Array.from({ length: grid.rows }, (_, y) => (
            <line
              key={`h-${y}`}
              x1={cx(0)}
              y1={cy(y)}
              x2={cx(grid.cols - 1)}
              y2={cy(y)}
              stroke="#D8E6DD"
              strokeWidth={2}
            />
          ))}
          {Array.from({ length: grid.cols }, (_, x) => (
            <line
              key={`v-${x}`}
              x1={cx(x)}
              y1={cy(0)}
              x2={cx(x)}
              y2={cy(grid.rows - 1)}
              stroke="#D8E6DD"
              strokeWidth={2}
            />
          ))}
        </g>

        {/* Axis labels */}
        <g
          fontFamily="ui-monospace, monospace"
          fontSize={11}
          fill="#8AA394"
          textAnchor="middle"
        >
          {Array.from({ length: grid.cols }, (_, x) => (
            <text key={`lx-${x}`} x={cx(x)} y={PAD_Y - 24}>
              {x}
            </text>
          ))}
          {Array.from({ length: grid.rows }, (_, y) => (
            <text key={`ly-${y}`} x={PAD_X - 30} y={cy(y) + 4}>
              {y}
            </text>
          ))}
        </g>

        {/* The traced route, drawn over the rails */}
        {waypoints.length > 1 && (
          <g>
            <polyline
              points={waypoints.map((wp) => `${cx(wp.x)},${cy(wp.y)}`).join(' ')}
              fill="none"
              stroke="#BFE8D0"
              strokeWidth={10}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {waypoints.slice(0, -1).map((wp, index) => {
              const next = waypoints[index + 1];
              return (
                <line
                  key={`seg-${index}`}
                  x1={cx(wp.x)}
                  y1={cy(wp.y)}
                  x2={cx(next.x)}
                  y2={cy(next.y)}
                  stroke="#245C43"
                  strokeWidth={2.5}
                  markerEnd="url(#route-arrow)"
                />
              );
            })}
          </g>
        )}

        {/* Vertices */}
        <g>
          {vertices.map((vertex) => {
            const key = pointKey(vertex);
            const info = special.get(key);
            const blocked = info?.kind === 'blocked';
            const station = info?.kind === 'station';
            const steps = visits.get(key);
            const onRoute = Boolean(steps);
            const isOrigin = origin && samePoint(origin, vertex);
            const isDestination = destination && samePoint(destination, vertex);
            const isHovered = hovered === key;

            let fill = '#FFFFFF';
            let stroke = '#B9C4BD';
            let radius = VERTEX_R;

            if (blocked) {
              fill = '#F2F4F3';
              stroke = '#D96B6B';
            } else if (isOrigin) {
              fill = '#245C43';
              stroke = '#245C43';
              radius = VERTEX_R + 4;
            } else if (isDestination) {
              fill = '#E7B85C';
              stroke = '#9A7D0A';
              radius = VERTEX_R + 4;
            } else if (onRoute) {
              fill = '#65B98A';
              stroke = '#245C43';
              radius = VERTEX_R + 1;
            } else if (station) {
              fill = '#DDF4E5';
              stroke = '#245C43';
            }

            return (
              <g
                key={key}
                onClick={() => {
                  if (!disabled && !blocked) onSelectPoint(vertex);
                }}
                onMouseEnter={() => setHovered(key)}
                onMouseLeave={() => setHovered((prev) => (prev === key ? null : prev))}
                style={{
                  cursor: disabled || blocked ? 'not-allowed' : 'pointer',
                }}
                role="button"
                tabIndex={disabled || blocked ? -1 : 0}
                aria-label={`Ponto ${formatPoint(vertex)}${
                  blocked ? ', bloqueado' : ''
                }${info?.label ? `, ${info.label}` : ''}`}
                onKeyDown={(event) => {
                  if (disabled || blocked) return;
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectPoint(vertex);
                  }
                }}
              >
                {/* Generous invisible hit area — the dots are small */}
                <circle
                  cx={cx(vertex.x)}
                  cy={cy(vertex.y)}
                  r={CELL / 2.6}
                  fill="transparent"
                />

                {isHovered && !disabled && !blocked && (
                  <circle
                    cx={cx(vertex.x)}
                    cy={cy(vertex.y)}
                    r={radius + 7}
                    fill="#245C43"
                    opacity={0.08}
                  />
                )}

                <circle
                  cx={cx(vertex.x)}
                  cy={cy(vertex.y)}
                  r={radius}
                  fill={fill}
                  stroke={stroke}
                  strokeWidth={2}
                />

                {blocked && (
                  <path
                    d={`M ${cx(vertex.x) - 4} ${cy(vertex.y) - 4} L ${
                      cx(vertex.x) + 4
                    } ${cy(vertex.y) + 4} M ${cx(vertex.x) + 4} ${
                      cy(vertex.y) - 4
                    } L ${cx(vertex.x) - 4} ${cy(vertex.y) + 4}`}
                    stroke="#D96B6B"
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                )}

                {/* A / B markers, as in the hand sketch */}
                {isOrigin && (
                  <text
                    x={cx(vertex.x)}
                    y={cy(vertex.y) + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight="700"
                    fill="#FFFFFF"
                    fontFamily="ui-monospace, monospace"
                  >
                    A
                  </text>
                )}
                {isDestination && (
                  <text
                    x={cx(vertex.x)}
                    y={cy(vertex.y) + 4}
                    textAnchor="middle"
                    fontSize={11}
                    fontWeight="700"
                    fill="#4A3A08"
                    fontFamily="ui-monospace, monospace"
                  >
                    B
                  </text>
                )}

                {/* Step index for the intermediate points */}
                {onRoute && !isOrigin && !isDestination && steps && (
                  <text
                    x={cx(vertex.x)}
                    y={cy(vertex.y) + 3.5}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight="700"
                    fill="#FFFFFF"
                    fontFamily="ui-monospace, monospace"
                  >
                    {steps[0]}
                  </text>
                )}

                {(isHovered || info?.label) && (
                  <text
                    x={cx(vertex.x)}
                    /* Na primeira linha o rótulo desce, para não colidir
                       com os números do eixo horizontal. */
                    y={
                      vertex.y === 0
                        ? cy(vertex.y) + radius + 14
                        : cy(vertex.y) - radius - 8
                    }
                    textAnchor="middle"
                    fontSize={10}
                    fill="#4C6355"
                    fontFamily="ui-monospace, monospace"
                  >
                    {info?.label && !isHovered
                      ? info.label
                      : `${vertex.x},${vertex.y}`}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Where the robot actually is right now */}
        {robotAt && (
          <g pointerEvents="none">
            <circle
              cx={cx(robotAt.x)}
              cy={cy(robotAt.y)}
              r={VERTEX_R + 10}
              fill="none"
              stroke="#3498DB"
              strokeWidth={2}
              strokeDasharray="4 3"
            />
          </g>
        )}
      </svg>
    </div>
  );
};
