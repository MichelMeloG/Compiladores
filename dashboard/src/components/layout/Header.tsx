/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Menu, RefreshCw, Upload } from 'lucide-react';

interface HeaderProps {
  title: string;
  subtitle?: string;
  onOpenMobile: () => void;
  onRefresh: () => void;
  isRefreshing: boolean;
  onNavigateToImport: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  title,
  subtitle,
  onOpenMobile,
  onRefresh,
  isRefreshing,
  onNavigateToImport,
}) => {
  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-4 px-6 py-4 bg-white/90 backdrop-blur-md border-b border-[#E4ECE6]">
      {/* Zone 1: Mobile Hamburger & Page Context */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onOpenMobile}
          className="md:hidden p-2 rounded-lg text-[#78877D] hover:bg-[#F0F7F3]"
          aria-label="Abrir menu"
        >
          <Menu className="w-5 h-5 text-[#25372D]" />
        </button>

        <div className="truncate">
          <div className="flex items-center gap-2 text-xs text-[#78877D]">
            <span>Rover Monitor</span>
            <span aria-hidden="true">/</span>
            <span className="text-[#25372D] font-medium">{title}</span>
          </div>
          {subtitle && (
            <p className="text-xs text-[#78877D] hidden sm:block truncate mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
      </div>

      {/* Zone 2 & 3: Status & Functional Actions */}
      <div className="flex items-center gap-3 shrink-0">
        {/* Quick Refresh */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          title="Atualizar dados da fonte ativa"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E4ECE6] text-xs font-medium text-[#25372D] hover:bg-[#F7FAF8] active:bg-[#E4ECE6] transition-colors disabled:opacity-50"
        >
          <RefreshCw
            className={`w-3.5 h-3.5 text-[#245C43] ${
              isRefreshing ? 'animate-spin' : ''
            }`}
          />
          <span className="hidden sm:inline">Atualizar</span>
        </button>

        {/* Import Action */}
        <button
          type="button"
          onClick={onNavigateToImport}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold text-[#245C43] bg-[#BFE8D0] hover:bg-[#aee0c2] transition-colors shadow-xs"
        >
          <Upload className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Importar Logs</span>
          <span className="sm:hidden">Importar</span>
        </button>
      </div>
    </header>
  );
};
