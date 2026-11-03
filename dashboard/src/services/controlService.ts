import { DeviceCommand, DeviceStatus, ExecutionState } from '../types';
import { apiRequest } from './api';
import { requestKey } from './routesService';

export type Control = 'start' | 'stop' | 'resume' | 'abort';
export const getDeviceStatus = async (id: string) =>
  (await apiRequest<DeviceStatus>(`devices/${encodeURIComponent(id)}/status`)).data;
export const getExecution = async (id: string) =>
  (await apiRequest<ExecutionState>(`missions/${encodeURIComponent(id)}/execution`)).data;
export const getCommand = async (id: string) =>
  (await apiRequest<DeviceCommand>(`commands/${encodeURIComponent(id)}`)).data;
export const closeUncertainMission = async (id: string) =>
  apiRequest(`missions/${encodeURIComponent(id)}/force-close`, { method: 'POST' });

export async function controlMission(execution: ExecutionState, action: Control) {
  return (await apiRequest<{ commandId: string }>(`missions/${encodeURIComponent(execution.missionId)}/${action}`, {
    method: 'POST', headers: { 'Idempotency-Key': requestKey() },
    body: JSON.stringify({ sessionId: execution.sessionId ?? undefined,
      ...(action === 'resume' ? { blockId: execution.blockId ?? 'operator-pause' } : {}) }),
  })).data;
}
