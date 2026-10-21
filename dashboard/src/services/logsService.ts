/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GlobalFilterState, ImportResult, LogEvent } from '../types';
import { apiRequest } from './api';

export interface LogFilterParams extends Partial<GlobalFilterState> {
  missionId?: string;
  eventType?: string;
  severity?: string;
}

/**
 * Lista os eventos de telemetria do carrinho.
 *
 * Backend: `GET /logs` — ver BACKEND_INTEGRATION.md §3.5.
 * Espera-se a lista ordenada do mais recente para o mais antigo.
 */
export async function getLogs(filters?: LogFilterParams): Promise<LogEvent[]> {
  const params = new URLSearchParams();

  if (filters?.period) params.set('period', filters.period);
  if (filters?.startDate) params.set('startDate', filters.startDate);
  if (filters?.endDate) params.set('endDate', filters.endDate);
  if (filters?.missionId && filters.missionId !== 'all') {
    params.set('missionId', filters.missionId);
  }
  if (filters?.eventType && filters.eventType !== 'all') {
    params.set('eventType', filters.eventType);
  }
  if (filters?.severity && filters.severity !== 'all') {
    params.set('severity', filters.severity);
  }
  if (filters?.search) params.set('search', filters.search);

  const query = params.toString() ? `?${params.toString()}` : '';
  const res = await apiRequest<LogEvent[]>(`logs${query}`);

  return res.data ?? [];
}

/**
 * Envia um lote de eventos já normalizados para persistência no backend.
 *
 * Backend: `POST /logs/import` — ver BACKEND_INTEGRATION.md §3.6.
 * Usado pela página de importação após o parse local do arquivo.
 */
export async function importLogs(events: LogEvent[]): Promise<ImportResult> {
  const res = await apiRequest<ImportResult>('logs/import', {
    method: 'POST',
    body: JSON.stringify({ events }),
  });

  return res.data ?? { importedCount: 0 };
}
