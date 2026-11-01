import { describe, expect, it } from 'vitest';
import {
  countRange,
  countRoutes,
  enumerateRoutes,
  isRoute,
  rangesThrough,
  routesThrough,
  solveRoute,
  type CountTerm,
} from '../src/analysis.ts';
import { compileConstraints, type Constraint } from '../src/constraints.ts';
import { generateMap } from '../src/generator.ts';
import { COLS, rowOf, type StsMap } from '../src/map.ts';
import { Rng } from '../src/rng.ts';
import { GRID_ROOMS, Room } from '../src/types.ts';
import { gridRoutes } from './oracle.ts';

const sample = (n: number, options = {}) => Array.from({ length: n }, (_, i) => generateMap(1000 + i, options));

const termCount = (map: StsMap, route: number[], term: CountTerm) => {
  const types: number[] = typeof term.type === 'number' ? [term.type] : [...term.type];
  const from = term.fromRow ?? 1;
  const to = term.toRow ?? map.rooms;
  return route.filter((c) => types.includes(map.type[c]) && rowOf(c) >= from && rowOf(c) <= to).length;
};
const meets = (map: StsMap, route: number[], term: CountTerm) => {
  const n = termCount(map, route, term);
  return n >= (term.min ?? 0) && n <= (term.max ?? Infinity);
};

function randomTerm(rng: Rng, rooms: number): CountTerm {
  const type = GRID_ROOMS[rng.int(GRID_ROOMS.length)];
  const term: CountTerm = { type: rng.int(4) === 0 ? [type, GRID_ROOMS[rng.int(6)]] : type };
  if (rng.int(2)) term.min = rng.int(4);
  if (rng.int(2) || term.min === undefined) term.max = (term.min ?? 0) + rng.int(4);
  if (rng.int(3) === 0) {
    term.fromRow = 1 + rng.int(rooms);
    term.toRow = term.fromRow + rng.int(rooms - term.fromRow + 1);
  }
  return term;
}

describe('route analysis', () => {
  const maps = sample(60).concat(sample(20, { act: 'glory', rules: { prune: false } }));

  it('counts routes', () => {
    for (const map of maps) {
      const routes = gridRoutes(map);
      expect(countRoutes(map)).toBe(routes.length);
      expect(enumerateRoutes(map)).toEqual(routes);
      const through = routesThrough(map);
      for (let cell = COLS; cell < (map.rooms + 1) * COLS; cell++) {
        expect(through[cell]).toBe(routes.filter((r) => r.includes(cell)).length);
      }
    }
  });

  it('finds the fewest and most rooms of a type, overall and through each node', () => {
    const rng = new Rng(5);
    for (const map of maps) {
      const routes = gridRoutes(map);
      for (let k = 0; k < 4; k++) {
        const term = randomTerm(rng, map.rooms);
        const counts = routes.map((r) => termCount(map, r, term));
        expect(countRange(map, term)).toEqual({ min: Math.min(...counts), max: Math.max(...counts) });
        const through = rangesThrough(map, term);
        for (let cell = COLS; cell < (map.rooms + 1) * COLS; cell++) {
          const mine = routes.filter((r) => r.includes(cell)).map((r) => termCount(map, r, term));
          if (mine.length === 0) continue;
          expect([through.min[cell], through.max[cell]]).toEqual([Math.min(...mine), Math.max(...mine)]);
        }
      }
    }
  });

  it('solves for a route meeting several terms, and the best-scoring one', () => {
    const rng = new Rng(9);
    let feasible = 0;
    for (const map of maps) {
      const routes = gridRoutes(map);
      for (let k = 0; k < 6; k++) {
        const terms = Array.from({ length: 1 + rng.int(3) }, () => randomTerm(rng, map.rooms));
        const weights = Array.from({ length: 10 }, () => rng.int(7) - 3);
        const score = (t: Room, row: number) => weights[t] + (row % 3 === 0 ? 1 : 0);
        const valid = routes.filter((r) => terms.every((t) => meets(map, r, t)));
        const solution = solveRoute(map, { terms, score });
        if (valid.length === 0) {
          expect(solution).toBeNull();
          continue;
        }
        feasible++;
        const scoreOf = (r: number[]) => r.reduce((s, c) => s + score(map.type[c] as Room, rowOf(c)), 0);
        expect(solution).not.toBeNull();
        expect(isRoute(map, solution!.route)).toBe(true);
        expect(terms.every((t) => meets(map, solution!.route, t))).toBe(true);
        expect(solution!.score).toBe(Math.max(...valid.map(scoreOf)));
        expect(scoreOf(solution!.route)).toBe(solution!.score);
        const worst = solveRoute(map, { terms, score, minimize: true });
        expect(worst!.score).toBe(Math.min(...valid.map(scoreOf)));
      }
    }
    expect(feasible).toBeGreaterThan(50);
  });

  it('checks routes', () => {
    const map = maps[0];
    const [route] = gridRoutes(map);
    expect(isRoute(map, route)).toBe(true);
    expect(isRoute(map, route.slice(1))).toBe(false);
    const broken = route.slice();
    broken[3] = broken[3] % COLS === 0 ? broken[3] + 2 : broken[3] - 2;
    expect(isRoute(map, broken)).toBe(false);
  });
});

describe('constraints', () => {
  it('agree with brute force', () => {
    const rng = new Rng(21);
    const maps = sample(80, { act: 'hive' });
    let passes = 0;
    for (let k = 0; k < 40; k++) {
      const constraints: Constraint[] = [];
      const pick = rng.int(4);
      if (pick === 0) constraints.push({ kind: 'someRoute', terms: [randomTerm(rng, 14), randomTerm(rng, 14)] });
      if (pick === 1) constraints.push({ kind: 'everyRoute', terms: [randomTerm(rng, 14)] });
      if (pick === 2) {
        const fromRow = rng.int(2) ? 1 + rng.int(7) : undefined;
        constraints.push({ kind: 'rooms', type: Room.Unknown, min: rng.int(10), max: 6 + rng.int(8), fromRow });
      }
      if (pick === 3) constraints.push({ kind: 'routes', min: 20 + rng.int(100) }, { kind: 'nodes', max: 50 + rng.int(10) });
      const predicate = compileConstraints(constraints);
      for (const map of maps) {
        const routes = gridRoutes(map);
        const nodes = routes.length && new Set(routes.flat()).size;
        const expected = constraints.every((c) => {
          switch (c.kind) {
            case 'someRoute':
              return routes.some((r) => c.terms.every((t) => meets(map, r, t)));
            case 'everyRoute':
              return routes.every((r) => c.terms.every((t) => meets(map, r, t)));
            case 'rooms': {
              let n = 0;
              for (let cell = COLS; cell < (map.rooms + 1) * COLS; cell++) {
                if (map.type[cell] === c.type && rowOf(cell) >= (c.fromRow ?? 1) && rowOf(cell) <= (c.toRow ?? map.rooms)) n++;
              }
              return n >= (c.min ?? 0) && n <= (c.max ?? Infinity);
            }
            case 'routes':
              return routes.length >= (c.min ?? 0) && routes.length <= (c.max ?? Infinity);
            case 'nodes':
              return nodes >= (c.min ?? 0) && nodes <= (c.max ?? Infinity);
          }
        });
        expect(predicate(map)).toBe(expected);
        if (expected) passes++;
      }
    }
    expect(passes).toBeGreaterThan(100);
  });
});
