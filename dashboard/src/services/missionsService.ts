/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GlobalFilterState, Mission } from '../types';
import { apiRequest } from './api';

/**
 * Lista as missões/percursos registrados.
 *
 * Backend: `GET /missions` — ver BACKEND_INTEGRATION.md §3.3.
 * Os filtros são enviados como query params; o backend deve devolver
 * a lista já filtrada pelo período solicitado.
 */
export async function getMissions(filters?: GlobalFilterState): Promise<Mission[]> {
  const params = new URLSearchParams();

  if (filters?.period) params.set('period', filters.period);
  if (filters?.startDate) params.set('startDate', filters.startDate);
  if (filters?.endDate) params.set('endDate', filters.endDate);
  if (filters?.origin) params.set('origin', filters.origin);
  if (filters?.destination) params.set('destination', filters.destination);
  if (filters?.status && filters.status !== 'all') params.set('status', filters.status);
  if (filters?.search) params.set('search', filters.search);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await apiRequest<Mission[]>(`missions${query}`);

  return res.data ?? [];
}

/**
 * Busca uma missão específica, incluindo a linha do tempo de eventos.
 *
 * Backend: `GET /missions/:id` — ver BACKEND_INTEGRATION.md §3.4.
 */
export async function getMissionById(id: string): Promise<Mission | null> {
  const res = await apiRequest<Mission>(`missions/${encodeURIComponent(id)}`);
  return res.data ?? null;
}
