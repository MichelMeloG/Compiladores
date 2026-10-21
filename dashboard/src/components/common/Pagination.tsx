/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface PaginationProps {
  currentPage: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: number) => void;
  itemName?: string;
}

export const Pagination: React.FC<PaginationProps> = ({
  currentPage,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
  itemName = 'registros',
}) => {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(totalItems, currentPage * pageSize);

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 py-3 px-4 border-t border-[#E4ECE6] bg-white text-xs text-[#78877D]">
      <div className="flex items-center gap-3">
        <span>
          Exibindo{' '}
          <strong className="font-mono tabular-nums text-[#25372D]">
            {startItem}–{endItem}
          </strong>{' '}
          de{' '}
          <strong className="font-mono tabular-nums text-[#25372D]">
            {totalItems}
          </strong>{' '}
          {itemName}
        </span>

        <div className="flex items-center gap-1.5 ml-2">
          <span>Linhas:</span>
          <select
            value={pageSize}
            onChange={(e) => {
              onPageSizeChange(Number(e.target.value));
              onPageChange(1);
            }}
            className="bg-[#F7FAF8] border border-[#E4ECE6] rounded-md px-2 py-1 text-xs font-mono tabular-nums text-[#25372D] focus:outline-none focus:ring-1 focus:ring-[#65B98A]"
          >
            <option value={10}>10</option>
            <option value={25}>25</option>
            <option value={50}>50</option>
          </select>
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onPageChange(currentPage - 1)}
          disabled={currentPage <= 1}
          aria-label="Página anterior"
          className="p-1.5 rounded-md border border-[#E4ECE6] text-[#25372D] hover:bg-[#F7FAF8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>

        <span className="px-3 py-1 font-mono tabular-nums text-[#25372D]">
          Página {currentPage} de {totalPages}
        </span>

        <button
          type="button"
          onClick={() => onPageChange(currentPage + 1)}
          disabled={currentPage >= totalPages}
          aria-label="Próxima página"
          className="p-1.5 rounded-md border border-[#E4ECE6] text-[#25372D] hover:bg-[#F7FAF8] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
