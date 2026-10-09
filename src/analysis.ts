// Route analysis. A route runs from the start through exactly one node per row
// to the boss, and every edge climbs one row, so each question here is a
// dynamic program over rows: linear in the map's edges, never enumerating routes.

import { bossCell, cellCount, COLS, MAX_CELLS, POP3, START, type StsMap } from './map.ts';
import { Room } from './types.ts';

/** Rooms of these types, counted on a route, between two rows (inclusive). */
export interface CountTerm {
  /** One type, or several counted together (e.g. elites and `?`s). */
  type: Room | readonly Room[];
  min?: number;
  max?: number;
  /** First grid row counted (default 1). */
  fromRow?: number;
  /** Last grid row counted (default the top row). */
  toRow?: number;
}

const typeMask = (t: Room | readonly Room[]): number =>
  typeof t === 'number' ? 1 << t : t.reduce<number>((m, x) => m | (1 << x), 0);

/** Number of distinct start-to-boss routes. */
export function countRoutes(map: StsMap): number {
  const ways = new Float64Array(cellCount(map.rooms));
  const { type, up, rooms } = map;
  for (let cell = COLS; cell < 2 * COLS; cell++) if (type[cell] !== Room.Empty) ways[cell] = 1;
  for (let cell = COLS; cell < rooms * COLS; cell++) {
    const w = ways[cell];
    if (w === 0) continue;
    const m = up[cell];
    if (m & 1) ways[cell + 6] += w;
    if (m & 2) ways[cell + 7] += w;
    if (m & 4) ways[cell + 8] += w;
  }
  let total = 0;
  for (let cell = rooms * COLS; cell < (rooms + 1) * COLS; cell++) total += ways[cell];
  return total;
}

/** Routes through each node: (routes from the start to it) × (routes from it to the boss). */
export function routesThrough(map: StsMap): Float64Array {
  const n = cellCount(map.rooms);
  const fwd = new Float64Array(n);
  const bwd = new Float64Array(n);
  const { type, up, rooms } = map;
  for (let cell = COLS; cell < 2 * COLS; cell++) if (type[cell] !== Room.Empty) fwd[cell] = 1;
  for (let cell = COLS; cell < rooms * COLS; cell++) {
    const m = up[cell];
    if (m & 1) fwd[cell + 6] += fwd[cell];
    if (m & 2) fwd[cell + 7] += fwd[cell];
    if (m & 4) fwd[cell + 8] += fwd[cell];
  }
  for (let cell = rooms * COLS; cell < (rooms + 1) * COLS; cell++) if (type[cell] !== Room.Empty) bwd[cell] = 1;
  for (let cell = rooms * COLS - 1; cell >= COLS; cell--) {
    const m = up[cell];
    bwd[cell] = (m & 1 ? bwd[cell + 6] : 0) + (m & 2 ? bwd[cell + 7] : 0) + (m & 4 ? bwd[cell + 8] : 0);
  }
  for (let i = 0; i < n; i++) fwd[i] *= bwd[i];
  fwd[START] = fwd[bossCell(map)] = countRoutes(map);
  return fwd;
}

export interface Range {
  min: number;
  max: number;
}

/** Fewest and most rooms matching `term` (min/max ignored) on any route. */
export function countRange(map: StsMap, term: Omit<CountTerm, 'min' | 'max'>): Range {
  const n = cellCount(map.rooms);
  const lo = new Int8Array(n);
  const hi = new Int8Array(n);
  rangeForward(map, typeMask(term.type), term.fromRow ?? 1, term.toRow ?? map.rooms, lo, hi);
  return finishRange(map, lo, hi);
}

/**
 * For every node, the fewest and most matching rooms on routes through it.
 * The route planner uses this to label nodes ("routes through here meet 1–3 elites").
 */
export function rangesThrough(map: StsMap, term: Omit<CountTerm, 'min' | 'max'>): { min: Int8Array; max: Int8Array } {
  const n = cellCount(map.rooms);
  const mask = typeMask(term.type);
  const from = term.fromRow ?? 1;
  const to = term.toRow ?? map.rooms;
  const flo = new Int8Array(n);
  const fhi = new Int8Array(n);
  rangeForward(map, mask, from, to, flo, fhi);
  // Backward: matches strictly above the node.
  const blo = new Int8Array(n);
  const bhi = new Int8Array(n);
  const { type, up, rooms } = map;
  for (let cell = rooms * COLS - 1; cell >= COLS; cell--) {
    if (type[cell] === Room.Empty) continue;
    const m = up[cell];
    let l = 127;
    let h = -1;
    for (let d = 0; d < 3; d++) {
      if (!(m & (1 << d))) continue;
      const c = cell + 6 + d;
      const row = (c / COLS) | 0;
      const own = row >= from && row <= to && mask & (1 << type[c]) ? 1 : 0;
      if (blo[c] + own < l) l = blo[c] + own;
      if (bhi[c] + own > h) h = bhi[c] + own;
    }
    blo[cell] = l;
    bhi[cell] = h;
  }
  for (let i = 0; i < n; i++) {
    flo[i] += blo[i];
    fhi[i] += bhi[i];
  }
  const total = finishRange(map, flo, fhi);
  flo[START] = flo[bossCell(map)] = total.min;
  fhi[START] = fhi[bossCell(map)] = total.max;
  return { min: flo, max: fhi };
}

