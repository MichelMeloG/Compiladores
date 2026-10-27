/**
 * Registro nominal de schemas: liga o nome usado nas fixtures e no runner ao
 * schema zod. Nomes: `<endpointId>.request`, `<endpointId>.response`,
 * `<endpointId>.query` e `device.<tipo>` / `command.<tipo>`.
 */
import type { z } from 'zod';
import { ENDPOINTS, type Endpoint } from './api.js';
import { ErrorEnvelopeSchema } from './common.js';
import {
  AbortCommandSchema,
  ActionCompletedMessageSchema,
  ActionStartedMessageSchema,
  AckMessageSchema,
  BlockClearedMessageSchema,
  BlockStartedMessageSchema,
  FaultMessageSchema,
  HelloMessageSchema,
  LoadRouteCommandSchema,
  MissionCompletedMessageSchema,
  RejectMessageSchema,
  ResumeCommandSchema,
  SnapshotMessageSchema,
  StartCommandSchema,
  StopCommandSchema,
  TelemetryMessageSchema,
  DeviceEventMessageSchema,
  DeviceCommandMessageSchema,
  InternalEventEnvelopeSchema,
} from './device.js';
import { LogEventSchema } from './dashboard.js';
import { RobotMapSchema } from './map.js';

const entries: Array<[string, z.ZodType]> = [
  ['error', ErrorEnvelopeSchema],
  ['logEvent', LogEventSchema],
  ['map', RobotMapSchema],
  ['device.hello', HelloMessageSchema],
  ['device.ack', AckMessageSchema],
  ['device.reject', RejectMessageSchema],
  ['device.telemetry', TelemetryMessageSchema],
  ['device.action_started', ActionStartedMessageSchema],
  ['device.action_completed', ActionCompletedMessageSchema],
  ['device.mission_completed', MissionCompletedMessageSchema],
  ['device.block_started', BlockStartedMessageSchema],
  ['device.block_cleared', BlockClearedMessageSchema],
  ['device.fault', FaultMessageSchema],
  ['device.snapshot', SnapshotMessageSchema],
  ['device.event', DeviceEventMessageSchema],
  ['command.load_route', LoadRouteCommandSchema],
  ['command.start', StartCommandSchema],
  ['command.stop', StopCommandSchema],
  ['command.resume', ResumeCommandSchema],
  ['command.abort', AbortCommandSchema],
  ['command.any', DeviceCommandMessageSchema],
  ['internal.event', InternalEventEnvelopeSchema],
];

for (const e of ENDPOINTS as readonly Endpoint[]) {
  if (e.query) entries.push([`${e.id}.query`, e.query]);
  if (e.body) entries.push([`${e.id}.request`, e.body]);
  entries.push([`${e.id}.response`, e.response]);
}

export const SCHEMA_REGISTRY: ReadonlyMap<string, z.ZodType> = new Map(entries);

export function schemaFor(name: string): z.ZodType {
  const s = SCHEMA_REGISTRY.get(name);
  if (!s) throw new Error(`Schema não registrado: ${name}`);
  return s;
}
