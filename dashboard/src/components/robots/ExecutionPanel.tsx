import React, { useEffect, useState } from 'react';
import { ActiveRoute, DeviceCommand, DeviceStatus, ExecutionState, MissionState } from '../../types';
import { getActiveRoute } from '../../services/routesService';
import { Control, closeUncertainMission, controlMission, getCommand, getDeviceStatus, getExecution } from '../../services/controlService';
import { toErrorMessage } from '../../services/api';

const states: Record<MissionState, string> = {
  queued: 'Aguardando envio da rota', loading: 'Carregando rota', ready: 'Pronto para iniciar',
  running: 'Executando', blocked: 'Bloqueado', paused: 'Pausado', completed: 'Concluído',
  aborted: 'Cancelado', failed: 'Falha', uncertain: 'Estado incerto: confira o carrinho',
};
const commands = { pending: 'Aguardando confirmação', accepted: 'Confirmado pelo dispositivo',
  rejected: 'Recusado', expired: 'Expirado', uncertain: 'Resultado incerto' };
const buttons: [Control, string][] = [['start', 'Iniciar'], ['stop', 'Parar'], ['resume', 'Retomar'], ['abort', 'Cancelar']];

export const ExecutionPanel: React.FC<{
  robotId: string; refreshTrigger: string; onRoute: (route: ActiveRoute | null) => void;
}> = ({ robotId, refreshTrigger, onRoute }) => {
  const [device, setDevice] = useState<DeviceStatus | null>(null);
  const [execution, setExecution] = useState<ExecutionState | null>(null);
  const [command, setCommand] = useState<DeviceCommand | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [controlError, setControlError] = useState<string | null>(null);
  const [sending, setSending] = useState<Control | null>(null);
  const [fresh, setFresh] = useState(false);
  const [receivedAt, setReceivedAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    setFresh(false);
    const refresh = async () => {
      try {
        const [status, route, result] = await Promise.all([
          getDeviceStatus(robotId), getActiveRoute(robotId), command ? getCommand(command.id) : Promise.resolve(null),
        ]);
        const mission = route?.missionId ? await getExecution(route.missionId) : null;
        if (!mounted) return;
        setDevice(status); setExecution(mission); onRoute(route);
        if (result) setCommand(result);
        setReceivedAt(Date.now()); setFresh(true); setError(null);
      } catch (err) {
        if (mounted) { setError(toErrorMessage(err)); setFresh(false); }
      } finally {
        if (mounted) timer = setTimeout(refresh, 2000);
      }
    };
    void refresh();
    return () => { mounted = false; clearTimeout(timer); };
  }, [robotId, refreshTrigger, reload, command?.id, onRoute]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const online = fresh && now - receivedAt < 10000 && device?.connection === 'online';
  const pendingMotion = execution?.pendingCommands.some(c => c.type === 'start' || c.type === 'resume') || command?.status === 'pending';
  const enabled = (action: Control) => {
    if (!execution || sending) return false;
    if (action === 'abort') return !['completed', 'aborted', 'failed'].includes(execution.state);
    if (action === 'stop') return execution.state === 'running' ||
      execution.pendingCommands.some(c => c.type === 'start' || c.type === 'resume') ||
      (command?.status === 'pending' && ['start', 'resume'].includes(command.type));
    if (!online || pendingMotion) return false;
    return action === 'start' ? execution.state === 'ready' : ['paused', 'blocked'].includes(execution.state);
  };
  const send = async (action: Control) => {
    if (!execution) return;
    setSending(action); setControlError(null);
    try {
      const res = await controlMission(execution, action);
      setCommand({ id: res.commandId, type: action, status: 'pending' });
      setReload(n => n + 1);
    } catch (err) { setControlError(toErrorMessage(err)); }
    finally { setSending(null); }
  };
  const close = async () => {
    if (!execution) return;
    setSending('abort'); setControlError(null);
    try { await closeUncertainMission(execution.missionId); setCommand(null); setReload(n => n + 1); }
    catch (err) { setControlError(toErrorMessage(err)); }
    finally { setSending(null); }
  };
  const age = device?.dataAgeMs == null ? null : device.dataAgeMs + Math.max(0, now - receivedAt);

  return <section className="bg-white rounded-xl border border-[#E4ECE6] p-5 space-y-3" aria-label="Controle do carrinho">
    <h3 className="text-sm font-bold text-[#25372D]">Controle do carrinho</h3>
    <p className="text-xs text-[#78877D]">
      {online ? 'Conectado' : 'Sem confirmação recente de conexão'}
      {age != null && ` · Último contato há ${Math.floor(age / 1000)} s`}
      {' · Sensores E/C/D: '}{device?.sensors?.line?.join(' / ') ?? 'Sem leitura'}
    </p>
    <p className="text-sm text-[#25372D]">{execution
      ? `${online ? '' : 'Último estado registrado: '}${states[execution.state]}` : 'Aguardando uma rota'}</p>
    {execution && <p className="text-xs text-[#78877D]">
      Trechos: {execution.completedActions}/{execution.totalActions}
      {' · Último nó confirmado: '}{execution.lastConfirmedNode ?? 'Desconhecido'}
      {' · Próximo: '}{execution.expectedNode ?? '—'}
      {' · Posição: '}{execution.positionConfidence === 'confirmed' ? 'confirmada na origem' : execution.positionConfidence === 'estimated' ? 'estimada pelos cruzamentos' : 'desconhecida'}
    </p>}
    {!!execution?.blockReasons.length && <p className="text-xs text-amber-800">Bloqueio: {execution.blockReasons.join(', ')}</p>}
    <div className="flex flex-wrap gap-2">
      {buttons.map(([action, label]) => <button key={action} type="button" disabled={!enabled(action)} onClick={() => void send(action)}
        className="px-4 py-2 rounded-lg text-xs font-semibold bg-[#245C43] text-white disabled:opacity-40 disabled:cursor-not-allowed">
        {sending === action ? 'Enviando…' : label}
      </button>)}
    </div>
    <div role="status" className="text-xs text-[#78877D]">
      {command && `${command.id}: ${commands[command.status]}${command.reason ? ` (${command.reason})` : ''}`}
      {!command && execution?.pendingCommands.map(c => `${c.type}: ${commands[c.status]}`).join(' · ')}
    </div>
    <p className="text-xs text-[#78877D]">A parada pela rede depende da conexão e só é confirmada após a resposta do carrinho.</p>
    {execution?.state === 'uncertain' && <div className="text-xs text-amber-800 space-y-2">
      <p>Reinicie o carrinho e confira que ele está parado. Depois encerre esta missão para posicioná-lo e carregar uma nova rota.</p>
      <button type="button" onClick={() => void close()} disabled={!online || !['ready', 'fault'].includes(device?.state ?? '') || !!sending}
        className="px-3 py-2 rounded-lg border border-amber-500 disabled:opacity-40">Encerrar missão incerta (administrador)</button>
    </div>}
    {!execution && device?.state === 'paused' && <p className="text-xs text-amber-800">
      O servidor não tem uma rota para esta execução. Reinicie o carrinho antes de carregar uma nova rota.
    </p>}
    {(controlError || error) && <p role="alert" className="text-xs text-red-700">{controlError || error}</p>}
  </section>;
};
