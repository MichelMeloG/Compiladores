/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventSeverity, EventType, MissionStatus, RoverState } from '../types';

/**
 * Formats duration in seconds into human-readable string (e.g., "1m 45s", "38s", "Indisponível")
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || isNaN(seconds) || seconds < 0) {
    return 'Indisponível';
  }
  const total = Math.round(seconds);
  if (total < 60) {
    return `${total}s`;
  }
  const mins = Math.floor(total / 60);
  const remainingSecs = total % 60;
  if (mins < 60) {
    return remainingSecs > 0 ? `${mins}m ${remainingSecs}s` : `${mins}m`;
  }
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

/**
 * Formats ISO timestamp to date & time
 */
export function formatDateTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return 'Data inválida';
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return 'Data inválida';
  }
}

/**
 * Formats ISO timestamp to time only (HH:mm:ss)
 */
export function formatTimeOnly(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Formats ISO timestamp to short date (DD/MM)
 */
export function formatShortDate(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || isNaN(value)) return '0%';
  return `${Math.round(value)}%`;
}

export function getMissionStatusMeta(status: MissionStatus): {
  label: string;
  badgeClass: string;
  dotClass: string;
} {
  switch (status) {
    case 'completed':
      return {
        label: 'Concluída',
        badgeClass: 'bg-[#DDF4E5] text-[#245C43] border border-[#BFE8D0]',
        dotClass: 'bg-[#4AAB79]',
      };
    case 'in_progress':
      return {
        label: 'Em andamento',
        badgeClass: 'bg-[#EBF5FB] text-[#2471A3] border border-[#AED6F1]',
        dotClass: 'bg-[#3498DB]',
      };
    case 'aborted':
      return {
        label: 'Interrompida',
        badgeClass: 'bg-[#FEF5E7] text-[#9A7D0A] border border-[#FAD7A0]',
        dotClass: 'bg-[#E7B85C]',
      };
    case 'failed':
      return {
        label: 'Com falha',
        badgeClass: 'bg-[#FDEDEC] text-[#922B21] border border-[#F5B7B1]',
        dotClass: 'bg-[#D96B6B]',
      };
    case 'indeterminate':
    default:
      return {
        label: 'Indeterminada',
        badgeClass: 'bg-[#F2F4F4] text-[#5D6D7E] border border-[#D5D8DC]',
        dotClass: 'bg-[#95A5A6]',
      };
  }
}

export function getSeverityMeta(severity: EventSeverity): {
  label: string;
  badgeClass: string;
  dotClass: string;
} {
  switch (severity) {
    case 'critical':
      return {
        label: 'Crítico',
        badgeClass: 'bg-[#FDEDEC] text-[#78281F] border border-[#D96B6B] font-semibold',
        dotClass: 'bg-[#C0392B]',
      };
    case 'error':
      return {
        label: 'Erro',
        badgeClass: 'bg-[#FDEDEC] text-[#922B21] border border-[#F5B7B1]',
        dotClass: 'bg-[#D96B6B]',
      };
    case 'warning':
      return {
        label: 'Aviso',
        badgeClass: 'bg-[#FEF5E7] text-[#9A7D0A] border border-[#FAD7A0]',
        dotClass: 'bg-[#E7B85C]',
      };
    case 'info':
    default:
      return {
        label: 'Informativo',
        badgeClass: 'bg-[#F0F7F3] text-[#25372D] border border-[#E4ECE6]',
        dotClass: 'bg-[#65B98A]',
      };
  }
}

export function getEventTypeLabel(type: EventType): string {
  switch (type) {
    case 'mission_start':
      return 'Início da Missão';
    case 'command':
      return 'Comando Executado';
    case 'state_change':
      return 'Mudança de Estado';
    case 'presence_detected':
      return 'Presença Detectada';
    case 'stop_preventive':
      return 'Parada Preventiva';
    case 'resume':
      return 'Retomada de Movimento';
    case 'destination_reached':
      return 'Destino Alcançado';
    case 'mission_end':
      return 'Fim da Missão';
    case 'error':
      return 'Falha / Erro';
    case 'warning':
      return 'Alerta do Sistema';
    case 'unknown':
    default:
      return 'Evento Registrado';
  }
}

export function getRoverStateLabel(state?: RoverState): string {
  switch (state) {
    case 'moving':
      return 'Em movimento';
    case 'stopped':
      return 'Parado';
    case 'obstacle_hold':
      return 'Aguardando desobstrução';
    case 'navigating':
      return 'Navegando rota';
    case 'completed':
      return 'No destino';
    case 'error':
      return 'Estado de erro';
    case 'idle':
      return 'Em repouso';
    default:
      return 'Indefinido';
  }
}
