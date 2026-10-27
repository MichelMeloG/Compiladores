/**
 * Tradução PURA de rota (waypoints) para fila F/T/D/E.
 *
 * Regra (backend/README.md §5): cada comando termina no PRÓXIMO cruzamento.
 *   F  segue em frente           (rumo mantido)
 *   D  gira 90° horário e avança (rumo += 1 quarto)
 *   E  gira 90° anti-horário e avança (rumo -= 1 quarto)
 *   T  ré até o cruzamento atrás (rumo mantido)
 *
 * Sem I/O, sem relógio, sem dependência de Node: roda no navegador, no
 * backend, em testes e no simulador de ESP32.
 */
import { z } from 'zod';
import {
  CommandSchema,
  HeadingSchema,
  type Command,
  type Heading,
} from './common.js';
import {
  DEFAULT_CAPABILITIES,
  PointSchema,
  blockedSet,
  closedStepSet,
  headingOfStep,
  isInsideGrid,
  nodeId,
  oppositeHeading,
  rotateHeading,
  samePoint,
  stepFrom,
  stepKey,
  type Capabilities,
  type ClosedEdge,
  type Point,
  type RobotGrid,
} from './map.js';

// ---------------------------------------------------------------------------
// Erros de rota
// ---------------------------------------------------------------------------

export const RouteErrorCodeSchema = z.enum([
  'ROUTE_TOO_SHORT',
  'NODE_INVALID',
  'NODE_OUT_OF_GRID',
  'NODE_BLOCKED',
  'NODE_REPEATED',
  'STEP_DIAGONAL',
  'STEP_JUMP',
  'EDGE_CLOSED',
  'HEADING_INVALID',
  'REVERSE_UNSUPPORTED',
  'QUEUE_TOO_LONG',
]);
export type RouteErrorCode = z.infer<typeof RouteErrorCodeSchema>;

export const RouteErrorSchema = z.object({
  code: RouteErrorCodeSchema,
  message: z.string(),
  /** Índice do waypoint (ou da ação, para erros de capacidade) envolvido. */
  index: z.number().int().nonnegative().optional(),
});
export type RouteError = z.infer<typeof RouteErrorSchema>;

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export const RouteStepSchema = z.object({
  /** Índice da ação (0-based). Ação i leva waypoint[i] até waypoint[i+1]. */
  index: z.number().int().nonnegative(),
  command: CommandSchema,
  from: PointSchema,
  to: PointSchema,
  fromNode: z.string(),
  toNode: z.string(),
  headingBefore: HeadingSchema,
  headingAfter: HeadingSchema,
});
export type RouteStep = z.infer<typeof RouteStepSchema>;

export const RouteTranslationSchema = z.object({
  executable: z.boolean(),
  errors: z.array(RouteErrorSchema),
  actions: z.array(CommandSchema),
  steps: z.array(RouteStepSchema),
  /** "x,y" de cada waypoint, na ordem. */
  nodeIds: z.array(z.string()),
  /** "x,y" de cada destino (um por ação): vira `expectedNodes` do `load_route`. */
  expectedNodes: z.array(z.string()),
  initialHeading: HeadingSchema.nullable(),
  finalHeading: HeadingSchema.nullable(),
});
export type RouteTranslation = z.infer<typeof RouteTranslationSchema>;

export interface TranslatableMap extends Pick<RobotGrid, 'cols' | 'rows' | 'points'> {
  closedEdges?: ClosedEdge[];
}

/** Comando que realiza a mudança de rumo `heading -> wanted` (ou `null` se ré). */
export function commandFor(heading: Heading, wanted: Heading): Command {
  const diff = (HEADING_INDEX[wanted] - HEADING_INDEX[heading] + 4) % 4;
  switch (diff) {
    case 0:
      return 'F';
    case 1:
      return 'D';
    case 3:
      return 'E';
    default:
      return 'T';
  }
}

const HEADING_INDEX: Record<Heading, number> = { N: 0, E: 1, S: 2, W: 3 };

