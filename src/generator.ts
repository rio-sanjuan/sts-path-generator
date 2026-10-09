// Slay the Spire II's act map generator (`StandardActMap`), step for step:
//
//   1. deal room-type quotas         (rests, `?`s, elites, shops)
//   2. carve 7 random paths          (bottom to top, steps of one column, no crossings)
//   3. assign room types             (fixed rows, then the quota queue under placement rules)
//   4. prune duplicate branches      (two routes fork→merge with the same rooms), repair quotas
//   5. lay out the drawing           (center, spread, straighten; columns only)
//
// Faithful to the game's rules and distributions, not to its seeds (see rng.ts).
// Everything works on flat typed arrays owned by the generator and reused for
// every map, so generating allocates nothing unless a trace is requested.

import { actStreamSeed, Rng, seedValue } from './rng.ts';
import { resolveConfig, type GenConfig } from './config.ts';
import { cellCount, COLS, createMap, MAX_CELLS, MAX_ROOMS, POP3, START, START_COL, type StsMap } from './map.ts';
import { Room, type GenerateOptions, type Quotas } from './types.ts';

export type Phase = 'carve' | 'assign' | 'prune' | 'layout';

/** What the generator did, step by step, for animating it. Cells are pre-layout until the layout phase. */
export type TraceEvent =
  | { kind: 'quotas'; quotas: Quotas }
  | { kind: 'path'; index: number; designed: boolean; cells: number[] }
  | { kind: 'fixed'; type: Room; cells: number[] }
  | { kind: 'pin'; cell: number; type: Room }
  | { kind: 'assign'; cell: number; type: Room; pass: number }
  | { kind: 'fill'; cells: number[] }
  /** A group of duplicate routes, in the (shuffled) order pruning tries them. */
  | { kind: 'duplicates'; routes: number[][] }
  | { kind: 'remove'; cell: number }
  | { kind: 'cut'; from: number; to: number }
  | { kind: 'repair'; cell: number; type: Room }
  | { kind: 'move'; step: 'center' | 'spread' | 'straighten'; row: number; from: number; to: number }
  /** The whole map at the end of a phase. */
  | { kind: 'phase'; phase: Phase; map: StsMap };

const ROW_OF = new Uint8Array(MAX_CELLS);
for (let i = 0; i < MAX_CELLS; i++) ROW_OF[i] = (i / COLS) | 0;

/** The six orders of the steps {-1, 0, +1}; one draw picks one uniformly. */
const STEP_ORDERS = new Int8Array([-1, 0, 1, -1, 1, 0, 0, -1, 1, 0, 1, -1, 1, -1, 0, 1, 0, -1]);

const { Monster, Elite, Rest, Shop, Treasure, Unknown, Ancient, Boss, Unassigned } = Room;

/** A route holds at most every row plus the start and boss. */
const ROUTE_STRIDE = MAX_ROOMS + 2;
/** Members kept per duplicate group. A fork has at most 7 children (the start), so at most 7 disjoint routes. */
const MAX_MEMBERS = 8;
/** The game gives up (throws) after this many prune iterations; we just stop. */
const MAX_PRUNE_ITERATIONS = 50;

/** Hash slot for an integer-valued float key (< 2^53). */
function slot(key: number, mask: number): number {
  const h = Math.imul((key >>> 0) ^ Math.imul((key / 4294967296) | 0, 0x9e3779b1), 0x85ebca6b);
  return (h ^ (h >>> 15)) & mask;
}

function grown<T extends Int16Array | Int32Array | Float64Array>(from: T, to: T): T {
  to.set(from);
  return to;
}

function compareRoutes(routes: Int16Array, a: number, b: number, len: number): number {
  for (let i = 0; i < len; i++) {
    const d = routes[a + i] - routes[b + i];
    if (d !== 0) return d;
  }
  return 0;
}

export class MapGenerator {
  private readonly rng = new Rng();
  private cfg!: GenConfig;
  private rooms = 0;
  private boss = 0;
  private trace: TraceEvent[] | null = null;
  private quotas: Quotas = { rests: 0, shops: 0, elites: 0, unknowns: 0 };
  /** What repair aims for: the quotas, or the STS1-style counts. */
  private targets: Quotas = { rests: 0, shops: 0, elites: 0, unknowns: 0 };

  // The working map.
  private readonly type = new Uint8Array(MAX_CELLS);
  private readonly up = new Uint8Array(MAX_CELLS);
  private readonly down = new Uint8Array(MAX_CELLS);
  /** Type can't change (fixed rows and pins): the game's `CanBeModified = false`. */
  private readonly fixed = new Uint8Array(MAX_CELLS);
  /** Never pruned (designed paths and pins). */
  private readonly keep = new Uint8Array(MAX_CELLS);
  /** Up-edges that are never cut (designed paths). */
  private readonly lockedUp = new Uint8Array(MAX_CELLS);

  // Scratch.
  private readonly list = new Int16Array(MAX_CELLS);
  private readonly queue = new Uint8Array(128);
  private readonly queueTmp = new Uint8Array(128);
  private qlen = 0;
  private readonly validCache = new Int8Array(16);
  /** bit 1: reachable from the start; bit 2: reaches the boss. */
  private readonly reach = new Uint8Array(MAX_CELLS);
  /** The boss's parents (top-row nodes), as of the last computeReach. */
  private bossParents = 0;

