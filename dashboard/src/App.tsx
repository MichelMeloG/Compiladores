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
import { RoutePlanner } from './pages/RoutePlanner';
import { getAlerts } from './services/alertsService';
import { getRobots } from './services/robotsService';
import { Robot } from './types';

export default function App() {
  const [currentPage, setCurrentPage] = useState<NavPage>('dashboard');
  /**
   * Escopo da aplicação: `null` é a frota inteira (tela inicial), e um id
   * é o robô aberto. Todas as páginas recebem esse valor e consultam o
   * backend já restritas a ele.
   */
  const [selectedRobotId, setSelectedRobotId] = useState<string | null>(null);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [activeAlertCount, setActiveAlertCount] = useState(0);

  const [robots, setRobots] = useState<Robot[]>([]);
  const [robotsLoading, setRobotsLoading] = useState(true);
  const [robotsError, setRobotsError] = useState(false);

  const loadAlertCount = useCallback(async () => {
    try {
      const unacked = await getAlerts({ status: 'unacknowledged' });
      setActiveAlertCount(unacked.length);
    } catch {
      // O badge é informativo: a falha em si é relatada dentro de cada página.
      setActiveAlertCount(0);
    }
  }, []);

  /**
   * A lista de robôs é da barra lateral, não de uma página: é ela que
   * define onde o operador está. Por isso é carregada aqui, uma vez, e
   * recarregada junto do botão "Atualizar".
   */
  const loadRobots = useCallback(async () => {
    setRobotsLoading(true);
    try {
      const list = await getRobots();
      setRobots(list);
      setRobotsError(false);
    } catch {
      // A falha aparece como aviso discreto na lista lateral; o relato
      // completo fica na área principal, onde os dados apareceriam.
      setRobots([]);
      setRobotsError(true);
    } finally {
      setRobotsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAlertCount();
    loadRobots();
  }, [loadAlertCount, loadRobots]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setRefreshTrigger((prev) => prev + 1);
    await Promise.all([loadAlertCount(), loadRobots()]);
    setTimeout(() => setIsRefreshing(false), 400);
  };

  const handleSelectRobot = (robotId: string) => {
    setSelectedRobotId(robotId);
    // Entrar num robô sempre abre o painel dele, nunca a página anterior
    // aplicada a outro escopo.
    setCurrentPage('dashboard');
  };

  const handleSelectFleet = () => {
    setSelectedRobotId(null);
    setCurrentPage('dashboard');
  };

  const selectedRobot = robots.find((robot) => robot.id === selectedRobotId);
  const robotLabel = selectedRobot?.name ?? selectedRobotId ?? '';

  const getPageMeta = (page: NavPage): { title: string; subtitle: string } => {
    if (selectedRobotId === null) {
      switch (page) {
        case 'dashboard':
          return {
            title: 'Visão Geral da Frota',
            subtitle:
              'Operação e desempenho de todos os robôs conectados à central',
          };
        case 'missions':
          return {
            title: 'Missões e Percursos',
            subtitle: 'Histórico de percursos de toda a frota',
          };
        case 'logs':
          return {
            title: 'Logs e Eventos',
            subtitle: 'Auditoria técnica de telemetria, comandos e sensores',
          };
        case 'alerts':
          return {
            title: 'Alertas e Problemas',
            subtitle: 'Falhas, paradas não programadas e avisos da frota',
          };
        case 'performance':
          return {
            title: 'Desempenho',
            subtitle: 'Indicadores consolidados e tendências de tempo',
          };
        case 'import':
          return {
            title: 'Importar Dados',
            subtitle: 'Envie arquivos de telemetria JSON ou CSV para o backend',
          };
        case 'route':
          return {
            title: 'Definir Rota',
            subtitle: 'Selecione um robô na barra lateral para traçar sua rota',
          };
      }
    }

    switch (page) {
      case 'dashboard':
        return {
          title: robotLabel,
          subtitle: 'Painel completo deste robô: atividade, percursos e alertas',
        };
      case 'route':
        return {
          title: `Rota — ${robotLabel}`,
          subtitle: 'Trace o percurso na malha ou monte a lista de pontos à mão',
        };
      case 'missions':
        return {
          title: `Missões — ${robotLabel}`,
          subtitle: 'Percursos executados por este robô',
        };
      case 'logs':
        return {
          title: `Logs — ${robotLabel}`,
          subtitle: 'Telemetria, comandos e sensores deste robô',
        };
      case 'alerts':
        return {
          title: `Alertas — ${robotLabel}`,
          subtitle: 'Falhas e avisos registrados por este robô',
        };
      case 'performance':
        return {
          title: `Desempenho — ${robotLabel}`,
          subtitle: 'Indicadores consolidados deste robô',
        };
      case 'import':
        return {
          title: 'Importar Dados',
          subtitle: 'Envie arquivos de telemetria JSON ou CSV para o backend',
        };
    }
  };

  const pageMeta = getPageMeta(currentPage);

  /** `undefined` nas páginas significa "frota inteira". */
  const scopedRobotId = selectedRobotId ?? undefined;

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
        selectedRobotId={selectedRobotId}
        robots={robots}
        robotsLoading={robotsLoading}
        robotsError={robotsError}
        onNavigate={setCurrentPage}
        onSelectRobot={handleSelectRobot}
        onSelectFleet={handleSelectFleet}
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
              robotId={scopedRobotId}
              onSelectRobot={handleSelectRobot}
              onNavigateToMissions={() => setCurrentPage('missions')}
              onNavigateToLogs={() => setCurrentPage('logs')}
              onNavigateToAlerts={() => setCurrentPage('alerts')}
              onNavigateToImport={() => setCurrentPage('import')}
              refreshTrigger={refreshTrigger}
            />
          )}

          {currentPage === 'route' &&
            (selectedRobotId ? (
              <RoutePlanner
                robotId={selectedRobotId}
                refreshTrigger={refreshTrigger}
              />
            ) : (
              <div className="bg-white rounded-xl border border-[#E4ECE6] p-12 text-center">
                <p className="text-sm font-semibold text-[#25372D] mb-1">
                  Nenhum robô selecionado
                </p>
                <p className="text-xs text-[#78877D]">
                  A rota pertence a um robô. Escolha um na lista "Robôs
                  conectados", na barra lateral.
                </p>
              </div>
            ))}

          {currentPage === 'missions' && (
            <Missions robotId={scopedRobotId} refreshTrigger={refreshTrigger} />
          )}

          {currentPage === 'logs' && (
            <Logs robotId={scopedRobotId} refreshTrigger={refreshTrigger} />
          )}

          {currentPage === 'alerts' && (
            <Alerts robotId={scopedRobotId} refreshTrigger={refreshTrigger} />
          )}

          {currentPage === 'performance' && (
            <Performance robotId={scopedRobotId} refreshTrigger={refreshTrigger} />
          )}

          {currentPage === 'import' && (
            <Import onImportSuccess={() => setRefreshTrigger((prev) => prev + 1)} />
          )}
        </main>
      </div>
    </div>
  );
}
