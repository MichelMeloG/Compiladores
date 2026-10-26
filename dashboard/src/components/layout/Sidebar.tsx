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
  Gauge,
  Map,
  X,
  Loader2,
  WifiOff,
} from 'lucide-react';
import { Robot } from '../../types';
import { getRobotStatusMeta } from '../../utils/formatters';

export type NavPage =
  | 'dashboard'
  | 'missions'
  | 'logs'
  | 'alerts'
  | 'performance'
  | 'import'
  | 'route';

interface SidebarProps {
  currentPage: NavPage;
  /** `null` = escopo da frota; caso contrário, o robô aberto. */
  selectedRobotId: string | null;
  robots: Robot[];
  robotsLoading: boolean;
  robotsError: boolean;
  onNavigate: (page: NavPage) => void;
  onSelectRobot: (robotId: string) => void;
  onSelectFleet: () => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  alertCount?: number;
}

interface NavItem {
  id: NavPage;
  label: string;
  icon: React.ElementType;
  badge?: number;
}

/**
 * Navegação de dois níveis: a frota inteira e cada robô dentro dela.
 *
 * O robô selecionado é o escopo de tudo o que a área principal mostra —
 * por isso a lista de robôs fica aqui, junto da navegação, e não como um
 * filtro perdido dentro de uma página.
 */
export const Sidebar: React.FC<SidebarProps> = ({
  currentPage,
  selectedRobotId,
  robots,
  robotsLoading,
  robotsError,
  onNavigate,
  onSelectRobot,
  onSelectFleet,
  isOpenMobile,
  onCloseMobile,
  alertCount = 0,
}) => {
  const fleetItems: NavItem[] = [
    { id: 'dashboard', label: 'Visão geral da frota', icon: LayoutDashboard },
    { id: 'missions', label: 'Missões e percursos', icon: Route },
    { id: 'logs', label: 'Logs e eventos', icon: ScrollText },
    { id: 'alerts', label: 'Alertas e problemas', icon: AlertTriangle, badge: alertCount },
    { id: 'performance', label: 'Desempenho', icon: BarChart3 },
    { id: 'import', label: 'Importar dados', icon: UploadCloud },
  ];

  const robotItems: NavItem[] = [
    { id: 'dashboard', label: 'Painel do robô', icon: Gauge },
    { id: 'route', label: 'Definir rota', icon: Map },
    { id: 'missions', label: 'Missões', icon: Route },
    { id: 'logs', label: 'Logs', icon: ScrollText },
    { id: 'alerts', label: 'Alertas', icon: AlertTriangle },
  ];

  const closeAfter = (run: () => void) => () => {
    run();
    if (isOpenMobile) onCloseMobile();
  };

  const renderNavButton = (item: NavItem, active: boolean, nested = false) => {
    const Icon = item.icon;
    return (
      <button
        key={item.id}
        type="button"
        onClick={closeAfter(() => onNavigate(item.id))}
        className={`w-full flex items-center justify-between rounded-lg text-xs font-medium transition-colors ${
          nested ? 'pl-8 pr-3 py-2' : 'px-3 py-2.5'
        } ${
          active
            ? 'bg-[#DDF4E5] text-[#245C43] font-semibold'
            : 'text-[#25372D] hover:bg-[#F7FAF8] hover:text-[#245C43]'
        }`}
      >
        <div className="flex items-center gap-3">
          <Icon
            className={`w-4 h-4 shrink-0 ${
              active ? 'text-[#245C43]' : 'text-[#78877D]'
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
  };

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
              Controle de Frota
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

      <nav className="flex-1 px-3 py-4 overflow-y-auto">
        {/* Fleet-wide navigation */}
        <div className="px-3 pb-2 text-[10px] font-bold uppercase tracking-wider text-[#78877D]">
          Frota
        </div>

        <div className="space-y-1">
          {fleetItems.map((item) => {
            const active = selectedRobotId === null && currentPage === item.id;

            if (item.id === 'dashboard') {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={closeAfter(onSelectFleet)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[#DDF4E5] text-[#245C43] font-semibold'
                      : 'text-[#25372D] hover:bg-[#F7FAF8] hover:text-[#245C43]'
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      active ? 'text-[#245C43]' : 'text-[#78877D]'
                    }`}
                  />
                  <span className="whitespace-nowrap">{item.label}</span>
                </button>
              );
            }

            return renderNavButton(item, active);
          })}
        </div>

        {/* Robot selector */}
        <div className="mt-6 px-3 pb-2 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-[#78877D]">
            Robôs conectados
          </span>
          {!robotsLoading && !robotsError && (
            <span className="text-[10px] font-mono tabular-nums text-[#78877D]">
              {robots.filter((r) => r.status !== 'offline').length}/{robots.length}
            </span>
          )}
        </div>

        {robotsLoading && (
          <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-[#78877D]">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            <span>Procurando robôs…</span>
          </div>
        )}

        {!robotsLoading && robotsError && (
          <div className="flex items-start gap-2 px-3 py-2 text-[11px] text-[#78877D]">
            <WifiOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>Lista de robôs indisponível.</span>
          </div>
        )}

        {!robotsLoading && !robotsError && robots.length === 0 && (
          <div className="px-3 py-2 text-[11px] text-[#78877D]">
            Nenhum robô conectado.
          </div>
        )}

        <div className="space-y-1">
          {robots.map((robot) => {
            const isSelected = selectedRobotId === robot.id;
            const meta = getRobotStatusMeta(robot.status);

            return (
              <div key={robot.id}>
                <button
                  type="button"
                  onClick={closeAfter(() => onSelectRobot(robot.id))}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors ${
                    isSelected
                      ? 'bg-[#DDF4E5] text-[#245C43] font-semibold'
                      : 'text-[#25372D] hover:bg-[#F7FAF8] hover:text-[#245C43]'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${meta.dotClass}`}
                    aria-hidden="true"
                  />
                  <span className="flex-1 min-w-0 text-left">
                    <span className="block truncate">{robot.name}</span>
                    <span className="block text-[10px] font-mono tabular-nums text-[#78877D] leading-tight">
                      {robot.id} · {meta.label}
                    </span>
                  </span>
                  {robot.activeAlertsCount > 0 && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold font-mono tabular-nums bg-[#FEF5E7] text-[#9A7D0A] border border-[#FAD7A0]">
                      {robot.activeAlertsCount}
                    </span>
                  )}
                </button>

                {/* Per-robot navigation, nested under the open robot */}
                {isSelected && (
                  <div className="mt-1 mb-2 space-y-0.5 border-l-2 border-[#DDF4E5] ml-4">
                    {robotItems.map((item) =>
                      renderNavButton(item, currentPage === item.id, true)
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