/** Rumo do chassi depois de executar `command` partindo de `heading`. */
export function headingAfter(heading: Heading, command: Command): Heading {
  if (command === 'D') return rotateHeading(heading, 1);
  if (command === 'E') return rotateHeading(heading, -1);
  return heading;
}

/**
 * Traduz uma lista de waypoints em fila de comandos.
 *
 * Sempre devolve um `RouteTranslation`: `executable=false` quando houver
 * qualquer erro. Os erros geométricos impedem o cálculo das ações; os de
 * capacidade (`T` sem ré, fila longa) ainda trazem as ações para prévia.
 */
export function translateRoute(
  map: TranslatableMap,
  waypoints: ReadonlyArray<{ x: number; y: number }>,
  initialHeading: Heading | string | undefined | null,
  capabilities: Capabilities = DEFAULT_CAPABILITIES
): RouteTranslation {
  const errors: RouteError[] = [];
  const parsedHeading = HeadingSchema.safeParse(initialHeading);
  const heading0: Heading | null = parsedHeading.success ? parsedHeading.data : null;

  if (!parsedHeading.success) {
    errors.push({
      code: 'HEADING_INVALID',
      message: 'Rumo inicial ausente ou inválido. Use N, E, S ou W.',
    });
  }

  if (waypoints.length < 2) {
    errors.push({
      code: 'ROUTE_TOO_SHORT',
      message: 'A rota precisa de pelo menos dois pontos (origem e destino).',
    });
  }

  const blocked = blockedSet(map);
  const closed = closedStepSet(map);
  const geometryErrorsBefore = errors.length;

  waypoints.forEach((p, i) => {
    if (
      !Number.isInteger(p.x) ||
      !Number.isInteger(p.y) ||
      p.x < 0 ||
      p.y < 0
    ) {
      errors.push({
        code: 'NODE_INVALID',
        index: i,
        message: `O ponto ${i} (${p.x}, ${p.y}) não tem coordenadas inteiras não negativas.`,
      });
      return;
    }
    if (!isInsideGrid(p, map)) {
      errors.push({
        code: 'NODE_OUT_OF_GRID',
        index: i,
        message: `O ponto ${i} (${p.x}, ${p.y}) está fora da malha ${map.cols}x${map.rows}.`,
      });
      return;
    }
    if (blocked.has(nodeId(p))) {
      errors.push({
        code: 'NODE_BLOCKED',
        index: i,
        message: `O ponto ${i} (${p.x}, ${p.y}) está bloqueado.`,
      });
    }
  });

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1] as Point;
    const b = waypoints[i] as Point;
    if (!Number.isInteger(a.x + a.y + b.x + b.y)) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;

    if (dx === 0 && dy === 0) {
      errors.push({
        code: 'NODE_REPEATED',
        index: i,
        message: `O ponto ${i} repete o ponto anterior (${b.x}, ${b.y}).`,
      });
    } else if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
      errors.push({
        code: 'STEP_DIAGONAL',
        index: i,
        message: `O passo ${i} é diagonal: (${a.x}, ${a.y}) -> (${b.x}, ${b.y}).`,
      });
    } else if (Math.abs(dx) + Math.abs(dy) !== 1) {
      errors.push({
        code: 'STEP_JUMP',
        index: i,
        message: `O passo ${i} salta de (${a.x}, ${a.y}) para (${b.x}, ${b.y}); inclua os cruzamentos intermediários.`,
      });
    } else if (closed.has(stepKey(a, b))) {
      errors.push({
        code: 'EDGE_CLOSED',
        index: i,
        message: `O trecho (${a.x}, ${a.y}) -> (${b.x}, ${b.y}) está fechado nesse sentido.`,
      });
    }
  }

  const nodeIds = waypoints.map((p) => nodeId(p));
  const geometryOk = errors.length === geometryErrorsBefore && heading0 !== null;

  // Sem geometria válida não há ações a calcular.
  if (!geometryOk || waypoints.length < 2 || heading0 === null) {
    return {
      executable: false,
      errors,
      actions: [],
      steps: [],
      nodeIds,
      expectedNodes: [],
      initialHeading: heading0,
      finalHeading: null,
    };
  }

  const steps: RouteStep[] = [];
  let heading: Heading = heading0;
  for (let i = 1; i < waypoints.length; i++) {
    const from = waypoints[i - 1] as Point;
    const to = waypoints[i] as Point;
    const wanted = headingOfStep(from, to) as Heading;
    const command = commandFor(heading, wanted);
    const after = headingAfter(heading, command);
    steps.push({
      index: i - 1,
      command,
      from: { x: from.x, y: from.y },
      to: { x: to.x, y: to.y },
      fromNode: nodeId(from),
      toNode: nodeId(to),
      headingBefore: heading,
      headingAfter: after,
    });
    heading = after;
  }

  const actions = steps.map((s) => s.command);

  if (!capabilities.supportsReverse) {
    steps.forEach((s) => {
      if (s.command === 'T') {
        errors.push({
          code: 'REVERSE_UNSUPPORTED',
          index: s.index,
          message: `A ação ${s.index} exige marcha à ré (T), que este dispositivo não suporta.`,
        });
      }
    });
  }

  if (actions.length > capabilities.maxActions) {
    errors.push({
      code: 'QUEUE_TOO_LONG',
      message: `A rota gera ${actions.length} ações; o dispositivo aceita no máximo ${capabilities.maxActions}.`,
    });
  }

  return {
    executable: errors.length === 0,
    errors,
    actions,
    steps,
    nodeIds,
    expectedNodes: steps.map((s) => s.toNode),
    initialHeading: heading0,
    finalHeading: heading,
  };
}

