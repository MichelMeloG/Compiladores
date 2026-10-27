import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CAPABILITIES,
  HEADINGS,
  commandFor,
  findPath,
  simulateActions,
  translateRoute,
  type Command,
  type Heading,
} from '../src/index.js';

const map = {
  cols: 5,
  rows: 4,
  points: [{ x: 2, y: 2, kind: 'blocked' as const }],
  closedEdges: [{ from: { x: 3, y: 0 }, to: { x: 4, y: 0 }, bidirectional: false }],
};

const free = { cols: 5, rows: 4 };

describe('translateRoute — eixo y para baixo (ADR 0004)', () => {
  // Rota em L: (0,0) -> (0,1) -> (1,1) -> (1,0)
  const L = [
    { x: 0, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
    { x: 1, y: 0 },
  ];

  it('iniciando em S: F, E (esquerda), E (esquerda)', () => {
    // virado para baixo (S): ir para a direita da tela (E) é virar à ESQUERDA
    const r = translateRoute(free, L, 'S');
    expect(r.errors).toEqual([]);
    expect(r.actions).toEqual(['F', 'E', 'E']);
    expect(r.finalHeading).toBe('N');
    expect(r.expectedNodes).toEqual(['0,1', '1,1', '1,0']);
    expect(r.nodeIds).toEqual(['0,0', '0,1', '1,1', '1,0']);
  });

  it('iniciando em N: o primeiro trecho exige ré (T); sem suporte vira erro de capacidade, com as ações para a prévia', () => {
    const r = translateRoute(free, L, 'N');
    expect(r.actions).toEqual(['T', 'D', 'E']);
    expect(r.executable).toBe(false);
    expect(r.errors.map((e) => e.code)).toEqual(['REVERSE_UNSUPPORTED']);
    expect(r.errors[0]?.index).toBe(0);
  });

  it('com supportsReverse a mesma rota é executável', () => {
    const r = translateRoute(free, L, 'N', { ...DEFAULT_CAPABILITIES, supportsReverse: true });
    expect(r.executable).toBe(true);
    expect(r.actions).toEqual(['T', 'D', 'E']);
  });

  it('iniciando em E: (0,0)->(0,1) ao sul vira à direita (D)', () => {
    const r = translateRoute(free, L, 'E');
    expect(r.actions).toEqual(['D', 'E', 'E']);
    expect(r.executable).toBe(true);
  });

  it('iniciando em W: (0,1) ao sul exige girar à esquerda (E)', () => {
    const r = translateRoute(free, L, 'W');
    // W -> S é anti-horário (E), S -> E é anti-horário (E), E -> N é anti-horário (E)
    expect(r.actions).toEqual(['E', 'E', 'E']);
    expect(r.finalHeading).toBe('N');
  });

  it('exemplo do README em y para baixo: quatro pontos geram três ações', () => {
    const r = translateRoute(
      free,
      [
        { x: 0, y: 3 },
        { x: 0, y: 2 },
        { x: 1, y: 2 },
        { x: 1, y: 1 },
      ],
      'N'
    );
    expect(r.actions).toEqual(['F', 'D', 'E']);
    expect(r.steps.map((s) => [s.headingBefore, s.headingAfter])).toEqual([
      ['N', 'N'],
      ['N', 'E'],
      ['E', 'N'],
    ]);
  });

  it('T mantém o rumo e D/E giram 90°', () => {
    const r = translateRoute(
      free,
      [
        { x: 1, y: 1 },
        { x: 1, y: 2 },
      ],
      'N',
      { ...DEFAULT_CAPABILITIES, supportsReverse: true }
    );
    expect(r.actions).toEqual(['T']);
    expect(r.finalHeading).toBe('N');
  });

  it('é determinística nas quatro orientações para a mesma geometria', () => {
    const straight = [
      { x: 1, y: 1 },
      { x: 2, y: 1 },
    ];
    const expected: Record<Heading, Command> = { E: 'F', S: 'E', W: 'T', N: 'D' };
    for (const h of HEADINGS) {
      const r = translateRoute(free, straight, h, { ...DEFAULT_CAPABILITIES, supportsReverse: true });
      expect(r.actions, `rumo ${h}`).toEqual([expected[h]]);
    }
  });

  it('ida e volta: simular as ações reproduz os waypoints', () => {
    const route = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 1 },
    ];
    for (const h of ['N', 'E', 'S', 'W'] as Heading[]) {
      const r = translateRoute(free, route, h, { ...DEFAULT_CAPABILITIES, supportsReverse: true });
      const sim = simulateActions(route[0]!, h, r.actions);
      expect(sim.path, `rumo ${h}`).toEqual(route);
      expect(sim.finalHeading).toBe(r.finalHeading);
    }
  });
});

