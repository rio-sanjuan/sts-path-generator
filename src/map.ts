// The map as flat typed arrays, so generating and analyzing thousands of maps
// allocates almost nothing and maps move between workers cheaply.
//
// Cells are indexed `row * COLS + col`. Row 0 holds the start (the Ancient) at
// column 3; rows 1..rooms are the grid; row rooms+1 holds the boss at column 3.
// Every grid edge climbs one row and moves at most one column, so a node's
// edges fit in 3 bits: bit d means "column + d - 1" in the next (or previous)
// row. The start's edges to every row-1 node and the top row's edges to the
// boss are implicit, never stored.

import { ROOM_CODES, Room, type Quotas } from './types.ts';

export const COLS = 7;
export const START_COL = 3;
export const MIN_ROOMS = 8;
export const MAX_ROOMS = 17;
/** Cells in the largest map: rows 0..MAX_ROOMS+1. */
export const MAX_CELLS = (MAX_ROOMS + 2) * COLS;
/** The start node's cell. */
export const START = START_COL;

export interface StsMap {
  /** Grid rows (rooms between the start and the boss). */
  rooms: number;
  /** Room type per cell; `Room.Empty` where there is no node. */
  type: Uint8Array;
  /** Edges up: bit d set means an edge to (row + 1, col + d - 1). */
  up: Uint8Array;
  /** Edges down: bit d set means an edge from (row - 1, col + d - 1). */
  down: Uint8Array;
  /** A10's double boss: a second boss follows the first in the last act. */
  secondBoss: boolean;
  /** The room-type targets this map was dealt. */
  quotas: Quotas;
}

/** Popcount of a 3-bit edge mask. */
export const POP3 = new Uint8Array([0, 1, 1, 2, 1, 2, 2, 3]);

export const cellOf = (row: number, col: number): number => row * COLS + col;
export const rowOf = (cell: number): number => (cell / COLS) | 0;
export const colOf = (cell: number): number => cell % COLS;
export const bossCell = (map: Pick<StsMap, 'rooms'>): number => (map.rooms + 1) * COLS + START_COL;
export const cellCount = (rooms: number): number => (rooms + 2) * COLS;

export function createMap(rooms: number): StsMap {
  const n = cellCount(rooms);
  return {
    rooms,
    type: new Uint8Array(n),
    up: new Uint8Array(n),
    down: new Uint8Array(n),
    secondBoss: false,
    quotas: { rests: 0, shops: 0, elites: 0, unknowns: 0 },
  };
}

export function cloneMap(map: StsMap): StsMap {
  return {
    rooms: map.rooms,
    type: map.type.slice(),
    up: map.up.slice(),
    down: map.down.slice(),
    secondBoss: map.secondBoss,
    quotas: { ...map.quotas },
  };
}

/** Children of a node, start and boss included. */
export function childrenOf(map: StsMap, cell: number): number[] {
  const out: number[] = [];
  if (cell === START) {
    for (let c = 0; c < COLS; c++) if (map.type[COLS + c] !== Room.Empty) out.push(COLS + c);
    return out;
  }
  const row = rowOf(cell);
  if (row === map.rooms) return [bossCell(map)];
  const m = map.up[cell];
  for (let d = 0; d < 3; d++) if (m & (1 << d)) out.push(cell + COLS - 1 + d);
  return out;
}

/** Parents of a node, start and boss included. */
export function parentsOf(map: StsMap, cell: number): number[] {
  const out: number[] = [];
  const row = rowOf(cell);
  if (row === map.rooms + 1) {
    for (let c = 0; c < COLS; c++) {
      const p = map.rooms * COLS + c;
      if (map.type[p] !== Room.Empty) out.push(p);
    }
    return out;
  }
  if (row === 1) return [START];
  const m = map.down[cell];
  for (let d = 0; d < 3; d++) if (m & (1 << d)) out.push(cell - COLS - 1 + d);
  return out;
}

/** Grid nodes (rows 1..rooms), bottom to top, left to right. */
export function gridCells(map: StsMap): number[] {
  const out: number[] = [];
  const end = (map.rooms + 1) * COLS;
  for (let cell = COLS; cell < end; cell++) if (map.type[cell] !== Room.Empty) out.push(cell);
  return out;
}

/** How many of each room type the grid holds, indexed by `Room`. */
export function roomCounts(map: StsMap): number[] {
  const counts = new Array<number>(10).fill(0);
  const end = (map.rooms + 1) * COLS;
  for (let cell = COLS; cell < end; cell++) counts[map.type[cell]]++;
  counts[Room.Empty] = 0;
  return counts;
}

/**
 * The map as text, top row first. Each node is its room code; the line under
 * a row shows its edges down: `/` from the node to the left below, `|` from
 * straight below, `\` from the right below.
 */
export function mapToString(map: StsMap): string {
  const lines: string[] = [];
  lines.push(' '.repeat(START_COL * 4 + 1) + (map.secondBoss ? 'BB' : 'B'));
  for (let row = map.rooms; row >= 1; row--) {
    let nodes = '';
    let edges = '';
    for (let col = 0; col < COLS; col++) {
      const cell = cellOf(row, col);
      nodes += ` ${ROOM_CODES[map.type[cell]]}  `;
      const m = map.down[cell];
      edges += `${m & 1 ? '/' : ' '}${m & 2 ? '|' : ' '}${m & 4 ? '\\' : ' '} `;
    }
    lines.push(`${String(row).padStart(2)} ${nodes.trimEnd()}`);
    if (row > 1) lines.push(`   ${edges.trimEnd()}`);
  }
  lines.push(' '.repeat(START_COL * 4 + 1) + 'A');
  return lines.join('\n');
}
