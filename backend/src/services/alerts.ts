import type { EventSeverity } from '@roboflow/contracts';
import type { AlertDoc } from '../domain/types.js';
import { C, type Tx } from '../store/types.js';
import { iso } from './common.js';

export interface AlertInput {
  /** ID determinístico: reentregas e varreduras nunca duplicam. */
  id: string;
  title: string;
  description: string;
  severity: EventSeverity;
  missionId?: string;
  robotId?: string;
  relatedEventIds?: string[];
  /** Se informado, fixa a contagem (idempotente); senão incrementa a cada chamada. */
  occurrenceCount?: number;
}

/**
 * Cria ou atualiza um alerta de forma idempotente.
 * Um alerta já reconhecido não é "reaberto" por reentrega.
 */
export async function upsertAlert(tx: Tx, input: AlertInput, now: Date): Promise<AlertDoc> {
  const prior = await tx.get<AlertDoc>(C.alerts, input.id);
  if (prior) {
    const next: AlertDoc = {
      ...prior,
      description: input.description,
      severity: input.severity,
      timestamp: iso(now),
      occurrenceCount: input.occurrenceCount ?? prior.occurrenceCount + 1,
      relatedEventIds: [...new Set([...prior.relatedEventIds, ...(input.relatedEventIds ?? [])])].slice(-20),
    };
    if (input.occurrenceCount !== undefined && input.occurrenceCount === prior.occurrenceCount) return prior;
    tx.set(C.alerts, next.id, next);
    return next;
  }
  const doc: AlertDoc = {
    id: input.id,
    title: input.title,
    description: input.description,
    severity: input.severity,
    timestamp: iso(now),
    ...(input.missionId ? { missionId: input.missionId } : {}),
    ...(input.robotId ? { robotId: input.robotId } : {}),
    occurrenceCount: input.occurrenceCount ?? 1,
    acknowledged: false,
    relatedEventIds: input.relatedEventIds ?? [],
  };
  tx.create(C.alerts, doc.id, doc);
  return doc;
}