  // Duplicate-route search (see forkPrune).
  /** Routes out of the fork as a trie (cell + parent), so a route is one index and extending it is O(1). */
  private trieCell = new Int16Array(4096);
  private trieParent = new Int32Array(4096);
  private trieN = 0;
  /** The frontier: trie node, inner room types so far (base-6 digits), and the fork's child it left by. */
  private curTrie = new Int32Array(256);
  private curSeq = new Float64Array(256);
  private curFirst = new Int16Array(256);
  private nxtTrie = new Int32Array(256);
  private nxtSeq = new Float64Array(256);
  private nxtFirst = new Int16Array(256);
  private nxtN = 0;
  private sortIdx = new Int32Array(256);
  private keepFlag = new Uint8Array(256);
  /** Routes reaching a merge on this row: key (merge, inner types), branch, trie node. */
  private candKey = new Float64Array(256);
  private candFirst = new Int16Array(256);
  private candTrie = new Int32Array(256);
  private candNext = new Int32Array(256);
  private candN = 0;
  /** Candidates grouped by key, in a hash table cleared by bumping a stamp. */
  private htKey = new Float64Array(512);
  private htGroup = new Int32Array(512);
  private htStamp = new Uint32Array(512);
  private htMask = 511;
  private stamp = 0;
  private grpHead = new Int32Array(256);
  private grpTail = new Int32Array(256);
  private grpCount = new Int32Array(256);
  private grpFirst = new Int16Array(256);
  private grpMulti = new Uint8Array(256);
  private grpN = 0;
  /** A group's routes, unsorted, before choosing members. */
  private entRoutes = new Int16Array(64 * ROUTE_STRIDE);
  private entOrder = new Int32Array(64);
  /** The chosen members of the group being pruned. */
  private readonly routes = new Int16Array(MAX_MEMBERS * ROUTE_STRIDE);
  private readonly order = new Int32Array(MAX_MEMBERS);
  /** Prune iterations the last map took (each finds and removes one duplicate group). */
  pruneIterations = 0;

  // Layout.
  private readonly lcol = new Int8Array(MAX_CELLS);
  private readonly occ = new Int16Array(MAX_CELLS);
  private readonly rowPts = new Int16Array(COLS);
  private readonly saveType = new Uint8Array(MAX_CELLS);
  private readonly saveUp = new Uint8Array(MAX_CELLS);

  /**
   * Generate one act's map. `seed` is the run seed: the act's map stream is
   * derived from it, so each act of a run gets a different, independent map.
   * Pass `out` to reuse a map's buffers, and `trace` to record every step.
   */
  generate(config: GenConfig, seed: number, out?: StsMap, trace?: TraceEvent[]): StsMap {
    this.cfg = config;
    this.rooms = config.rooms;
    this.boss = (config.rooms + 1) * COLS + START_COL;
    this.trace = trace ?? null;
    this.rng.reseed(actStreamSeed(seed >>> 0, config.act.index));

    const n = cellCount(this.rooms);
    this.type.fill(0, 0, n);
    this.up.fill(0, 0, n);
    this.down.fill(0, 0, n);
    this.fixed.fill(0, 0, n);
    this.keep.fill(0, 0, n);
    this.lockedUp.fill(0, 0, n);
    this.type[START] = Ancient;
    this.type[this.boss] = Boss;
    this.pruneIterations = 0;

    this.dealQuotas();
    this.carve();
    if (this.trace) this.snapshot('carve');
    this.assign();
    if (this.trace) this.snapshot('assign');
    if (config.rules.prune) {
      this.pruneAndRepair();
      if (this.trace) this.snapshot('prune');
    }
    if (config.rules.layout) {
      this.layout();
      if (this.trace) this.snapshot('layout');
    }
    this.trace = null;
    return this.writeMap(out);
  }

  // ---- 1. Quotas ----

  private dealQuotas(): void {
    const { cfg, rng } = this;
    const r = cfg.act.rests;
    const rests = r.kind === 'gaussian' ? rng.gaussianInt(r.mean, r.sd, r.min, r.max) : r.min + rng.int(r.max - r.min + 1);
    const unknowns = rng.gaussianInt(12, 1, 10, 14) + cfg.act.unknownOffset;
    this.quotas = { rests, shops: cfg.shops, elites: cfg.elites, unknowns };
    this.targets = this.quotas;
    if (this.trace) this.trace.push({ kind: 'quotas', quotas: { ...this.quotas } });
  }

  // ---- 2. Paths ----

  private carve(): void {
    const { cfg, rng, rooms } = this;
    for (let i = 0; i < cfg.designPaths.length; i++) {
      const cols = cfg.designPaths[i];
      for (let r = 1; r <= rooms; r++) {
        const cell = r * COLS + cols[r - 1];
        if (this.type[cell] === 0) this.type[cell] = Unassigned;
        this.keep[cell] = 1;
        if (r < rooms) {
          const d = cols[r] - cols[r - 1] + 1;
          this.link(cell, d);
          this.lockedUp[cell] |= 1 << d;
        }
      }
      if (this.trace) {
        this.trace.push({ kind: 'path', index: i, designed: true, cells: Array.from(cols, (c, r) => (r + 1) * COLS + c) });
      }
    }

    const noCrossing = cfg.rules.noCrossing;
    let firstCol = -1;
    for (let i = 0; i < cfg.rules.paths; i++) {
      let col = rng.int(COLS);
      if (i === 0) firstCol = col;
      else if (i === 1 && cfg.rules.distinctStarts) while (col === firstCol) col = rng.int(COLS);
      let cell = COLS + col;
      if (this.type[cell] === 0) this.type[cell] = Unassigned;
      const cells = this.trace ? [cell] : null;
      for (let r = 1; r < rooms; r++) {
        const base = rng.int(6) * 3;
        let d = 1;
        for (let k = 0; k < 3; k++) {
          let target = col + STEP_ORDERS[base + k];
          if (target < 0) target = 0;
          else if (target >= COLS) target = COLS - 1;
          // Stepping sideways crosses an edge if the neighbor we step toward already
          // has an edge stepping the other way, back over our column.
          if (noCrossing && target !== col && (this.up[cell - col + target] >> (col - target + 1)) & 1) continue;
          d = target - col + 1;
          break;
        }
        cell = this.link(cell, d);
        col += d - 1;
        if (cells) cells.push(cell);
      }
      if (this.trace && cells) this.trace.push({ kind: 'path', index: i, designed: false, cells });
    }
  }

