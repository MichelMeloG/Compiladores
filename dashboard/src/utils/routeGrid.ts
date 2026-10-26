/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GridPoint, RobotGrid, RouteWaypoint } from '../types';

/**
 * Regras da malha de navegação.
 *
 * O robô é um AGV de trilho: anda apenas sobre as linhas da grade, um
 * vértice por vez, em movimento ortogonal. Toda a geometria da tela de
 * rota sai das funções deste arquivo — os componentes só desenham.
 */

/** Chave canônica de um vértice, usada em `Set`/`Map` e na lista manual. */
export function pointKey(p: RouteWaypoint): string {
  return `${p.x},${p.y}`;
}

/** Rótulo exibido ao operador, no mesmo formato da lista manual. */
export function formatPoint(p: RouteWaypoint): string {
  return `(${p.x}, ${p.y})`;
}

/** Interpreta `"2,3"` ou `"(2, 3)"` como vértice. `null` se não for válido. */
export function parsePoint(raw: string): RouteWaypoint | null {
  const match = raw.trim().match(/^\(?\s*(-?\d+)\s*[,;]\s*(-?\d+)\s*\)?$/);
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

export function samePoint(a: RouteWaypoint, b: RouteWaypoint): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Vértices vizinhos na malha estão a exatamente um passo, sem diagonal. */
export function isAdjacent(a: RouteWaypoint, b: RouteWaypoint): boolean {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

export function isInsideGrid(p: RouteWaypoint, grid: RobotGrid): boolean {
  return p.x >= 0 && p.y >= 0 && p.x < grid.cols && p.y < grid.rows;
}

/** Índice dos vértices com característica própria, por chave. */
export function indexGridPoints(grid: RobotGrid): Map<string, GridPoint> {
  const map = new Map<string, GridPoint>();
  for (const point of grid.points ?? []) {
    map.set(pointKey(point), point);
  }
  return map;
}

/** Conjunto de vértices intransitáveis, pronto para consulta. */
export function blockedKeys(grid: RobotGrid): Set<string> {
  const set = new Set<string>();
  for (const point of grid.points ?? []) {
    if (point.kind === 'blocked') set.add(pointKey(point));
  }
  return set;
}

export function isBlocked(p: RouteWaypoint, blocked: Set<string>): boolean {
  return blocked.has(pointKey(p));
}

/**
 * Caminho mais curto entre dois vértices, contornando os bloqueios.
 *
 * Busca em largura: a malha é pequena (dezenas de vértices) e todos os
 * trechos têm o mesmo custo, então não há motivo para algo mais caro.
 *
 * Retorna o trajeto incluindo `from` e `to`, ou `null` quando não há
 * caminho livre entre os dois — caso em que a interface recusa a ligação
 * em vez de inventar um trecho que o robô não consegue percorrer.
 */
export function findPath(
  from: RouteWaypoint,
  to: RouteWaypoint,
  grid: RobotGrid
): RouteWaypoint[] | null {
  if (!isInsideGrid(from, grid) || !isInsideGrid(to, grid)) return null;

  const blocked = blockedKeys(grid);
  if (isBlocked(from, blocked) || isBlocked(to, blocked)) return null;

  if (samePoint(from, to)) return [from];

  const cameFrom = new Map<string, RouteWaypoint | null>();
  cameFrom.set(pointKey(from), null);

  const queue: RouteWaypoint[] = [from];
  const steps: Array<[number, number]> = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];

  while (queue.length > 0) {
    const current = queue.shift() as RouteWaypoint;

    if (samePoint(current, to)) {
      const path: RouteWaypoint[] = [];
      let cursor: RouteWaypoint | null = current;
      while (cursor) {
        path.unshift(cursor);
        cursor = cameFrom.get(pointKey(cursor)) ?? null;
      }
      return path;
    }

    for (const [dx, dy] of steps) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = pointKey(next);

      if (cameFrom.has(key)) continue;
      if (!isInsideGrid(next, grid)) continue;
      if (blocked.has(key)) continue;

      cameFrom.set(key, current);
      queue.push(next);
    }
  }

  return null;
}

/**
 * Acrescenta um vértice ao fim da rota, preenchendo o trajeto até ele.
 *
 * O operador clica em dois pontos distantes — "do ponto A ao ponto B" — e
 * a rota resultante contém todos os vértices intermediários, porque é
 * isso que o robô executa: um passo por vez entre vizinhos.
 *
 * Retorna a rota inalterada quando não existe caminho livre até o destino.
 */
export function appendWaypoint(
  route: RouteWaypoint[],
  target: RouteWaypoint,
  grid: RobotGrid
): { waypoints: RouteWaypoint[]; error: string | null } {
  if (route.length === 0) {
    return { waypoints: [target], error: null };
  }

  const last = route[route.length - 1];
  if (samePoint(last, target)) {
    return { waypoints: route, error: null };
  }

  const path = findPath(last, target, grid);
  if (!path) {
    return {
      waypoints: route,
      error: `Não há trajeto livre de ${formatPoint(last)} até ${formatPoint(
        target
      )}.`,
    };
  }

  // `path` repete o vértice de origem, que já está na rota.
  return { waypoints: [...route, ...path.slice(1)], error: null };
}

