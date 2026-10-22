/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { FleetMetrics, GlobalFilterState, Robot } from '../types';
import { apiRequest } from './api';

/**
 * Lista os robôs conectados à central.
 *
 * Backend: `GET /robots` — ver BACKEND_INTEGRATION.md §3.8.
 * Alimenta o seletor da barra lateral e os cartões da tela inicial.
 */
export async function getRobots(): Promise<Robot[]> {
  const res = await apiRequest<Robot[]>('robots');
  return res.data ?? [];
}

/**
 * Busca um robô específico.
 *
 * Backend: `GET /robots/:id` — ver BACKEND_INTEGRATION.md §3.9.
 */
export async function getRobotById(id: string): Promise<Robot | null> {
  const res = await apiRequest<Robot>(`robots/${encodeURIComponent(id)}`);
  return res.data ?? null;
}

/**
 * Obtém os indicadores agregados da frota inteira.
 *
 * Backend: `GET /fleet/metrics` — ver BACKEND_INTEGRATION.md §3.10.
 * Diferente de `GET /dashboard/metrics` por trazer também a contagem de
 * robôs por estado e o recorte por robô (`perRobot`).
 */
export async function getFleetMetrics(
  filters?: GlobalFilterState
): Promise<FleetMetrics> {
  const params = new URLSearchParams();

  if (filters?.period) params.set('period', filters.period);
  if (filters?.startDate) params.set('startDate', filters.startDate);
  if (filters?.endDate) params.set('endDate', filters.endDate);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await apiRequest<FleetMetrics>(`fleet/metrics${query}`);

  return res.data;
}