  /** Add the edge from `cell` in direction d (0 left, 1 straight, 2 right); returns the child cell. */
  private link(cell: number, d: number): number {
    const child = cell + COLS - 1 + d;
    this.up[cell] |= 1 << d;
    this.down[child] |= 1 << (2 - d);
    if (this.type[child] === 0) this.type[child] = Unassigned;
    return child;
  }

  // ---- 3. Room types ----

  private assign(): void {
    const { cfg, rooms, type, fixed } = this;
    const fixRow = (row: number, t: Room) => {
      const cells = this.trace ? ([] as number[]) : null;
      for (let c = 0; c < COLS; c++) {
        const cell = row * COLS + c;
        if (type[cell] === 0) continue;
        type[cell] = t;
        fixed[cell] = 1;
        if (cells) cells.push(cell);
      }
      if (this.trace && cells) this.trace.push({ kind: 'fixed', type: t, cells });
    };
    fixRow(rooms, Rest);
    fixRow(rooms - 6, Treasure);
    fixRow(1, Monster);

    const pinned = [0, 0, 0, 0, 0, 0, 0];
    for (const pin of cfg.pins) {
      const cell = pin.row * COLS + pin.col;
      if (type[cell] === 0) continue;
      type[cell] = pin.type;
      fixed[cell] = 1;
      this.keep[cell] = 1;
      pinned[pin.type]++;
      if (this.trace) this.trace.push({ kind: 'pin', cell, type: pin.type });
    }

    if (cfg.rules.quotas === 'sts1') {
      // STS1 deals each type as a share of the nodes left to fill.
      let open = 0;
      for (let cell = COLS; cell < (rooms + 1) * COLS; cell++) if (type[cell] === Unassigned) open++;
      this.targets = {
        rests: Math.round(open * 0.12),
        shops: Math.round(open * 0.05),
        elites: Math.round(open * cfg.sts1EliteShare),
        unknowns: Math.round(open * 0.22),
      };
      if (this.trace) this.trace.push({ kind: 'quotas', quotas: { ...this.targets } });
    }
    const t = this.targets;
    this.qlen = 0;
    this.enqueue(Rest, t.rests - pinned[Rest]);
    this.enqueue(Shop, t.shops - pinned[Shop]);
    this.enqueue(Elite, t.elites - pinned[Elite]);
    this.enqueue(Unknown, t.unknowns - pinned[Unknown]);

    const { list, rng } = this;
    const end = (rooms + 1) * COLS;
    for (let pass = 0; pass < 3 && this.qlen > 0; pass++) {
      let n = 0;
      for (let cell = COLS; cell < end; cell++) if (type[cell] === Unassigned) list[n++] = cell;
      rng.shuffle(list, n);
      for (let i = 0; i < n && this.qlen > 0; i++) {
        const cell = list[i];
        const chosen = this.takeValid(cell);
        if (chosen !== Unassigned) {
          type[cell] = chosen;
          if (this.trace) this.trace.push({ kind: 'assign', cell, type: chosen as Room, pass });
        }
      }
    }

    const filled = this.trace ? ([] as number[]) : null;
    for (let cell = COLS; cell < end; cell++) {
      if (type[cell] === Unassigned) {
        type[cell] = Monster;
        if (filled) filled.push(cell);
      }
    }
    if (this.trace && filled) this.trace.push({ kind: 'fill', cells: filled });
  }

  private enqueue(t: number, count: number): void {
    for (let i = 0; i < count; i++) this.queue[this.qlen++] = t;
  }

  /**
   * The first queued type valid at `cell`, removed from the queue; the types
   * tried before it go to the back, in order. `Unassigned` if none fits.
   */
  private takeValid(cell: number): number {
    const { queue, validCache } = this;
    validCache.fill(-1);
    const len = this.qlen;
    for (let k = 0; k < len; k++) {
      const t = queue[k];
      let v = validCache[t];
      if (v < 0) v = validCache[t] = this.isValid(t, cell) ? 1 : 0;
      if (v === 1) {
        // New queue: [k+1, len) then [0, k).
        this.queueTmp.set(queue.subarray(0, k));
        queue.copyWithin(0, k + 1, len);
        queue.set(this.queueTmp.subarray(0, k), len - k - 1);
        this.qlen = len - 1;
        return t;
      }
    }
    return Unassigned;
  }

  /** The game's placement rules (`IsValidPointType`). */
  private isValid(t: number, cell: number): boolean {
    const rules = this.cfg.rules;
    const row = ROW_OF[cell];
    if (t === Rest && rules.noRestBeforeRestRow && row >= this.rooms - 2) return false;
    if ((t === Rest || t === Elite) && rules.noEarlyEliteOrRest && row < 6) return false;
    const { type, up, down } = this;
    if (rules.noRepeats && (t === Elite || t === Rest || t === Treasure || t === Shop)) {
      // Row 1's parent is the start and the top row's child is the boss: never a match.
      const pm = row === 1 ? 0 : down[cell];
      if ((pm & 1 && type[cell - 8] === t) || (pm & 2 && type[cell - 7] === t) || (pm & 4 && type[cell - 6] === t)) {
        return false;
      }
      const cm = up[cell];
      if ((cm & 1 && type[cell + 6] === t) || (cm & 2 && type[cell + 7] === t) || (cm & 4 && type[cell + 8] === t)) {
        return false;
      }
    }
    if (rules.distinctSiblings && (t === Rest || t === Monster || t === Unknown || t === Elite || t === Shop)) {
      if (row === 1) {
        // Every row-1 node is a child of the start.
        for (let c = COLS; c < 2 * COLS; c++) if (c !== cell && type[c] === t) return false;
      } else {
        const pm = down[cell];
        for (let d = 0; d < 3; d++) {
          if (!(pm & (1 << d))) continue;
          const p = cell - 8 + d;
          const sm = up[p];
          for (let e = 0; e < 3; e++) {
            if (!(sm & (1 << e))) continue;
            const s = p + 6 + e;
            if (s !== cell && type[s] === t) return false;
          }
        }
      }
    }
    return true;
  }