function rangeForward(map: StsMap, mask: number, from: number, to: number, lo: Int8Array, hi: Int8Array): void {
  const { type, down, rooms } = map;
  for (let cell = COLS; cell < (rooms + 1) * COLS; cell++) {
    const t = type[cell];
    if (t === Room.Empty) continue;
    const row = (cell / COLS) | 0;
    const own = row >= from && row <= to && mask & (1 << t) ? 1 : 0;
    if (row === 1) {
      lo[cell] = hi[cell] = own;
      continue;
    }
    const m = down[cell];
    let l = 127;
    let h = -1;
    for (let d = 0; d < 3; d++) {
      if (!(m & (1 << d))) continue;
      const p = cell - 8 + d;
      if (lo[p] < l) l = lo[p];
      if (hi[p] > h) h = hi[p];
    }
    lo[cell] = l + own;
    hi[cell] = h + own;
  }
}

function finishRange(map: StsMap, lo: Int8Array, hi: Int8Array): Range {
  let min = 127;
  let max = -1;
  for (let cell = map.rooms * COLS; cell < (map.rooms + 1) * COLS; cell++) {
    if (map.type[cell] === Room.Empty) continue;
    if (lo[cell] < min) min = lo[cell];
    if (hi[cell] > max) max = hi[cell];
  }
  return { min, max };
}

/** A route as its grid cells, row 1 first. */
export type Route = number[];

/** Whether `cells` is a start-to-boss route on this map (one cell per row, along edges). */
export function isRoute(map: StsMap, cells: readonly number[]): boolean {
  if (cells.length !== map.rooms) return false;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (((cell / COLS) | 0) !== i + 1 || map.type[cell] === Room.Empty) return false;
    if (i > 0) {
      const d = (cell % COLS) - (cells[i - 1] % COLS) + 1;
      if (d < 0 || d > 2 || !(map.up[cells[i - 1]] & (1 << d))) return false;
    }
  }
  return true;
}

/** Score of a cell on a route. */
export type CellScore = (type: Room, row: number, cell: number) => number;

export interface SolveOptions {
  /** Every term must hold on the route. */
  terms?: readonly CountTerm[];
  /** Score to maximize (default 0 everywhere: any route that satisfies the terms). */
  score?: CellScore;
  /** Minimize instead of maximize. */
  minimize?: boolean;
}

export interface Solution {
  score: number;
  route: Route;
}

/** Combined state space cap: product over terms of (max+1) or (min+1). */
export const MAX_STATES = 1 << 14;

/**
 * Best route subject to count terms, or null if no route satisfies them.
 *
 * Each term is a counter. A term with a max counts 0..max and drops states
 * that go over; a term with only a min saturates at min. The joint counter
 * state is a mixed-radix number, so the DP keeps the best score per (node,
 * state): the map's few dozen nodes × the state count, times 3 edges.
 */
export class RouteSolver {
  private best = new Float64Array(0);
  private back = new Int32Array(0);
  private stride = new Int32Array(8);
  private radix = new Int32Array(8);
  private capped = new Uint8Array(8);
  private need = new Int32Array(8);
  private dimMask = new Int32Array(8);
  private dimFrom = new Int32Array(8);
  private dimTo = new Int32Array(8);
  private cellDims = new Int32Array(MAX_CELLS);
  private cellScore = new Float64Array(MAX_CELLS);
  private trans: (Int32Array | undefined)[] = [];

