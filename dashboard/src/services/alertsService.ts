/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert } from '../types';
import { apiRequest } from './api';

export interface AlertFilterParams {
  severity?: string;
  status?: 'all' | 'unacknowledged' | 'acknowledged';
  missionId?: string;
  search?: string;
}

/**
 * Lista os alertas de segurança e falhas operacionais.
 *
 * Backend: `GET /alerts` — ver BACKEND_INTEGRATION.md §3.7.
 */
export async function getAlerts(filters?: AlertFilterParams): Promise<Alert[]> {
  const params = new URLSearchParams();

  if (filters?.severity && filters.severity !== 'all') {
    params.set('severity', filters.severity);
  }
  if (filters?.status && filters.status !== 'all') {
    params.set('status', filters.status);
  }
  if (filters?.missionId && filters.missionId !== 'all') {
    params.set('missionId', filters.missionId);
  }
  if (filters?.search) params.set('search', filters.search);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await apiRequest<Alert[]>(`alerts${query}`);

  return res.data ?? [];
}

/**
 * Marca um alerta como reconhecido pelo operador.
 *
 * Backend: `PATCH /alerts/:id/acknowledge` — ver BACKEND_INTEGRATION.md §3.7.
 * O reconhecimento é persistido no backend (não é estado local da interface).
 */
export async function acknowledgeAlert(alertId: string): Promise<boolean> {
  const res = await apiRequest<{ acknowledged: boolean }>(
    `alerts/${encodeURIComponent(alertId)}/acknowledge`,
    { method: 'PATCH' }
  );

  return res.data?.acknowledged ?? false;
}
