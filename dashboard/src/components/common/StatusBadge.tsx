/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { EventSeverity, MissionStatus } from '../../types';
import { getMissionStatusMeta, getSeverityMeta } from '../../utils/formatters';

interface MissionStatusBadgeProps {
  status: MissionStatus;
}

export const MissionStatusBadge: React.FC<MissionStatusBadgeProps> = ({ status }) => {
  const meta = getMissionStatusMeta(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${meta.badgeClass}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dotClass}`} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
};

interface SeverityBadgeProps {
  severity: EventSeverity;
}

export const SeverityBadge: React.FC<SeverityBadgeProps> = ({ severity }) => {
  const meta = getSeverityMeta(severity);
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium whitespace-nowrap shrink-0 ${meta.badgeClass}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${meta.dotClass}`} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
};
