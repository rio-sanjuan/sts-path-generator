import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.ts';
import { generateMap, MapGenerator, type TraceEvent } from '../src/generator.ts';
import { cellOf, childrenOf, COLS, mapToString, parentsOf, roomCounts, rowOf, type StsMap } from '../src/map.ts';
import { ACTS, Room, type ActId, type GenerateOptions } from '../src/types.ts';
import { findDuplicateSegments } from './oracle.ts';

const ACT_IDS = Object.keys(ACTS) as ActId[];

function* maps(options: GenerateOptions, count: number, firstSeed = 1): Generator<[StsMap, number]> {
  const gen = new MapGenerator();
  const config = resolveConfig(options);
  for (let s = firstSeed; s < firstSeed + count; s++) yield [gen.generate(config, s), s];
}

function gridNodes(map: StsMap): number[] {
  const out: number[] = [];
  for (let cell = COLS; cell < (map.rooms + 1) * COLS; cell++) if (map.type[cell] !== Room.Empty) out.push(cell);
  return out;
}

/** Structural invariants every finished map must satisfy. Returns a problem, or null. */
function structureProblem(map: StsMap): string | null {
  const n = map.type.length;
  for (let cell = 0; cell < n; cell++) {
    const row = rowOf(cell);
    const col = cell % COLS;
    const t = map.type[cell];
    if ((map.up[cell] || map.down[cell]) && (t === Room.Empty || row === 0 || row > map.rooms)) {
      return `edges on a non-grid cell (${row},${col})`;
    }
    for (let d = 0; d < 3; d++) {
      if (map.up[cell] & (1 << d)) {
        const c = col + d - 1;
        if (c < 0 || c >= COLS || row >= map.rooms) return `up-edge off the grid at (${row},${col})`;
        const child = cell + COLS - 1 + d;
        if (map.type[child] === Room.Empty) return `edge to an empty cell from (${row},${col})`;
        if (!(map.down[child] & (1 << (2 - d)))) return `up/down masks disagree at (${row},${col})`;
      }
      if (map.down[cell] & (1 << d)) {
        const parent = cell - COLS - 1 + d;
        if (!(map.up[parent] & (1 << (2 - d)))) return `down/up masks disagree at (${row},${col})`;
      }
    }
  }
  for (const cell of gridNodes(map)) {
    if (parentsOf(map, cell).length === 0) return `node without parents at (${rowOf(cell)},${cell % COLS})`;
    if (childrenOf(map, cell).length === 0) return `node without children at (${rowOf(cell)},${cell % COLS})`;
  }
  // Paths start in at least two columns, but pruning can remove a starting room:
  // about 2.5% of the game's own maps have a single one.
  if (gridNodes(map).filter((c) => rowOf(c) === 1).length < 1) return 'no starting room';
  return null;
}

/** The game's placement rules, checked on a finished map. Returns a problem, or null. */
function ruleProblem(map: StsMap): string | null {
  const { rooms } = map;
  const treasureRow = rooms - 6;
  for (const cell of gridNodes(map)) {
    const row = rowOf(cell);
    const t = map.type[cell];
    const at = `${Room.Empty === t ? '?' : t} at (${row},${cell % COLS})`;
    if (row === 1 && t !== Room.Monster) return `row 1 not a monster: ${at}`;
    if (row === treasureRow && t !== Room.Treasure) return `treasure row: ${at}`;
    if (row !== treasureRow && t === Room.Treasure) return `treasure off its row: ${at}`;
    if (row === rooms && t !== Room.Rest) return `top row not a rest site: ${at}`;
    if (row < 6 && (t === Room.Elite || t === Room.Rest)) return `early elite/rest: ${at}`;
    if (t === Room.Rest && row >= rooms - 2 && row < rooms) return `rest just below the rest row: ${at}`;
    const noRepeat: number[] = [Room.Elite, Room.Rest, Room.Treasure, Room.Shop];
    if (noRepeat.includes(t)) {
      for (const c of childrenOf(map, cell)) if (map.type[c] === t) return `repeat ${at}`;
    }
    const distinct: number[] = [Room.Rest, Room.Unknown, Room.Elite, Room.Shop];
    if (distinct.includes(t) && row !== rooms && row !== treasureRow) {
      for (const p of parentsOf(map, cell)) {
        for (const s of childrenOf(map, p)) if (s !== cell && map.type[s] === t) return `sibling repeat ${at}`;
      }
    }
  }
  const counts = roomCounts(map);
  const q = map.quotas;
  if (counts[Room.Shop] > q.shops) return `${counts[Room.Shop]} shops > ${q.shops}`;
  if (counts[Room.Elite] > q.elites) return `${counts[Room.Elite]} elites > ${q.elites}`;
  if (counts[Room.Unknown] > q.unknowns) return `${counts[Room.Unknown]} unknowns > ${q.unknowns}`;
  const topRests = gridNodes(map).filter((c) => rowOf(c) === rooms).length;
  if (counts[Room.Rest] - topRests > q.rests) return `${counts[Room.Rest] - topRests} rests > ${q.rests}`;
  return null;
}

