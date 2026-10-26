/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ActiveRoute, RobotGrid, RouteSubmitResult, RouteWaypoint } from '../types';
import { apiRequest } from './api';

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
  const res = await apiRequest<ActiveRoute | null>(
    `robots/${encodeURIComponent(robotId)}/route`
  );
  return res.data ?? null;
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
  waypoints: RouteWaypoint[]
): Promise<RouteSubmitResult> {
  const res = await apiRequest<RouteSubmitResult>(
    `robots/${encodeURIComponent(robotId)}/route`,
    {
      method: 'POST',
      body: JSON.stringify({ waypoints }),
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
