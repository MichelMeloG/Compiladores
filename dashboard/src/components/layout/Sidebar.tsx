/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  LayoutDashboard,
  Route,
  ScrollText,
  AlertTriangle,
  BarChart3,
  UploadCloud,
  Bot,
  X,
} from 'lucide-react';
export type NavPage = 'dashboard' | 'missions' | 'logs' | 'alerts' | 'performance' | 'import';

interface SidebarProps {
  currentPage: NavPage;
  onNavigate: (page: NavPage) => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  alertCount?: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentPage,
  onNavigate,
  isOpenMobile,
  onCloseMobile,
  alertCount = 0,
}) => {
  const navItems: Array<{
    id: NavPage;
    label: string;
    icon: React.ElementType;
    badge?: number;
  }> = [
    { id: 'dashboard', label: 'Visão geral', icon: LayoutDashboard },
    { id: 'missions', label: 'Missões e percursos', icon: Route },
    { id: 'logs', label: 'Logs e eventos', icon: ScrollText },
    { id: 'alerts', label: 'Alertas e problemas', icon: AlertTriangle, badge: alertCount },
    { id: 'performance', label: 'Desempenho', icon: BarChart3 },
    { id: 'import', label: 'Importar dados', icon: UploadCloud },
  ];

  const sidebarContent = (
    <div className="flex flex-col h-full bg-white border-r border-[#E4ECE6] w-64 select-none">
      {/* Brand & Wordmark */}
      <div className="flex items-center justify-between px-6 py-5 border-b border-[#E4ECE6]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-[#245C43] text-[#BFE8D0] flex items-center justify-center shadow-xs">
            <Bot className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-base font-bold text-[#245C43] tracking-tight leading-tight">
              Rover Monitor
            </h1>
            <p className="text-[11px] text-[#78877D] font-medium leading-none mt-0.5">
              Observabilidade Robótica
            </p>
          </div>
        </div>

        {isOpenMobile && (
          <button
            type="button"
            onClick={onCloseMobile}
            className="md:hidden p-1.5 rounded-lg text-[#78877D] hover:bg-[#F7FAF8]"
            aria-label="Fechar navegação"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Main Navigation */}
      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-[#78877D]">
          Navegação Principal
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentPage === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                onNavigate(item.id);
                if (isOpenMobile) onCloseMobile();
              }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                isActive
                  ? 'bg-[#DDF4E5] text-[#245C43] font-semibold'
                  : 'text-[#25372D] hover:bg-[#F7FAF8] hover:text-[#245C43]'
              }`}
            >
              <div className="flex items-center gap-3">
                <Icon
                  className={`w-4 h-4 shrink-0 ${
                    isActive ? 'text-[#245C43]' : 'text-[#78877D]'
                  }`}
                />
                <span className="whitespace-nowrap">{item.label}</span>
              </div>

              {Boolean(item.badge && item.badge > 0) && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono tabular-nums bg-[#FEF5E7] text-[#9A7D0A] border border-[#FAD7A0]">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

    </div>
  );

  return (
    <>
      {/* Desktop Persistent Sidebar */}
      <aside className="hidden md:flex shrink-0 h-screen sticky top-0">
        {sidebarContent}
      </aside>

      {/* Mobile Slide-over Drawer */}
      {isOpenMobile && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="fixed inset-0 bg-black/30 backdrop-blur-xs transition-opacity"
            onClick={onCloseMobile}
            aria-hidden="true"
          />
          <div className="relative flex-1 flex flex-col max-w-xs w-full bg-white shadow-xl">
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
};
