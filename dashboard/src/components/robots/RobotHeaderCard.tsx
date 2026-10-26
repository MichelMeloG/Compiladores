/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { BatteryMedium, Bot, Cpu, MapPin, Radio, Route } from 'lucide-react';
import { Robot } from '../../types';
import {
  formatRelativeTime,
  getRobotStatusMeta,
  getRoverStateLabel,
} from '../../utils/formatters';

interface RobotHeaderCardProps {
  robot: Robot;
  loading?: boolean;
}

/**
 * Cartão de identificação do robô aberto.
 *
 * Fica no topo de todas as telas do escopo de um robô, para o operador
 * nunca perder de vista de qual máquina são os números abaixo.
 */
export const RobotHeaderCard: React.FC<RobotHeaderCardProps> = ({
  robot,
  loading = false,
}) => {
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 animate-pulse">
        <div className="h-5 w-48 bg-[#E4ECE6] rounded mb-3" />
        <div className="h-3 w-72 bg-[#F0F7F3] rounded" />
      </div>
    );
  }

  const meta = getRobotStatusMeta(robot.status);

  const facts: Array<{ icon: React.ElementType; label: string; value: string }> = [
    {
      icon: Radio,
      label: 'Estado',
      value: getRoverStateLabel(robot.roverState),
    },
    {
      icon: MapPin,
      label: 'Posição na malha',
      value: robot.currentPoint ? `(${robot.currentPoint.replace(',', ', ')})` : '—',
    },
    {
      icon: BatteryMedium,
      label: 'Bateria',
      value:
        robot.batteryPercent === null || robot.batteryPercent === undefined
          ? '—'
          : `${Math.round(robot.batteryPercent)}%`,
    },
    {
      icon: Route,
      label: 'Missão atual',
      value: robot.currentMissionId || 'Nenhuma',
    },
    {
      icon: Cpu,
      label: 'Firmware',
      value: robot.firmwareVersion || '—',
    },
  ];

  return (
    <div className="bg-white rounded-xl border border-[#E4ECE6] p-5">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-11 h-11 rounded-xl bg-[#F0F7F3] text-[#245C43] flex items-center justify-center shrink-0">
            <Bot className="w-5.5 h-5.5" />
          </div>

          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-base font-bold text-[#245C43] truncate">
                {robot.name}
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap ${meta.badgeClass}`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${meta.dotClass}`}
                  aria-hidden="true"
                />
                <span>{meta.label}</span>
              </span>
            </div>

            <p className="text-xs text-[#78877D] mt-0.5">
              <span className="font-mono tabular-nums">{robot.id}</span>
              {robot.model ? ` · ${robot.model}` : ''}
              {robot.area ? ` · ${robot.area}` : ''}
            </p>
          </div>
        </div>

        <div className="text-xs text-[#78877D] whitespace-nowrap sm:text-right">
          Visto por último
          <div className="font-mono tabular-nums text-[#25372D]">
            {formatRelativeTime(robot.lastSeenAt)}
          </div>
        </div>
      </div>

      <div className="mt-5 pt-4 border-t border-[#E4ECE6] grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {facts.map((fact) => {
          const Icon = fact.icon;
          return (
            <div key={fact.label} className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#78877D] mb-1">
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{fact.label}</span>
              </div>
              <div className="text-xs font-medium text-[#25372D] font-mono tabular-nums truncate">
                {fact.value}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
