/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { LucideIcon } from 'lucide-react';

interface KpiCardProps {
  title: string;
  value: string | number;
  description?: string;
  icon: LucideIcon;
  diff?: {
    value: string;
    isPositive?: boolean;
    neutral?: boolean;
  };
  highlight?: boolean;
  loading?: boolean;
}

export const KpiCard: React.FC<KpiCardProps> = ({
  title,
  value,
  description,
  icon: Icon,
  diff,
  highlight = false,
  loading = false,
}) => {
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-[#E4ECE6] p-5 animate-pulse">
        <div className="flex items-center justify-between mb-3">
          <div className="h-4 w-24 bg-[#E4ECE6] rounded"></div>
          <div className="h-9 w-9 bg-[#F0F7F3] rounded-lg"></div>
        </div>
        <div className="h-8 w-20 bg-[#E4ECE6] rounded mb-2"></div>
        <div className="h-3 w-32 bg-[#F0F7F3] rounded"></div>
      </div>
    );
  }

  return (
    <div
      className={`bg-white rounded-xl border p-5 transition-shadow duration-150 hover:shadow-xs ${
        highlight ? 'border-[#BFE8D0] ring-1 ring-[#BFE8D0]/50' : 'border-[#E4ECE6]'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-[#78877D]">
          {title}
        </span>
        <div
          className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
            highlight ? 'bg-[#DDF4E5] text-[#245C43]' : 'bg-[#F0F7F3] text-[#245C43]'
          }`}
        >
          <Icon className="w-4.5 h-4.5" />
        </div>
      </div>

      <div className="flex items-baseline gap-2 mb-1">
        <span className="text-2xl font-bold font-mono tabular-nums text-[#25372D]">
          {value}
        </span>
        {diff && (
          <span
            className={`text-xs font-medium font-mono tabular-nums ${
              diff.neutral
                ? 'text-[#78877D]'
                : diff.isPositive
                ? 'text-[#4AAB79]'
                : 'text-[#D96B6B]'
            }`}
          >
            {diff.value}
          </span>
        )}
      </div>

      {description && (
        <p className="text-xs text-[#78877D] line-clamp-1">{description}</p>
      )}
    </div>
  );
};
