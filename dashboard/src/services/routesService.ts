/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ActiveRoute, Heading, RobotGrid, RouteSubmitResult, RouteWaypoint } from '../types';
import { ApiError, apiRequest } from './api';

export const requestKey = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/**
 * Obtém a malha percorrível de um robô.
 *
 * Backend: `GET /robots/:id/grid` — ver BACKEND_INTEGRATION.md §3.11.
 * É o backend que define o tamanho da grade, as estações e os pontos
 * bloqueados: a interface apenas desenha o que recebe.
 */
export async function getRobotGrid(robotId: string): Promise<RobotGrid> {
  const res = await apiRequest<RobotGrid>(
    `robots/${encodeURIComponent(robotId)}/grid`
  );
  return res.data;
}

/**
 * Lê a rota atualmente carregada no robô.
 *
 * Backend: `GET /robots/:id/route` — ver BACKEND_INTEGRATION.md §3.12.
 * Devolve `null` quando o robô não tem rota definida (HTTP 404), que é
 * situação normal e não erro de comunicação.
 */
export async function getActiveRoute(robotId: string): Promise<ActiveRoute | null> {
  try {
    const res = await apiRequest<ActiveRoute>(`robots/${encodeURIComponent(robotId)}/route`);
    return res.data ?? null;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Envia ao robô a rota montada pelo operador.
 *
 * Backend: `POST /robots/:id/route` — ver BACKEND_INTEGRATION.md §3.13.
 *
 * O corpo é a sequência ordenada de vértices, do primeiro ao último, com
 * vértices consecutivos sempre adjacentes na malha. Traduzir essa lista
 * em comandos de tração é responsabilidade do backend/compilador — o
 * frontend não emite direções.
 */
export async function submitRoute(
  robotId: string,
  waypoints: RouteWaypoint[],
  initialHeading?: Heading
): Promise<RouteSubmitResult> {
  const res = await apiRequest<RouteSubmitResult>(
    `robots/${encodeURIComponent(robotId)}/route`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': requestKey() },
      body: JSON.stringify({ waypoints, initialHeading }),
    }
  );

  return (
    res.data ?? {
      routeId: '',
      accepted: false,
      waypointCount: waypoints.length,
    }
  );
}

export async function confirmPosition(robotId: string, point: RouteWaypoint, heading: Heading): Promise<void> {
  await apiRequest(`robots/${encodeURIComponent(robotId)}/position`, {
    method: 'POST', headers: { 'Idempotency-Key': requestKey() },
    body: JSON.stringify({ ...point, heading }),
  });
}

export async function previewRoute(robotId: string, waypoints: RouteWaypoint[], initialHeading: Heading) {
  return (await apiRequest<{ executable: boolean; actions: string[]; errors: { message: string }[] }>(
    `robots/${encodeURIComponent(robotId)}/route/preview`,
    { method: 'POST', body: JSON.stringify({ waypoints, initialHeading }) },
  )).data;
}