function hasCrossing(map: StsMap): boolean {
  for (let row = 1; row < map.rooms; row++) {
    for (let col = 0; col < COLS - 1; col++) {
      if (map.up[cellOf(row, col)] & 4 && map.up[cellOf(row, col + 1)] & 1) return true;
    }
  }
  return false;
}

describe('generateMap', () => {
  it('is deterministic per seed and differs across seeds and acts', () => {
    const a = mapToString(generateMap(1234));
    expect(mapToString(generateMap(1234))).toBe(a);
    expect(mapToString(generateMap(1235))).not.toBe(a);
    expect(mapToString(generateMap('TBL5VNYN4M'))).toBe(mapToString(generateMap(' tbl5vnyn4m ')));
    // All-digit strings are the number itself.
    expect(mapToString(generateMap('1234'))).toBe(a);
    expect(mapToString(generateMap('01234'))).toBe(a);
    // Same height, same seed, different act index: a different map stream.
    expect(mapToString(generateMap(1234, { act: 'overgrowth' }))).toBe(mapToString(generateMap(1234, { act: 'underdocks' })));
    expect(mapToString(generateMap(1234, { act: 'hive', rooms: 15 }))).not.toBe(a);
  });

  it('reuses an output map and produces the same result', () => {
    const gen = new MapGenerator();
    const config = resolveConfig({ act: 'hive' });
    const first = mapToString(gen.generate(config, 77));
    const reused = gen.generate(config, 5, undefined);
    gen.generate(config, 77, reused);
    expect(mapToString(reused)).toBe(first);
  });

  for (const act of ACT_IDS) {
    for (const ascension of [0, 10]) {
      it(`${act} A${ascension}: structure and placement rules hold on 400 maps`, () => {
        const rooms = ACTS[act].rooms;
        for (const [map, seed] of maps({ act, ascension }, 400)) {
          expect(map.rooms).toBe(rooms);
          const problem = structureProblem(map) ?? ruleProblem(map);
          if (problem) throw new Error(`seed ${seed}: ${problem}\n${mapToString(map)}`);
          expect(map.quotas.elites).toBe(ascension >= 1 ? 8 : 5);
          expect(map.secondBoss).toBe(act === 'glory' && ascension === 10);
        }
      });
    }
  }

  it('carves no crossing edges (before layout)', () => {
    for (const [map, seed] of maps({ rules: { layout: false } }, 500)) {
      if (hasCrossing(map)) throw new Error(`seed ${seed} crosses\n${mapToString(map)}`);
    }
  });

  it('can cross when the crossing rule is off', () => {
    let crossed = 0;
    for (const [map] of maps({ rules: { layout: false, noCrossing: false } }, 200)) if (hasCrossing(map)) crossed++;
    expect(crossed).toBeGreaterThan(50);
  });

  it('pruning removes duplicate branches (the brute-force oracle agrees)', () => {
    let withDuplicates = 0;
    let unprunedWithDuplicates = 0;
    const N = 300;
    for (const [map] of maps({ act: 'hive' }, N)) if (findDuplicateSegments(map).length > 0) withDuplicates++;
    for (const [map] of maps({ act: 'hive', rules: { prune: false } }, N)) {
      if (findDuplicateSegments(map).length > 0) unprunedWithDuplicates++;
    }
    // Repair after the last round can occasionally re-create a duplicate, as in the game.
    expect(withDuplicates / N).toBeLessThan(0.03);
    expect(unprunedWithDuplicates / N).toBeGreaterThan(0.3);
  });

  it('deals quotas within the act ranges', () => {
    for (const act of ACT_IDS) {
      for (const [map] of maps({ act }, 300)) {
        const q = map.quotas;
        expect(q.shops).toBe(3);
        if (act === 'glory') expect([5, 6]).toContain(q.rests);
        else expect([6, 7]).toContain(q.rests);
        const offset = ACTS[act].unknownOffset;
        expect(q.unknowns).toBeGreaterThanOrEqual(10 + offset);
        expect(q.unknowns).toBeLessThanOrEqual(14 + offset);
      }
    }
  });

  it('traces every phase, ending with the returned map', () => {
    const trace: TraceEvent[] = [];
    const map = generateMap(99, {}, trace);
    const phases = trace.filter((e) => e.kind === 'phase');
    expect(phases.map((e) => e.phase)).toEqual(['carve', 'assign', 'prune', 'layout']);
    const last = phases[phases.length - 1];
    expect(mapToString(last.map)).toBe(mapToString(map));
    expect(trace.filter((e) => e.kind === 'path')).toHaveLength(7);
    const carved = phases[0].map;
    expect(gridNodes(carved).every((c) => carved.type[c] === Room.Unassigned)).toBe(true);
    // Tracing doesn't change the result.
    expect(mapToString(generateMap(99))).toBe(mapToString(map));
  });

  it('keeps designed paths and pins', () => {
    const path = [3, 3, 2, 2, 1, 1, 0, 0, 0, 1, 2, 3, 4, 4, 4];
    const pins = [
      { row: 7, col: 0, type: Room.Shop },
      { row: 4, col: 2, type: Room.Elite },
    ];
    for (const [map, seed] of maps({ rules: { layout: false }, design: { paths: [path], pins } }, 100)) {
      for (let r = 1; r < path.length; r++) {
        const cell = cellOf(r, path[r - 1]);
        const d = path[r] - path[r - 1] + 1;
        if (!(map.up[cell] & (1 << d))) throw new Error(`seed ${seed}: designed edge lost at row ${r}`);
      }
      expect(map.type[cellOf(7, 0)]).toBe(Room.Shop);
      expect(map.type[cellOf(4, 2)]).toBe(Room.Elite);
      expect(structureProblem(map)).toBeNull();
    }
  });

  it('follows the rule switches', () => {
    for (const [map] of maps({ rules: { paths: 1, distinctStarts: false } }, 50)) {
      expect(gridNodes(map)).toHaveLength(15);
    }
    let elites = 0;
    let nodes = 0;
    for (const [map] of maps({ rules: { quotas: 'sts1' } }, 300)) {
      elites += roomCounts(map)[Room.Elite];
      nodes += gridNodes(map).length;
    }
    // STS1 deals 8% of the open nodes as elites (some get pruned).
    expect(elites / nodes).toBeGreaterThan(0.04);
    expect(elites / nodes).toBeLessThan(0.08);
  });

  it('validates options', () => {
    expect(() => generateMap(1, { rooms: 3 })).toThrow(/Rooms/);
    expect(() => generateMap(1, { ascension: 11 })).toThrow(/Ascension/);
    expect(() => generateMap(1, { design: { paths: [[0, 2]] } })).toThrow(/one per row/);
    expect(() => generateMap(1, { rules: { paths: 0 } })).toThrow(/at least one path/);
  });
});