/**
 * Remove o vértice de índice `index` e recosta as pontas soltas.
 *
 * Apagar um ponto no meio da lista deixaria dois vértices não adjacentes
 * lado a lado — uma rota que o robô não consegue seguir. Por isso o
 * trecho entre os vizinhos é recalculado.
 */
export function removeWaypoint(
  route: RouteWaypoint[],
  index: number,
  grid: RobotGrid
): { waypoints: RouteWaypoint[]; error: string | null } {
  if (index < 0 || index >= route.length) {
    return { waypoints: route, error: null };
  }

  const before = route.slice(0, index);
  const after = route.slice(index + 1);

  if (before.length === 0 || after.length === 0) {
    return { waypoints: [...before, ...after], error: null };
  }

  const bridge = findPath(before[before.length - 1], after[0], grid);
  if (!bridge) {
    return {
      waypoints: route,
      error:
        'Remover este ponto deixaria a rota sem ligação. Apague os pontos vizinhos primeiro.',
    };
  }

  return {
    waypoints: [...before, ...bridge.slice(1), ...after.slice(1)],
    error: null,
  };
}

/**
 * Substitui o vértice de `index`, religando-o aos vizinhos.
 *
 * É o que acontece quando o operador digita outra coordenada na lista
 * manual: o trecho anterior e o seguinte são refeitos em volta do novo
 * ponto, para a rota continuar percorrível.
 */
export function replaceWaypoint(
  route: RouteWaypoint[],
  index: number,
  target: RouteWaypoint,
  grid: RobotGrid
): { waypoints: RouteWaypoint[]; error: string | null } {
  if (index < 0 || index >= route.length) {
    return { waypoints: route, error: null };
  }
  if (!isInsideGrid(target, grid)) {
    return {
      waypoints: route,
      error: `${formatPoint(target)} está fora da malha.`,
    };
  }
  if (isBlocked(target, blockedKeys(grid))) {
    return {
      waypoints: route,
      error: `${formatPoint(target)} é um ponto bloqueado.`,
    };
  }

  const before = route.slice(0, index);
  const after = route.slice(index + 1);

  let head: RouteWaypoint[] = [target];
  if (before.length > 0) {
    const lead = findPath(before[before.length - 1], target, grid);
    if (!lead) {
      return {
        waypoints: route,
        error: `Não há trajeto livre até ${formatPoint(target)}.`,
      };
    }
    head = [...before, ...lead.slice(1)];
  }

  if (after.length === 0) {
    return { waypoints: head, error: null };
  }

  const tail = findPath(target, after[0], grid);
  if (!tail) {
    return {
      waypoints: route,
      error: `Não há trajeto livre de ${formatPoint(target)} até o ponto seguinte.`,
    };
  }

  return {
    waypoints: [...head, ...tail.slice(1), ...after.slice(1)],
    error: null,
  };
}

/**
 * Confere se a rota é executável: dentro da malha, sem passar por
 * bloqueio e com todos os passos entre vizinhos.
 *
 * Roda antes do envio ao backend — uma rota inválida é recusada aqui,
 * onde o operador ainda pode corrigi-la, e não no robô.
 */
export function validateRoute(
  waypoints: RouteWaypoint[],
  grid: RobotGrid
): string | null {
  if (waypoints.length < 2) {
    return 'A rota precisa de pelo menos um ponto de origem e um de destino.';
  }

  const blocked = blockedKeys(grid);

  for (let i = 0; i < waypoints.length; i++) {
    const point = waypoints[i];

    if (!isInsideGrid(point, grid)) {
      return `O ponto ${formatPoint(point)} está fora da malha.`;
    }
    if (blocked.has(pointKey(point))) {
      return `O ponto ${formatPoint(point)} está bloqueado.`;
    }
    if (i > 0 && !isAdjacent(waypoints[i - 1], point)) {
      return `O passo ${i} salta de ${formatPoint(
        waypoints[i - 1]
      )} para ${formatPoint(point)}, que não são vizinhos na malha.`;
    }
  }

  return null;
}

/**
 * Descreve o trecho entre dois vértices vizinhos em linguagem de operador
 * ("Norte", "Leste"...). Serve só para a leitura da lista na tela — o que
 * vai ao backend é a sequência de pontos.
 */
export function describeStep(from: RouteWaypoint, to: RouteWaypoint): string {
  if (to.y < from.y) return 'Norte';
  if (to.y > from.y) return 'Sul';
  if (to.x > from.x) return 'Leste';
  if (to.x < from.x) return 'Oeste';
  return '—';
}
