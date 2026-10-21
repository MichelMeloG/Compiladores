/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Calendar } from 'lucide-react';
import { TimePeriod } from '../../types';

interface TimeFilterProps {
  period: TimePeriod;
  onPeriodChange: (period: TimePeriod) => void;
  startDate?: string;
  endDate?: string;
  onCustomDateChange?: (start?: string, end?: string) => void;
}

export const TimeFilter: React.FC<TimeFilterProps> = ({
  period,
  onPeriodChange,
  startDate,
  endDate,
  onCustomDateChange,
}) => {
  const options: Array<{ id: TimePeriod; label: string }> = [
    { id: '24h', label: '24 horas' },
    { id: '7d', label: '7 dias' },
    { id: '30d', label: '30 dias' },
    { id: 'all', label: 'Todo o histórico' },
    { id: 'custom', label: 'Personalizado' },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex p-1 bg-[#F0F7F3] rounded-lg border border-[#E4ECE6]">
        {options.map((opt) => {
          const isActive = period === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onPeriodChange(opt.id)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-white text-[#245C43] shadow-xs font-semibold'
                  : 'text-[#78877D] hover:text-[#25372D]'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>

      {period === 'custom' && onCustomDateChange && (
        <div className="flex items-center gap-2 bg-white px-3 py-1 rounded-lg border border-[#E4ECE6] text-xs">
          <Calendar className="w-3.5 h-3.5 text-[#78877D]" />
          <input
            type="date"
            value={startDate || ''}
            onChange={(e) => onCustomDateChange(e.target.value, endDate)}
            className="border-none bg-transparent text-[#25372D] text-xs focus:outline-none"
            title="Data inicial"
          />
          <span className="text-[#78877D]">até</span>
          <input
            type="date"
            value={endDate || ''}
            onChange={(e) => onCustomDateChange(startDate, e.target.value)}
            className="border-none bg-transparent text-[#25372D] text-xs focus:outline-none"
            title="Data final"
          />
        </div>
      )}
    </div>
  );
};
