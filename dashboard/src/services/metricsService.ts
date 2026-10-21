/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DashboardMetrics, GlobalFilterState } from '../types';
import { apiRequest } from './api';

/**
 * Obtém os KPIs agregados exibidos no dashboard e na página de desempenho.
 *
 * Backend: `GET /dashboard/metrics` — ver BACKEND_INTEGRATION.md §3.2.
 * A agregação (médias, medianas, taxas) é responsabilidade do backend:
 * o frontend apenas formata e exibe os números recebidos.
 */
export async function getDashboardMetrics(
  filters?: GlobalFilterState
): Promise<DashboardMetrics> {
  const params = new URLSearchParams();

  if (filters?.period) params.set('period', filters.period);
  if (filters?.startDate) params.set('startDate', filters.startDate);
  if (filters?.endDate) params.set('endDate', filters.endDate);
  if (filters?.origin) params.set('origin', filters.origin);
  if (filters?.destination) params.set('destination', filters.destination);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await apiRequest<DashboardMetrics>(`dashboard/metrics${query}`);

  return res.data;
}
