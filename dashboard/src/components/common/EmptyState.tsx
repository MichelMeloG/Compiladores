/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { LucideIcon, Inbox } from 'lucide-react';

interface EmptyStateProps {
  title: string;
  description: string;
  icon?: LucideIcon;
  actionText?: string;
  onAction?: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  title,
  description,
  icon: Icon = Inbox,
  actionText,
  onAction,
}) => {
  return (
    <div className="flex flex-col items-center justify-center p-12 text-center bg-white rounded-xl border border-[#E4ECE6]">
      <div className="w-12 h-12 rounded-xl bg-[#F0F7F3] text-[#245C43] flex items-center justify-center mb-4">
        <Icon className="w-6 h-6" />
      </div>
      <h3 className="text-base font-semibold text-[#25372D] mb-1">{title}</h3>
      <p className="text-xs text-[#78877D] max-w-md mb-6">{description}</p>
      {actionText && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="px-4 py-2 text-xs font-semibold text-[#245C43] bg-[#BFE8D0] hover:bg-[#aee0c2] rounded-lg transition-colors"
        >
          {actionText}
        </button>
      )}
    </div>
  );
};
