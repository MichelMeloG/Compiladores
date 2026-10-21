/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { PlugZap, RefreshCw } from 'lucide-react';

interface ErrorStateProps {
  /** Motivo da falha, em linguagem de operador. */
  message: string;
  title?: string;
  onRetry?: () => void;
}

/**
 * Estado exibido quando uma consulta ao servidor falha.
 *
 * Diferente de `EmptyState` (que significa "o servidor respondeu, mas não há
 * registros"), este componente significa "não foi possível obter os dados".
 *
 * Mantenha-o enxuto: o endereço configurado do servidor aparece uma única vez
 * na aplicação, no painel "Origem dos dados" da barra lateral.
 */
export const ErrorState: React.FC<ErrorStateProps> = ({
  message,
  title = 'Não foi possível carregar os dados',
  onRetry,
}) => {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-center bg-white rounded-xl border border-[#E4ECE6]">
      <div className="w-12 h-12 rounded-xl bg-[#FDEDEC] text-[#D96B6B] flex items-center justify-center mb-4">
        <PlugZap className="w-6 h-6" />
      </div>

      <h3 className="text-base font-semibold text-[#25372D] mb-1">{title}</h3>
      <p className="text-xs text-[#78877D] max-w-md mb-6">{message}</p>

      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-[#245C43] bg-[#BFE8D0] hover:bg-[#aee0c2] rounded-lg transition-colors"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>Tentar novamente</span>
        </button>
      )}
    </div>
  );
};
