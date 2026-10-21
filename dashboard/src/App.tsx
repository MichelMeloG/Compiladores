/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Sidebar, NavPage } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';
import { Dashboard } from './pages/Dashboard';
import { Missions } from './pages/Missions';
import { Logs } from './pages/Logs';
import { Alerts } from './pages/Alerts';
import { Performance } from './pages/Performance';
import { Import } from './pages/Import';
import { getAlerts } from './services/alertsService';

export default function App() {
  const [currentPage, setCurrentPage] = useState<NavPage>('dashboard');
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeAlertCount, setActiveAlertCount] = useState(0);

  const loadAlertCount = useCallback(async () => {
    try {
      const unacked = await getAlerts({ status: 'unacknowledged' });
      setActiveAlertCount(unacked.length);
    } catch {
      // O badge é informativo: a falha em si é relatada dentro de cada página.
      setActiveAlertCount(0);
    }
  }, []);

  useEffect(() => {
    loadAlertCount();
  }, [loadAlertCount]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshTrigger((prev) => prev + 1);
    await loadAlertCount();
    setTimeout(() => setIsRefreshing(false), 400);
  };

  const getPageTitle = (page: NavPage): { title: string; subtitle: string } => {
    switch (page) {
      case 'dashboard':
        return {
          title: 'Visão Geral',
          subtitle: 'Acompanhe as operações e o desempenho do carrinho autônomo',
        };
      case 'missions':
        return {
          title: 'Missões e Percursos',
          subtitle: 'Histórico detalhado de percursos entre pontos operacionais',
        };
      case 'logs':
        return {
          title: 'Logs e Eventos',
          subtitle: 'Auditoria técnica de telemetria, comandos e sensores',
        };
      case 'alerts':
        return {
          title: 'Alertas e Problemas',
          subtitle: 'Monitoramento de falhas, paradas não programadas e avisos',
        };
      case 'performance':
        return {
          title: 'Desempenho',
          subtitle: 'Indicadores estatísticos consolidados e tendências de tempo',
        };
      case 'import':
        return {
          title: 'Importar Dados',
          subtitle: 'Envie arquivos de telemetria JSON ou CSV para o backend',
        };
    }
  };

  const pageMeta = getPageTitle(currentPage);

  // Presente apenas na publicação estática de demonstração; eliminado do
  // bundle nos builds normais (ver src/main.tsx).
  const isDemo = import.meta.env.VITE_DEMO === 'true';

  return (
    <div
      className={`flex min-h-screen bg-[#F7FAF8] text-[#25372D] ${
        isDemo ? 'pt-7' : ''
      }`}
    >
      {isDemo && (
        <div className="fixed top-0 inset-x-0 z-50 flex items-center justify-center gap-2 px-4 py-1.5 bg-[#9A7D0A] text-white text-[11px] font-semibold">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>
            Modo demonstração — dados fictícios para visualização da interface.
            Nenhum dado real do robô.
          </span>
        </div>
      )}

      {/* Sidebar Navigation */}
      <Sidebar
        currentPage={currentPage}
        onNavigate={setCurrentPage}
        isOpenMobile={isMobileOpen}
        onCloseMobile={() => setIsMobileOpen(false)}
        alertCount={activeAlertCount}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        <Header
          title={pageMeta.title}
          subtitle={pageMeta.subtitle}
          onOpenMobile={() => setIsMobileOpen(true)}
          onRefresh={handleRefresh}
          isRefreshing={isRefreshing}
          onNavigateToImport={() => setCurrentPage('import')}
        />

        <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl w-full mx-auto">
          {currentPage === 'dashboard' && (
            <Dashboard
              onNavigateToMissions={() => setCurrentPage('missions')}
              onNavigateToLogs={() => setCurrentPage('logs')}
              onNavigateToAlerts={() => setCurrentPage('alerts')}
              onNavigateToImport={() => setCurrentPage('import')}
              refreshTrigger={refreshTrigger}
            />
          )}

          {currentPage === 'missions' && <Missions refreshTrigger={refreshTrigger} />}

          {currentPage === 'logs' && <Logs refreshTrigger={refreshTrigger} />}

          {currentPage === 'alerts' && <Alerts refreshTrigger={refreshTrigger} />}

          {currentPage === 'performance' && <Performance refreshTrigger={refreshTrigger} />}

          {currentPage === 'import' && (
            <Import onImportSuccess={() => setRefreshTrigger((prev) => prev + 1)} />
          )}
        </main>
      </div>
    </div>
  );
}