// ---------------------------------------------------------------------------
// Simulação e caminho mais curto
// ---------------------------------------------------------------------------

export interface SimulatedState {
  position: Point;
  heading: Heading;
}

/** Aplica um comando a um estado (usado pelo simulador e em testes de ida e volta). */
export function applyCommand(state: SimulatedState, command: Command): SimulatedState {
  if (command === 'T') {
    return {
      position: stepFrom(state.position, oppositeHeading(state.heading)),
      heading: state.heading,
    };
  }
  const heading = headingAfter(state.heading, command);
  return { position: stepFrom(state.position, heading), heading };
}

/** Executa a fila inteira e devolve o percurso de cruzamentos (inclui a origem). */
export function simulateActions(
  start: Point,
  heading: Heading,
  actions: ReadonlyArray<Command>
): { path: Point[]; finalHeading: Heading } {
  let state: SimulatedState = { position: { x: start.x, y: start.y }, heading };
  const path: Point[] = [state.position];
  for (const c of actions) {
    state = applyCommand(state, c);
    path.push(state.position);
  }
  return { path, finalHeading: state.heading };
}

const BFS_STEPS: ReadonlyArray<readonly [number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * Caminho mais curto (BFS) respeitando bloqueios e trechos fechados. A ordem
 * de vizinhos (N, E, S, W) é a mesma de `dashboard/src/utils/routeGrid.ts`,
 * então os empates resolvem igual no front e no back. `null` se não houver.
 */
export function findPath(map: TranslatableMap, from: Point, to: Point): Point[] | null {
  if (!isInsideGrid(from, map) || !isInsideGrid(to, map)) return null;
  const blocked = blockedSet(map);
  const closed = closedStepSet(map);
  if (blocked.has(nodeId(from)) || blocked.has(nodeId(to))) return null;
  if (samePoint(from, to)) return [from];

  const cameFrom = new Map<string, Point | null>([[nodeId(from), null]]);
  const queue: Point[] = [from];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head] as Point;
    if (samePoint(current, to)) {
      const path: Point[] = [];
      let cursor: Point | null = current;
      while (cursor) {
        path.unshift(cursor);
        cursor = cameFrom.get(nodeId(cursor)) ?? null;
      }
      return path;
    }
    for (const [dx, dy] of BFS_STEPS) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = nodeId(next);
      if (cameFrom.has(key) || !isInsideGrid(next, map) || blocked.has(key)) continue;
      if (closed.has(stepKey(current, next))) continue;
      cameFrom.set(key, current);
      queue.push(next);
    }
  }
  return null;
}