  solve(map: StsMap, options: SolveOptions = {}): Solution | null {
    const terms = (options.terms ?? []).filter((t) => t.min !== undefined || t.max !== undefined);
    const dims = terms.length;
    if (dims > 8) throw new Error('At most 8 count terms');
    let states = 1;
    for (let d = 0; d < dims; d++) {
      const t = terms[d];
      const min = t.min ?? 0;
      if (t.max !== undefined && t.max < min) return null;
      this.capped[d] = t.max !== undefined ? 1 : 0;
      this.radix[d] = t.max !== undefined ? t.max + 1 : min + 1;
      this.need[d] = min;
      this.stride[d] = states;
      this.dimMask[d] = typeMask(t.type);
      this.dimFrom[d] = t.fromRow ?? 1;
      this.dimTo[d] = t.toRow ?? map.rooms;
      states *= this.radix[d];
      if (states > MAX_STATES) throw new Error(`Terms need ${states}+ counter states (limit ${MAX_STATES})`);
    }
    this.trans = new Array(1 << dims);

    const { rooms, type, down } = map;
    const sign = options.minimize ? -1 : 1;
    const score = options.score;
    const top = (rooms + 1) * COLS;
    for (let cell = COLS; cell < top; cell++) {
      const t = type[cell];
      if (t === Room.Empty) continue;
      const row = (cell / COLS) | 0;
      let dm = 0;
      for (let d = 0; d < dims; d++) {
        if (this.dimMask[d] & (1 << t) && row >= this.dimFrom[d] && row <= this.dimTo[d]) dm |= 1 << d;
      }
      this.cellDims[cell] = dm;
      this.cellScore[cell] = score ? sign * score(t as Room, row, cell) : 0;
    }

    const size = cellCount(rooms) * states;
    if (this.best.length < size) {
      this.best = new Float64Array(size);
      this.back = new Int32Array(size);
    }
    const { best, back } = this;
    best.fill(-Infinity, 0, size);

    for (let cell = COLS; cell < top; cell++) {
      if (type[cell] === Room.Empty) continue;
      const tr = this.transition(this.cellDims[cell], states, dims);
      const own = this.cellScore[cell];
      const base = cell * states;
      if (cell < 2 * COLS) {
        const s = tr ? tr[0] : 0;
        if (s >= 0) {
          best[base + s] = own;
          back[base + s] = -1;
        }
        continue;
      }
      const m = down[cell];
      for (let d = 0; d < 3; d++) {
        if (!(m & (1 << d))) continue;
        const p = cell - 8 + d;
        const pbase = p * states;
        for (let s = 0; s < states; s++) {
          const v = best[pbase + s];
          if (v === -Infinity) continue;
          const ns = tr ? tr[s] : s;
          if (ns < 0) continue;
          const nv = v + own;
          if (nv > best[base + ns]) {
            best[base + ns] = nv;
            back[base + ns] = pbase + s;
          }
        }
      }
    }

    let bestValue = -Infinity;
    let bestIndex = -1;
    for (let cell = rooms * COLS; cell < top; cell++) {
      if (type[cell] === Room.Empty) continue;
      const base = cell * states;
      for (let s = 0; s < states; s++) {
        const v = best[base + s];
        if (v > bestValue && this.accepts(s, dims)) {
          bestValue = v;
          bestIndex = base + s;
        }
      }
    }
    if (bestIndex < 0) return null;
    const route: Route = new Array(rooms);
    for (let i = bestIndex, r = rooms - 1; i >= 0; i = back[i], r--) route[r] = (i / states) | 0;
    return { score: sign * bestValue + 0, route };
  }

  private accepts(s: number, dims: number): boolean {
    for (let d = 0; d < dims; d++) {
      const digit = ((s / this.stride[d]) | 0) % this.radix[d];
      if (digit < this.need[d]) return false;
    }
    return true;
  }

  /** State → state after counting a node in the dims of `dm` (-1: over a max). Null for no dims. */
  private transition(dm: number, states: number, dims: number): Int32Array | null {
    if (dm === 0) return null;
    let tr = this.trans[dm];
    if (tr) return tr;
    tr = new Int32Array(states);
    for (let s = 0; s < states; s++) {
      let ns = s;
      for (let d = 0; d < dims && ns >= 0; d++) {
        if (!(dm & (1 << d))) continue;
        const digit = ((s / this.stride[d]) | 0) % this.radix[d];
        if (digit + 1 < this.radix[d]) ns += this.stride[d];
        else if (this.capped[d]) ns = -1;
      }
      tr[s] = ns;
    }
    this.trans[dm] = tr;
    return tr;
  }
}

let sharedSolver: RouteSolver | null = null;

/** Best route under `options`, or null if no route satisfies the terms. */
export function solveRoute(map: StsMap, options?: SolveOptions): Solution | null {
  sharedSolver ??= new RouteSolver();
  return sharedSolver.solve(map, options);
}

/** Every route, row 1 first. Exponential: for tests and tiny maps only. */
export function enumerateRoutes(map: StsMap, limit = 100_000): Route[] {
  const out: Route[] = [];
  const path: number[] = [];
  const walk = (cell: number) => {
    if (out.length >= limit) return;
    path.push(cell);
    const row = (cell / COLS) | 0;
    if (row === map.rooms) out.push(path.slice());
    else {
      const m = map.up[cell];
      for (let d = 0; d < 3; d++) if (m & (1 << d)) walk(cell + 6 + d);
    }
    path.pop();
  };
  for (let cell = COLS; cell < 2 * COLS; cell++) if (map.type[cell] !== Room.Empty) walk(cell);
  return out;
}

/** Number of edges in the grid (row 1 to the top), for stats. */
export function edgeCount(map: StsMap): number {
  let n = 0;
  for (let cell = COLS; cell < map.rooms * COLS; cell++) n += POP3[map.up[cell]];
  return n;
}