  // ---- 4. Pruning duplicate routes ----

  private pruneAndRepair(): void {
    for (let round = 0; round < 3; round++) {
      this.pruneIterations += this.pruneDuplicates();
      if (!this.repair()) break;
    }
  }

  private childCount(cell: number): number {
    if (cell === START) {
      let n = 0;
      for (let c = COLS; c < 2 * COLS; c++) if (this.type[c] !== 0) n++;
      return n;
    }
    return ROW_OF[cell] === this.rooms ? 1 : POP3[this.up[cell]];
  }

  private parentCount(cell: number): number {
    if (cell === this.boss) {
      let n = 0;
      const base = this.rooms * COLS;
      for (let c = base; c < base + COLS; c++) if (this.type[c] !== 0) n++;
      return n;
    }
    const row = ROW_OF[cell];
    return row === 1 ? 1 : row === 0 ? 0 : POP3[this.down[cell]];
  }

  private computeReach(): void {
    const { reach, type, up, rooms } = this;
    const n = cellCount(rooms);
    reach.fill(0, 0, n);
    for (let c = COLS; c < 2 * COLS; c++) if (type[c] !== 0) reach[c] = 1;
    for (let cell = COLS; cell < rooms * COLS; cell++) {
      if (!(reach[cell] & 1)) continue;
      const m = up[cell];
      if (m & 1) reach[cell + 6] |= 1;
      if (m & 2) reach[cell + 7] |= 1;
      if (m & 4) reach[cell + 8] |= 1;
    }
    const top = rooms * COLS;
    for (let c = top; c < top + COLS; c++) if (type[c] !== 0) reach[c] |= 2;
    for (let cell = top - 1; cell >= COLS; cell--) {
      const m = up[cell];
      if ((m & 1 && reach[cell + 6] & 2) || (m & 2 && reach[cell + 7] & 2) || (m & 4 && reach[cell + 8] & 2)) {
        reach[cell] |= 2;
      }
    }
    reach[START] = 3;
    reach[this.boss] = 3;
    let bossParents = 0;
    for (let c = top; c < top + COLS; c++) if (type[c] !== 0) bossParents++;
    this.bossParents = bossParents;
  }

  /**
   * `PruneDuplicateSegments`: prune duplicate groups until none are left.
   * The game rescans from its first group after every prune; this re-checks
   * the fork it just pruned, moves on, and ends with a full pass that finds
   * nothing: the same fixpoint with a fraction of the scans. Returns the
   * number of prunes (capped like the game's 50 iterations).
   */
  private pruneDuplicates(): number {
    let prunes = 0;
    for (;;) {
      let changed = false;
      this.computeReach();
      while (this.forkPrune(START)) {
        changed = true;
        if (++prunes >= MAX_PRUNE_ITERATIONS) return prunes;
        this.computeReach();
      }
      const end = this.rooms * COLS;
      for (let cell = COLS; cell < end; cell++) {
        while (this.reach[cell] === 3 && POP3[this.up[cell]] >= 2 && this.forkPrune(cell)) {
          changed = true;
          if (++prunes >= MAX_PRUNE_ITERATIONS) return prunes;
          this.computeReach();
        }
      }
      if (!changed) return prunes;
    }
  }

  /**
   * Find duplicate routes out of fork F and prune the first group that can be.
   *
   * A segment runs from F to a merge M (a node with 2+ parents) at least two
   * steps on. Two segments are duplicates when they share F and M, pass
   * through the same room types, and share no node in between: the fork
   * offers the same thing twice. The game lists every route from the start
   * and files every segment; this finds the duplicates far faster:
   *
   * Two duplicates leave F by different children and stay on different nodes
   * until M, matching room for room. So the search walks all routes out of F
   * one row at a time and drops a route unless another branch has the same
   * rooms so far on a different node. Random room types kill almost every
   * route within a row or two. Every route on a row reaching a merge is filed
   * under (M, inner rooms), packed into one float with the rooms as base-6
   * digits (6^17 · 256 < 2^53); all routes for a key end on the same row, so
   * groups are formed row by row and the search stops at the first prune.
   */
  private forkPrune(F: number): boolean {
    this.trieN = 0;
    this.nxtN = 0;
    this.candN = 0;
    this.extend(this.addTrie(F, -1), F, 0, -1, 0);
    for (let level = 1; this.nxtN > 0; level++) {
      this.swapFrontier();
      const n = this.keepPartnered(this.nxtN);
      this.nxtN = 0;
      this.candN = 0;
      const { curTrie, curSeq, curFirst, trieCell } = this;
      for (let i = 0; i < n; i++) this.extend(curTrie[i], trieCell[curTrie[i]], curSeq[i], curFirst[i], level);
      if (this.candN >= 2 && this.pruneCandidates(level + 2)) return true;
    }
    return false;
  }

