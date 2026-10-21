/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, Copy, Check, Terminal, Cpu } from 'lucide-react';
import { LogEvent } from '../../types';
import { formatDateTime, getEventTypeLabel, getRoverStateLabel } from '../../utils/formatters';
import { SeverityBadge } from '../common/StatusBadge';

interface LogDetailModalProps {
  event: LogEvent | null;
  onClose: () => void;
}

export const LogDetailModal: React.FC<LogDetailModalProps> = ({ event, onClose }) => {
  const [copied, setCopied] = useState(false);

  if (!event) return null;

  const handleCopyJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/40 backdrop-blur-xs">
      <div className="relative w-full max-w-2xl max-h-[90vh] bg-white rounded-2xl shadow-xl border border-[#E4ECE6] flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#E4ECE6] bg-[#F7FAF8]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-[#245C43] text-white flex items-center justify-center">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold font-mono text-[#25372D]">
                Detalhes do Registro #{event.id}
              </h2>
              <p className="text-[11px] text-[#78877D] font-mono tabular-nums">
                {formatDateTime(event.timestamp)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-[#78877D] hover:text-[#25372D] hover:bg-white transition-colors"
            aria-label="Fechar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Key fields */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="p-3 bg-[#F7FAF8] rounded-lg border border-[#E4ECE6]">
              <span className="text-[11px] font-semibold text-[#78877D] block mb-1">
                Severidade
              </span>
              <SeverityBadge severity={event.severity} />
            </div>

            <div className="p-3 bg-[#F7FAF8] rounded-lg border border-[#E4ECE6]">
              <span className="text-[11px] font-semibold text-[#78877D] block mb-1">
                Missão Vinculada
              </span>
              <span className="text-xs font-mono font-bold text-[#245C43]">
                {event.missionId || 'Nenhuma'}
              </span>
            </div>

            <div className="p-3 bg-[#F7FAF8] rounded-lg border border-[#E4ECE6]">
              <span className="text-[11px] font-semibold text-[#78877D] block mb-1">
                Tipo do Evento
              </span>
              <span className="text-xs font-medium text-[#25372D]">
                {getEventTypeLabel(event.eventType)}
              </span>
            </div>

            <div className="p-3 bg-[#F7FAF8] rounded-lg border border-[#E4ECE6]">
              <span className="text-[11px] font-semibold text-[#78877D] block mb-1">
                Comando
              </span>
              <span className="text-xs font-mono font-semibold text-[#25372D]">
                {event.command || 'Nenhum'}
              </span>
            </div>

            <div className="p-3 bg-[#F7FAF8] rounded-lg border border-[#E4ECE6] col-span-2 sm:col-span-2">
              <span className="text-[11px] font-semibold text-[#78877D] block mb-1">
                Estado do Carrinho
              </span>
              <div className="flex items-center gap-1.5 text-xs text-[#25372D]">
                <Cpu className="w-3.5 h-3.5 text-[#245C43]" />
                <span>{getRoverStateLabel(event.roverState)}</span>
              </div>
            </div>
          </div>

          {/* Description */}
          <div className="p-4 bg-white rounded-xl border border-[#E4ECE6]">
            <span className="text-xs font-semibold text-[#78877D] uppercase tracking-wider block mb-1.5">
              Mensagem Registrada
            </span>
            <p className="text-sm text-[#25372D] leading-relaxed">
              {event.message}
            </p>
          </div>

          {/* Raw JSON viewer */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#78877D] uppercase tracking-wider">
                Estrutura JSON Normalizada
              </span>

              <button
                type="button"
                onClick={handleCopyJson}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-[#245C43] hover:bg-[#F0F7F3] rounded-md transition-colors"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-[#4AAB79]" />
                    <span className="text-[#4AAB79]">Copiado!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copiar JSON</span>
                  </>
                )}
              </button>
            </div>

            <pre className="p-4 bg-[#1E293B] text-[#E2E8F0] rounded-xl text-xs font-mono overflow-x-auto max-h-60 leading-relaxed">
              {JSON.stringify(event, null, 2)}
            </pre>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-[#E4ECE6] bg-[#F7FAF8] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-[#25372D] hover:bg-[#E4ECE6] rounded-lg transition-colors"
          >
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
};
