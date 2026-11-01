// Map constraints for the finder: compiled once into a predicate that runs on
// each generated map. Checks run cheapest first, so most maps are rejected
// before any route DP.

import { countRange, countRoutes, RouteSolver, type CountTerm } from './analysis.ts';
import { COLS, type StsMap } from './map.ts';
import { Room } from './types.ts';

export type Constraint =
  /** Some single route meets every term at once. */
  | { kind: 'someRoute'; terms: CountTerm[] }
  /** Every route meets every term. */
  | { kind: 'everyRoute'; terms: CountTerm[] }
  /** Rooms of these types on the whole map (or between two rows, inclusive). */
  | { kind: 'rooms'; type: Room | Room[]; min?: number; max?: number; fromRow?: number; toRow?: number }
  /** Distinct start-to-boss routes. */
  | { kind: 'routes'; min?: number; max?: number }
  /** Nodes on the grid. */
  | { kind: 'nodes'; min?: number; max?: number };

export type MapPredicate = (map: StsMap) => boolean;

const within = (v: number, min = -Infinity, max = Infinity) => v >= min && v <= max;

/** Compile constraints (all must hold) into one predicate. Keep it: it owns scratch buffers. */
export function compileConstraints(constraints: readonly Constraint[]): MapPredicate {
  const checks: { cost: number; test: MapPredicate }[] = [];
  const solver = new RouteSolver();

  for (const c of constraints) {
    switch (c.kind) {
      case 'nodes':
        checks.push({
          cost: 0,
          test: (map) => {
            let n = 0;
            const end = (map.rooms + 1) * COLS;
            for (let cell = COLS; cell < end; cell++) if (map.type[cell] !== Room.Empty) n++;
            return within(n, c.min, c.max);
          },
        });
        break;
      case 'rooms': {
        const mask = typeof c.type === 'number' ? 1 << c.type : c.type.reduce<number>((m, t) => m | (1 << t), 0);
        checks.push({
          cost: 0,
          test: (map) => {
            let n = 0;
            const start = Math.max(1, c.fromRow ?? 1) * COLS;
            const end = (Math.min(map.rooms, c.toRow ?? map.rooms) + 1) * COLS;
            for (let cell = start; cell < end; cell++) if (mask & (1 << map.type[cell])) n++;
            return within(n, c.min, c.max);
          },
        });
        break;
      }
      case 'routes':
        checks.push({ cost: 1, test: (map) => within(countRoutes(map), c.min, c.max) });
        break;
      case 'everyRoute':
        // Every route meets every term ⇔ for each term, the fewest and most on any route are in range.
        for (const term of c.terms) {
          checks.push({
            cost: 1,
            test: (map) => {
              const r = countRange(map, term);
              return r.min >= (term.min ?? 0) && r.max <= (term.max ?? Infinity);
            },
          });
        }
        break;
      case 'someRoute': {
        // One term alone still needs the counter DP: route counts can skip values between min and max.
        const terms = c.terms;
        checks.push({ cost: 2, test: (map) => solver.solve(map, { terms }) !== null });
        break;
      }
    }
  }
  checks.sort((a, b) => a.cost - b.cost);
  const tests = checks.map((c) => c.test);
  return (map) => {
    for (let i = 0; i < tests.length; i++) if (!tests[i](map)) return false;
    return true;
  };
}