  /** Extend one route (ending at `node`, `level` steps from the fork) by each child on a start-to-boss path. */
  private extend(trie: number, node: number, seq: number, first: number, level: number): void {
    const { reach, boss } = this;
    if (node === START) {
      for (let c = COLS; c < 2 * COLS; c++) if (reach[c] === 3) this.step(trie, c, seq, first, level);
    } else if (ROW_OF[node] === this.rooms) {
      this.step(trie, boss, seq, first, level);
    } else {
      const m = this.up[node];
      if (m & 1 && reach[node + 6] === 3) this.step(trie, node + 6, seq, first, level);
      if (m & 2 && reach[node + 7] === 3) this.step(trie, node + 7, seq, first, level);
      if (m & 4 && reach[node + 8] === 3) this.step(trie, node + 8, seq, first, level);
    }
  }

  private step(trie: number, child: number, seq: number, first: number, level: number): void {
    const t = this.addTrie(child, trie);
    const boss = child === this.boss;
    // A segment needs at least one node between the fork and the merge (so the child is above row 1).
    if (level >= 1 && (boss ? this.bossParents : POP3[this.down[child]]) >= 2) {
      if (this.candN === this.candKey.length) this.growCandidates();
      const c = this.candN++;
      this.candKey[c] = seq * 256 + child;
      this.candFirst[c] = first;
      this.candTrie[c] = t;
    }
    if (boss) return;
    if (this.nxtN === this.nxtTrie.length) this.growFrontier();
    const i = this.nxtN++;
    this.nxtTrie[i] = t;
    this.nxtSeq[i] = seq * 6 + (this.type[child] - 1);
    this.nxtFirst[i] = first === -1 ? child : first;
  }

  private swapFrontier(): void {
    [this.curTrie, this.nxtTrie] = [this.nxtTrie, this.curTrie];
    [this.curSeq, this.nxtSeq] = [this.nxtSeq, this.curSeq];
    [this.curFirst, this.nxtFirst] = [this.nxtFirst, this.curFirst];
  }

  private growFrontier(): void {
    const cap = this.nxtTrie.length * 2;
    this.nxtTrie = grown(this.nxtTrie, new Int32Array(cap));
    this.nxtSeq = grown(this.nxtSeq, new Float64Array(cap));
    this.nxtFirst = grown(this.nxtFirst, new Int16Array(cap));
    this.curTrie = grown(this.curTrie, new Int32Array(cap));
    this.curSeq = grown(this.curSeq, new Float64Array(cap));
    this.curFirst = grown(this.curFirst, new Int16Array(cap));
    this.sortIdx = new Int32Array(cap);
    this.keepFlag = new Uint8Array(cap);
  }

  private growCandidates(): void {
    const cap = this.candKey.length * 2;
    this.candKey = grown(this.candKey, new Float64Array(cap));
    this.candFirst = grown(this.candFirst, new Int16Array(cap));
    this.candTrie = grown(this.candTrie, new Int32Array(cap));
    this.candNext = new Int32Array(cap);
    this.grpHead = new Int32Array(cap);
    this.grpTail = new Int32Array(cap);
    this.grpCount = new Int32Array(cap);
    this.grpFirst = new Int16Array(cap);
    this.grpMulti = new Uint8Array(cap);
    const size = cap * 2;
    this.htKey = new Float64Array(size);
    this.htGroup = new Int32Array(size);
    this.htStamp = new Uint32Array(size);
    this.htMask = size - 1;
    this.stamp = 0;
  }

  /**
   * Keep the frontier routes that have a partner: another branch with the
   * same rooms so far, on a different node. Partnership is symmetric, so
   * compacting in place never loses a partner. Returns how many are kept.
   */
  private keepPartnered(n: number): number {
    const { curSeq, curFirst, curTrie, trieCell } = this;
    if (n <= 32) {
      let kept = 0;
      for (let i = 0; i < n; i++) {
        const key = curSeq[i];
        const first = curFirst[i];
        const node = trieCell[curTrie[i]];
        let partnered = false;
        for (let j = 0; j < n; j++) {
          if (curSeq[j] === key && curFirst[j] !== first && trieCell[curTrie[j]] !== node) {
            partnered = true;
            break;
          }
        }
        if (!partnered) continue;
        curTrie[kept] = curTrie[i];
        curSeq[kept] = key;
        curFirst[kept] = first;
        kept++;
      }
      return kept;
    }
    // Large frontier: sort by room sequence and compare within each run.
    const idx = this.sortIdx.subarray(0, n);
    for (let i = 0; i < n; i++) idx[i] = i;
    idx.sort((a, b) => curSeq[a] - curSeq[b]);
    const keep = this.keepFlag;
    keep.fill(0, 0, n);
    for (let lo = 0; lo < n; ) {
      let hi = lo + 1;
      while (hi < n && curSeq[idx[hi]] === curSeq[idx[lo]]) hi++;
      for (let a = lo; a < hi; a++) {
        const i = idx[a];
        for (let b = lo; b < hi; b++) {
          const j = idx[b];
          if (curFirst[j] !== curFirst[i] && trieCell[curTrie[j]] !== trieCell[curTrie[i]]) {
            keep[i] = 1;
            break;
          }
        }
      }
      lo = hi;
    }
    let kept = 0;
    for (let i = 0; i < n; i++) {
      if (!keep[i]) continue;
      curTrie[kept] = curTrie[i];
      curSeq[kept] = curSeq[i];
      curFirst[kept] = curFirst[i];
      kept++;
    }
    return kept;
  }

  private addTrie(cell: number, parent: number): number {
    if (this.trieN === this.trieCell.length) {
      const cap = this.trieCell.length * 2;
      this.trieCell = grown(this.trieCell, new Int16Array(cap));
      this.trieParent = grown(this.trieParent, new Int32Array(cap));
    }
    const i = this.trieN++;
    this.trieCell[i] = cell;
    this.trieParent[i] = parent;
    return i;
  }