describe('translateRoute — validações (backend/README.md §5.2)', () => {
  const codes = (w: Array<{ x: number; y: number }>, ...rest: [string?]) =>
    translateRoute(map, w, rest.length ? rest[0] : 'N').errors.map((e) => e.code);

  it('rota sem deslocamento', () => {
    expect(codes([{ x: 0, y: 0 }])).toContain('ROUTE_TOO_SHORT');
    expect(codes([])).toContain('ROUTE_TOO_SHORT');
  });

  it('nó fora da malha', () => {
    expect(codes([{ x: 0, y: 0 }, { x: 5, y: 0 }])).toContain('NODE_OUT_OF_GRID');
    expect(codes([{ x: 0, y: 3 }, { x: 0, y: 4 }])).toContain('NODE_OUT_OF_GRID');
  });

  it('coordenada negativa ou fracionária', () => {
    expect(codes([{ x: 0, y: 0 }, { x: -1, y: 0 }])).toContain('NODE_INVALID');
    expect(codes([{ x: 0, y: 0 }, { x: 0.5, y: 0 }])).toContain('NODE_INVALID');
  });

  it('nó bloqueado', () => {
    expect(codes([{ x: 2, y: 1 }, { x: 2, y: 2 }])).toContain('NODE_BLOCKED');
  });

  it('ponto repetido consecutivo', () => {
    expect(codes([{ x: 0, y: 0 }, { x: 0, y: 0 }])).toContain('NODE_REPEATED');
  });

  it('diagonal', () => {
    expect(codes([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toContain('STEP_DIAGONAL');
  });

  it('salto sobre cruzamento intermediário', () => {
    const r = translateRoute(map, [{ x: 0, y: 0 }, { x: 0, y: 2 }], 'S');
    expect(r.errors.map((e) => e.code)).toEqual(['STEP_JUMP']);
    expect(r.errors[0]?.index).toBe(1);
    expect(r.executable).toBe(false);
    expect(r.actions).toEqual([]);
  });

  it('aresta ausente (trecho fechado) só no sentido proibido', () => {
    expect(codes([{ x: 3, y: 0 }, { x: 4, y: 0 }])).toContain('EDGE_CLOSED');
    expect(codes([{ x: 4, y: 0 }, { x: 3, y: 0 }], 'W')).not.toContain('EDGE_CLOSED');
  });

  it('rumo inicial ausente ou inválido', () => {
    expect(codes([{ x: 0, y: 0 }, { x: 1, y: 0 }], undefined)).toContain('HEADING_INVALID');
    expect(codes([{ x: 0, y: 0 }, { x: 1, y: 0 }], 'X')).toContain('HEADING_INVALID');
  });

  it('T sem supportsReverse', () => {
    const r = translateRoute(map, [{ x: 1, y: 1 }, { x: 1, y: 2 }], 'N');
    expect(r.errors.map((e) => e.code)).toEqual(['REVERSE_UNSUPPORTED']);
  });

  it('fila acima de maxActions', () => {
    const wide = { cols: 100, rows: 1 };
    const w = Array.from({ length: 66 }, (_, i) => ({ x: i, y: 0 }));
    const r = translateRoute(wide, w, 'E');
    expect(r.actions).toHaveLength(65);
    expect(r.errors.map((e) => e.code)).toEqual(['QUEUE_TOO_LONG']);
    const ok = translateRoute(wide, w.slice(0, 65), 'E');
    expect(ok.executable).toBe(true);
    expect(ok.actions).toHaveLength(64);
  });

  it('acumula vários erros na mesma rota', () => {
    const r = translateRoute(map, [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 9, y: 9 }], 'N');
    const c = r.errors.map((e) => e.code);
    expect(c).toContain('NODE_REPEATED');
    expect(c).toContain('STEP_DIAGONAL');
    expect(c).toContain('NODE_OUT_OF_GRID');
  });
});

describe('commandFor / findPath', () => {
  it('commandFor cobre os quatro quartos', () => {
    expect(commandFor('N', 'N')).toBe('F');
    expect(commandFor('N', 'E')).toBe('D');
    expect(commandFor('N', 'W')).toBe('E');
    expect(commandFor('N', 'S')).toBe('T');
  });

  it('findPath contorna bloqueio e respeita trecho fechado', () => {
    const p = findPath(map, { x: 2, y: 1 }, { x: 2, y: 3 });
    expect(p).not.toBeNull();
    expect(p!.some((q) => q.x === 2 && q.y === 2)).toBe(false);
    const p2 = findPath(map, { x: 3, y: 0 }, { x: 4, y: 0 });
    expect(p2!.length).toBeGreaterThan(2); // não pode ir direto
  });

  it('findPath devolve null sem caminho ou fora da malha', () => {
    const walled = {
      cols: 3,
      rows: 1,
      points: [{ x: 1, y: 0, kind: 'blocked' as const }],
    };
    expect(findPath(walled, { x: 0, y: 0 }, { x: 2, y: 0 })).toBeNull();
    expect(findPath(free, { x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull();
  });

  it('o BFS usa a mesma ordem N,E,S,W do front (empates iguais)', () => {
    const p = findPath(free, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(p).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
  });
});
