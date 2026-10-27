/**
 * Modelo de mapa (malha ortogonal) e geometria básica.
 *
 * Convenção de coordenadas (ADR 0004): 0-indexadas, origem no canto superior
 * esquerdo, x cresce para a direita (leste) e y cresce para BAIXO (sul).
 *   N = (0,-1)   E = (+1,0)   S = (0,+1)   W = (-1,0)
 */
import { z } from 'zod';
import { IdSchema, type Heading } from './common.js';

export const PointSchema = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});
export type Point = z.infer<typeof PointSchema>;

/** Igual a `RouteWaypoint` do frontend. */
export const RouteWaypointSchema = PointSchema;
export type RouteWaypoint = Point;

/** Igual a `GridPoint` do frontend. */
export const GridPointSchema = PointSchema.extend({
  label: z.string().optional(),
  kind: z.enum(['free', 'station', 'blocked']).optional(),
});
export type GridPoint = z.infer<typeof GridPointSchema>;

/** Resposta de `GET /api/robots/:id/grid` (igual a `RobotGrid` do frontend). */
export const RobotGridSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  points: z.array(GridPointSchema).optional(),
});
export type RobotGrid = z.infer<typeof RobotGridSchema>;

/**
 * Trecho fechado: proíbe o passo `from -> to`. Com `bidirectional: true`
 * (padrão) proíbe também `to -> from`. Sem entradas, toda aresta ortogonal
 * entre vértices livres é permitida.
 */
export const ClosedEdgeSchema = z.object({
  from: PointSchema,
  to: PointSchema,
  bidirectional: z.boolean().default(true),
});
export type ClosedEdge = z.infer<typeof ClosedEdgeSchema>;

/** Mapa versionado e IMUTÁVEL por versão (ver docs/FIRESTORE_MODEL.md). */
export const RobotMapSchema = RobotGridSchema.extend({
  id: IdSchema,
  version: z.number().int().positive(),
  name: z.string().optional(),
  closedEdges: z.array(ClosedEdgeSchema).default([]),
});
export type RobotMap = z.infer<typeof RobotMapSchema>;

export const CapabilitiesSchema = z.object({
  supportsReverse: z.boolean(),
  maxActions: z.number().int().positive(),
  maxMessageBytes: z.number().int().positive(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/** Capacidades do MVP (ver backend/README.md §5.2). */
export const DEFAULT_CAPABILITIES: Capabilities = {
  supportsReverse: false,
  maxActions: 64,
  maxMessageBytes: 4096,
};

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

export const HEADINGS: readonly Heading[] = ['N', 'E', 'S', 'W'];

/** Vetor unitário de cada rumo (y para baixo). */
export const HEADING_DELTA: Record<Heading, { x: number; y: number }> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

/** Identificador canônico de nó: "x,y" (mesmo formato de `Robot.currentPoint`). */
export function nodeId(p: { x: number; y: number }): string {
  return `${p.x},${p.y}`;
}

/** Inverso de `nodeId`; `null` se o texto não for "x,y" com inteiros. */
export function parseNodeId(raw: string): Point | null {
  const m = /^\s*(\d+)\s*,\s*(\d+)\s*$/.exec(raw);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

export function samePoint(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export function isInsideGrid(
  p: { x: number; y: number },
  grid: Pick<RobotGrid, 'cols' | 'rows'>
): boolean {
  return (
    Number.isInteger(p.x) &&
    Number.isInteger(p.y) &&
    p.x >= 0 &&
    p.y >= 0 &&
    p.x < grid.cols &&
    p.y < grid.rows
  );
}

export function isAdjacent(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

/** Rumo do passo entre vizinhos; `null` se não forem vizinhos ortogonais. */
export function headingOfStep(from: Point, to: Point): Heading | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === -1) return 'N';
  if (dx === 1 && dy === 0) return 'E';
  if (dx === 0 && dy === 1) return 'S';
  if (dx === -1 && dy === 0) return 'W';
  return null;
}

/** Gira o rumo em quartos de volta no sentido horário (negativo = anti-horário). */
export function rotateHeading(h: Heading, quarterTurns: number): Heading {
  const i = HEADINGS.indexOf(h);
  return HEADINGS[(((i + quarterTurns) % 4) + 4) % 4] as Heading;
}

export function oppositeHeading(h: Heading): Heading {
  return rotateHeading(h, 2);
}

export function stepFrom(from: Point, heading: Heading): Point {
  const d = HEADING_DELTA[heading];
  return { x: from.x + d.x, y: from.y + d.y };
}

export function blockedSet(map: Pick<RobotGrid, 'points'>): Set<string> {
  const set = new Set<string>();
  for (const p of map.points ?? []) if (p.kind === 'blocked') set.add(nodeId(p));
  return set;
}

export function stepKey(from: Point, to: Point): string {
  return `${nodeId(from)}>${nodeId(to)}`;
}

/** Conjunto de passos dirigidos fechados ("x,y>x,y"). */
export function closedStepSet(map: { closedEdges?: ClosedEdge[] }): Set<string> {
  const set = new Set<string>();
  for (const e of map.closedEdges ?? []) {
    set.add(stepKey(e.from, e.to));
    if (e.bidirectional !== false) set.add(stepKey(e.to, e.from));
  }
  return set;
}