  /** Group this row's candidates by key; try each group reached from two or more branches. */
  private pruneCandidates(len: number): boolean {
    if (++this.stamp === 0xffffffff) {
      this.htStamp.fill(0);
      this.stamp = 1;
    }
    const { candKey, candFirst, candNext, htKey, htGroup, htStamp, htMask, stamp } = this;
    const { grpHead, grpTail, grpCount, grpFirst, grpMulti } = this;
    let groups = 0;
    for (let e = 0; e < this.candN; e++) {
      const key = candKey[e];
      candNext[e] = -1;
      let h = slot(key, htMask);
      for (;;) {
        if (htStamp[h] !== stamp) {
          const g = groups++;
          htStamp[h] = stamp;
          htKey[h] = key;
          htGroup[h] = g;
          grpHead[g] = grpTail[g] = e;
          grpCount[g] = 1;
          grpFirst[g] = candFirst[e];
          grpMulti[g] = 0;
          break;
        }
        if (htKey[h] === key) {
          const g = htGroup[h];
          candNext[grpTail[g]] = e;
          grpTail[g] = e;
          grpCount[g]++;
          if (candFirst[e] !== grpFirst[g]) grpMulti[g] = 1;
          break;
        }
        h = (h + 1) & htMask;
      }
    }
    for (let g = 0; g < groups; g++) if (grpMulti[g] && this.pruneGroup(g, len)) return true;
    return false;
  }

  /**
   * Choose the group's members: in depth-first order (the game's), each route
   * that shares no inner node with those already chosen. Then shuffle them and
   * prune all but one; if no route can lose nodes, cut an edge from the fork
   * into the merge instead.
   */
  private pruneGroup(g: number, len: number): boolean {
    const { routes, trieCell, trieParent } = this;
    const count = this.grpCount[g];
    if (count > this.entOrder.length) {
      this.entOrder = new Int32Array(count * 2);
      this.entRoutes = new Int16Array(count * 2 * ROUTE_STRIDE);
    }
    const { entRoutes, entOrder } = this;
    let k = 0;
    for (let e = this.grpHead[g]; e !== -1; e = this.candNext[e], k++) {
      const base = k * ROUTE_STRIDE;
      for (let i = len - 1, t = this.candTrie[e]; i >= 0; i--, t = trieParent[t]) entRoutes[base + i] = trieCell[t];
      entOrder[k] = k;
    }
    for (let i = 1; i < count; i++) {
      const x = entOrder[i];
      let j = i - 1;
      while (j >= 0 && compareRoutes(entRoutes, entOrder[j] * ROUTE_STRIDE, x * ROUTE_STRIDE, len) > 0) {
        entOrder[j + 1] = entOrder[j];
        j--;
      }
      entOrder[j + 1] = x;
    }

    let members = 0;
    for (let i = 0; i < count && members < MAX_MEMBERS; i++) {
      const src = entOrder[i] * ROUTE_STRIDE;
      let overlaps = false;
      for (let m = 0; m < members && !overlaps; m++) {
        const other = m * ROUTE_STRIDE;
        for (let p = 1; p < len - 1; p++) {
          if (routes[other + p] === entRoutes[src + p]) {
            overlaps = true;
            break;
          }
        }
      }
      if (overlaps) continue;
      routes.set(entRoutes.subarray(src, src + len), members * ROUTE_STRIDE);
      members++;
    }
    if (members < 2) return false;

    const { order } = this;
    for (let m = 0; m < members; m++) order[m] = m;
    this.rng.shuffle(order, members);
    if (this.trace) {
      this.trace.push({
        kind: 'duplicates',
        routes: Array.from(order.subarray(0, members), (m) => Array.from(routes.subarray(m * ROUTE_STRIDE, m * ROUTE_STRIDE + len))),
      });
    }

    let pruned = 0;
    for (let k = 0; k < members && pruned < members - 1; k++) {
      if (this.pruneRoute(order[k] * ROUTE_STRIDE, len)) pruned++;
    }
    if (pruned > 0) return true;
    for (let k = 0; k < members; k++) {
      if (this.cutRoute(order[k] * ROUTE_STRIDE, len)) return true;
    }
    return false;
  }

  /** `PruneSegment`: remove the route's nodes that nothing else depends on. */
  private pruneRoute(base: number, len: number): boolean {
    const { routes, type } = this;
    const last = routes[base + len - 1];
    let removed = false;
    for (let i = 0; i < len - 1; i++) {
      const p = routes[base + i];
      if (p === START) continue;
      if (type[p] === 0) return true; // already gone: counts as pruned
      if (this.childCount(p) > 1 || this.parentCount(p) > 1) continue;
      if (this.leavesParentChildless(p)) continue;
      let forkAhead = false;
      for (let j = i; j < len; j++) {
        const q = routes[base + j];
        if (this.childCount(q) > 1 && this.parentCount(q) === 1) {
          forkAhead = true;
          break;
        }
      }
      if (forkAhead) continue;
      if (this.parentCount(last) === 1) return false;
      if (this.strandsChild(p, base, len)) continue;
      if (this.keep[p]) continue;
      this.removeNode(p);
      removed = true;
    }
    return removed;
  }

  /** Whether a grid parent of `cell` has `cell` as its only child. */
  private leavesParentChildless(cell: number): boolean {
    if (ROW_OF[cell] === 1) return false;
    const pm = this.down[cell];
    for (let d = 0; d < 3; d++) if (pm & (1 << d) && POP3[this.up[cell - 8 + d]] === 1) return true;
    return false;
  }

