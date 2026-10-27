/**
 * Schemas dos registros INTERNOS do seed (os públicos reutilizam os de
 * `dashboard.ts`). Também descrevem os documentos do Firestore que o backend
 * grava a partir do seed (ver docs/FIRESTORE_MODEL.md).
 */
import { z } from 'zod';
import { HeadingSchema, IdSchema } from './common.js';
import { CapabilitiesSchema, RouteWaypointSchema } from './map.js';
import { MissionStateSchema } from './mission.js';

/** Dispositivo (ESP32) vinculado a um robô. Segredos NÃO ficam aqui. */
export const DeviceRecordSchema = z.object({
  id: IdSchema,
  robotId: IdSchema,
  mapId: IdSchema,
  mapVersion: z.number().int().positive(),
  lastConfirmedHeading: HeadingSchema,
  capabilities: CapabilitiesSchema,
  /** Nome do segredo HMAC no Secret Manager (nunca o valor). */
  secretName: z.string().min(1),
});
export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

/** Modelo de rota cadastrada (dados de apoio; sem endpoint na v1). */
export const RouteTemplateSchema = z.object({
  id: IdSchema,
  version: z.number().int().positive(),
  name: z.string(),
  mapId: IdSchema,
  mapVersion: z.number().int().positive(),
  initialHeading: HeadingSchema,
  waypoints: z.array(RouteWaypointSchema).min(2),
});
export type RouteTemplate = z.infer<typeof RouteTemplateSchema>;

export const MissionStateRecordSchema = z.object({
  missionId: IdSchema,
  robotId: IdSchema,
  deviceId: IdSchema,
  state: MissionStateSchema,
  routeRevision: z.number().int().positive(),
});
export type MissionStateRecord = z.infer<typeof MissionStateRecordSchema>;

export const SeedManifestSchema = z.object({
  seedNow: z.iso.datetime(),
  note: z.string(),
  files: z.array(z.string()),
});
export type SeedManifest = z.infer<typeof SeedManifestSchema>;