  /** Whether removing `cell` would leave one of its children (off the route) without a parent. */
  private strandsChild(cell: number, base: number, len: number): boolean {
    const { routes } = this;
    const onRoute = (c: number) => {
      for (let i = 0; i < len; i++) if (routes[base + i] === c) return true;
      return false;
    };
    if (ROW_OF[cell] === this.rooms) return !onRoute(this.boss) && this.parentCount(this.boss) === 1;
    const m = this.up[cell];
    for (let d = 0; d < 3; d++) {
      if (!(m & (1 << d))) continue;
      const c = cell + 6 + d;
      if (POP3[this.down[c]] === 1 && !onRoute(c)) return true;
    }
    return false;
  }

  private removeNode(cell: number): void {
    const { up, down } = this;
    const m = up[cell];
    for (let d = 0; d < 3; d++) if (m & (1 << d)) down[cell + 6 + d] &= ~(1 << (2 - d));
    const pm = down[cell];
    for (let d = 0; d < 3; d++) if (pm & (1 << d)) up[cell - 8 + d] &= ~(1 << (2 - d));
    up[cell] = 0;
    down[cell] = 0;
    this.type[cell] = 0;
    if (this.trace) this.trace.push({ kind: 'remove', cell });
  }

  /** `BreakAParentChildRelationshipInSegment`: cut each edge from a fork into a merge. */
  private cutRoute(base: number, len: number): boolean {
    const { routes } = this;
    let broke = false;
    for (let i = 0; i < len - 1; i++) {
      const p = routes[base + i];
      const n = routes[base + i + 1];
      if (this.childCount(p) < 2 || this.parentCount(n) === 1) continue;
      // The start's and boss's edges are implicit and never qualify (row 1 has one parent, the top row one child).
      if (p === START || n === this.boss) continue;
      const d = (n % COLS) - (p % COLS) + 1;
      if (this.lockedUp[p] & (1 << d)) continue;
      if (this.up[p] & (1 << d)) {
        this.up[p] &= ~(1 << d);
        this.down[n] &= ~(1 << (2 - d));
        if (this.trace) this.trace.push({ kind: 'cut', from: p, to: n });
      }
      // The game counts this even if an earlier cut already removed the edge.
      broke = true;
    }
    return broke;
  }

  /** `RepairPrunedPointTypes`: turn monsters back into types pruning took below target. */
  private repair(): boolean {
    const t = this.targets;
    const shop = this.repairType(Shop, t.shops);
    const elite = this.repairType(Elite, t.elites);
    // As in the game, the fixed rest row counts toward the rest target, so this rarely fires.
    const rest = this.repairType(Rest, t.rests);
    const unknown = this.repairType(Unknown, t.unknowns);
    return shop || elite || rest || unknown;
  }

  private repairType(t: number, target: number): boolean {
    const { type, fixed, list } = this;
    const end = (this.rooms + 1) * COLS;
    let missing = target;
    for (let cell = COLS; cell < end; cell++) if (type[cell] === t) missing--;
    if (missing <= 0) return false;
    let n = 0;
    for (let cell = COLS; cell < end; cell++) if (type[cell] === Monster && !fixed[cell]) list[n++] = cell;
    this.rng.shuffle(list, n);
    let repaired = false;
    for (let i = 0; i < n && missing > 0; i++) {
      const cell = list[i];
      if (this.isValid(t, cell)) {
        type[cell] = t;
        missing--;
        repaired = true;
        if (this.trace) this.trace.push({ kind: 'repair', cell, type: t as Room });
      }
    }
    return repaired;
  }

  // ---- 5. Layout ----

  /**
   * Moves nodes sideways for a cleaner drawing. Works on a column per node
   * (`lcol`, indexed by the node's pre-layout cell) and an occupancy grid, then
   * rebuilds the edge masks. Every edge still spans at most one column.
   */
  private layout(): void {
    const { rooms, type, lcol, occ } = this;
    const n = cellCount(rooms);
    occ.fill(-1, 0, n);
    for (let cell = COLS; cell < (rooms + 1) * COLS; cell++) {
      if (type[cell] === 0) continue;
      lcol[cell] = cell % COLS;
      occ[cell] = cell;
    }

    // Center: shift a column toward the middle if both outer columns on one side are empty.
    const columnEmpty = (c: number) => {
      for (let r = 1; r <= rooms; r++) if (occ[r * COLS + c] !== -1) return false;
      return true;
    };
    const leftEmpty = columnEmpty(0) && columnEmpty(1);
    const rightEmpty = columnEmpty(COLS - 1) && columnEmpty(COLS - 2);
    const shift = leftEmpty && !rightEmpty ? -1 : rightEmpty && !leftEmpty ? 1 : 0;
    if (shift !== 0) {
      occ.fill(-1, 0, n);
      for (let cell = COLS; cell < (rooms + 1) * COLS; cell++) {
        if (type[cell] === 0) continue;
        const from = lcol[cell];
        lcol[cell] = from + shift;
        occ[ROW_OF[cell] * COLS + from + shift] = cell;
        if (this.trace) this.trace.push({ kind: 'move', step: 'center', row: ROW_OF[cell], from, to: from + shift });
      }
    }

    // Spread: move each node to the allowed column farthest from its row's other nodes.
    const { rowPts } = this;
    for (let r = 1; r <= rooms; r++) {
      let count = 0;
      for (let c = 0; c < COLS; c++) {
        const id = occ[r * COLS + c];
        if (id !== -1) rowPts[count++] = id;
      }
      for (let guard = 0; guard < 32; guard++) {
        let moved = false;
        for (let i = 0; i < count; i++) {
          const id = rowPts[i];
          const col = lcol[id];
          let best = col;
          let bestGap = this.gap(col, id, count);
          const lo = this.allowedLo(id);
          const hi = this.allowedHi(id);
          for (let cand = lo; cand <= hi; cand++) {
            if (cand === col || occ[r * COLS + cand] !== -1) continue;
            const g = this.gap(cand, id, count);
            if (g > bestGap) {
              best = cand;
              bestGap = g;
            }
          }
          if (best !== col) {
            occ[r * COLS + col] = -1;
            occ[r * COLS + best] = id;
            lcol[id] = best;
            moved = true;
            if (this.trace) this.trace.push({ kind: 'move', step: 'spread', row: r, from: col, to: best });
          }
        }
        if (!moved) break;
      }
    }

    // Straighten: a node whose one parent and one child both sit to one side steps toward them.
    for (let r = 1; r <= rooms; r++) {
      for (let c = 0; c < COLS; c++) {
        const id = occ[r * COLS + c];
        if (id === -1) continue;
        const pc = this.soleParentCol(id);
        const cc = this.soleChildCol(id);
        if (pc < 0 || cc < 0) continue;
        let target = -1;
        if (c < pc && c < cc && c < COLS - 1) target = c + 1;
        else if (c > pc && c > cc && c > 0) target = c - 1;
        if (target < 0 || occ[r * COLS + target] !== -1) continue;
        occ[r * COLS + c] = -1;
        occ[r * COLS + target] = id;
        lcol[id] = target;
        if (this.trace) this.trace.push({ kind: 'move', step: 'straighten', row: r, from: c, to: target });
      }
    }

    this.rebuildAfterLayout();
  }

  /** Distance from `col` to the nearest other node in the row (`rowPts`). */
  private gap(col: number, id: number, count: number): number {
    let best = 99;
    for (let i = 0; i < count; i++) {
      const other = this.rowPts[i];
      if (other === id) continue;
      const d = Math.abs(col - this.lcol[other]);
      if (d < best) best = d;
    }
    return best;
  }

  /** Lowest column within one of every neighbor (parents, children, and the start or boss). */
  private allowedLo(id: number): number {
    let lo = 0;
    this.forNeighborCols(id, (c) => {
      if (c - 1 > lo) lo = c - 1;
    });
    return lo;
  }

  private allowedHi(id: number): number {
    let hi = COLS - 1;
    this.forNeighborCols(id, (c) => {
      if (c + 1 < hi) hi = c + 1;
    });
    return hi;
  }

  private forNeighborCols(id: number, fn: (col: number) => void): void {
    const row = ROW_OF[id];
    if (row === 1) fn(START_COL);
    else {
      const pm = this.down[id];
      for (let d = 0; d < 3; d++) if (pm & (1 << d)) fn(this.lcol[id - 8 + d]);
    }
    if (row === this.rooms) fn(START_COL);
    else {
      const cm = this.up[id];
      for (let d = 0; d < 3; d++) if (cm & (1 << d)) fn(this.lcol[id + 6 + d]);
    }
  }

  private soleParentCol(id: number): number {
    if (ROW_OF[id] === 1) return START_COL;
    const pm = this.down[id];
    if (POP3[pm] !== 1) return -1;
    return this.lcol[id - 8 + (pm === 1 ? 0 : pm === 2 ? 1 : 2)];
  }

  private soleChildCol(id: number): number {
    if (ROW_OF[id] === this.rooms) return START_COL;
    const cm = this.up[id];
    if (POP3[cm] !== 1) return -1;
    return this.lcol[id + 6 + (cm === 1 ? 0 : cm === 2 ? 1 : 2)];
  }

  private rebuildAfterLayout(): void {
    const { rooms, type, up, down, lcol, list, saveType, saveUp } = this;
    // Save nodes and their edges (by pre-layout cell) before rewriting the arrays in place.
    let n = 0;
    const end = (rooms + 1) * COLS;
    for (let cell = COLS; cell < end; cell++) {
      if (type[cell] === 0) continue;
      list[n++] = cell;
      saveType[cell] = type[cell];
      saveUp[cell] = up[cell];
    }
    type.fill(0, COLS, end);
    up.fill(0, COLS, end);
    down.fill(0, COLS, end);
    for (let i = 0; i < n; i++) {
      const old = list[i];
      const row = ROW_OF[old];
      const from = row * COLS + lcol[old];
      type[from] = saveType[old];
      const m = saveUp[old];
      for (let d = 0; d < 3; d++) {
        if (!(m & (1 << d))) continue;
        const oldChild = old + 6 + d;
        const nd = lcol[oldChild] - lcol[old] + 1;
        up[from] |= 1 << nd;
        down[(row + 1) * COLS + lcol[oldChild]] |= 1 << (2 - nd);
      }
    }
  }

  // ---- Output ----

  private snapshot(phase: Phase): void {
    this.trace?.push({ kind: 'phase', phase, map: this.writeMap() });
  }

  private writeMap(out?: StsMap): StsMap {
    const n = cellCount(this.rooms);
    if (!out || out.type.length !== n) out = createMap(this.rooms);
    out.rooms = this.rooms;
    out.type.set(this.type.subarray(0, n));
    out.up.set(this.up.subarray(0, n));
    out.down.set(this.down.subarray(0, n));
    out.secondBoss = this.cfg.secondBoss;
    out.quotas = { ...this.targets };
    return out;
  }
}

let shared: MapGenerator | null = null;

/** Generate one map. For many maps, keep a `MapGenerator` and a resolved config instead. */
export function generateMap(seed: number | string, options?: GenerateOptions, trace?: TraceEvent[]): StsMap {
  shared ??= new MapGenerator();
  return shared.generate(resolveConfig(options), seedValue(seed), undefined, trace);
}
