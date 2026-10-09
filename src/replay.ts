// Turns a generation trace into frames for animating it: one frame per
// visible step, each a full copy of the map so far (a few hundred bytes), so a
// player can jump to any frame without replaying.
//
// Nodes keep one identity throughout: their cell before layout. Edges are
// stored the generator's way (3-bit masks in that cell space), and layout only
// changes each node's column, so the picture can animate nodes sliding sideways.

import type { TraceEvent } from './generator.ts';
import { cellCount, COLS } from './map.ts';
import { Room } from './types.ts';

/** What part of the algorithm a frame shows. */
export type Stage = 'start' | 'quotas' | 'carve' | 'assign' | 'prune' | 'layout' | 'done';

export const STAGES: readonly Stage[] = ['start', 'quotas', 'carve', 'assign', 'prune', 'layout', 'done'];

export interface ReplayState {
  rooms: number;
  /** Room type per node (indexed by the node's pre-layout cell); 0 where there's no node. */
  type: Uint8Array;
  /** Edges up from each node: bit d means an edge to node `id + COLS - 1 + d`. */
  up: Uint8Array;
  /** Each node's current column. Equal to `id % COLS` until layout moves it. */
  col: Int8Array;
}

export interface Frame {
  stage: Stage;
  /** Index of the trace event this frame shows, or -1 for the first and last frames. */
  event: number;
  state: ReplayState;
  /** Room types left in the deck during assignment, indexed by `Room`. */
  deck: number[];
  /** Nodes to highlight: the path being carved, the rooms just typed, the nodes that moved. */
  focus: number[];
  /** For a path frame: which path, and whether it was drawn by hand. */
  path?: { index: number; designed: boolean; step: number };
  /** For a duplicates frame: the routes (node ids, fork to merge) in the order pruning tries them. */
  routes?: number[][];
  /** Something that just disappeared, to fade out where it was. */
  gone?: { node: number; type: Room; col: number } | { from: number; to: number };
}

function emptyState(rooms: number): ReplayState {
  const n = cellCount(rooms);
  const col = new Int8Array(n);
  for (let i = 0; i < n; i++) col[i] = i % COLS;
  return { rooms, type: new Uint8Array(n), up: new Uint8Array(n), col };
}

function copy(state: ReplayState): ReplayState {
  return { rooms: state.rooms, type: state.type.slice(), up: state.up.slice(), col: state.col.slice() };
}

/** The map height a trace was generated with (from its phase snapshots). */
export function traceRooms(trace: readonly TraceEvent[]): number {
  for (const e of trace) if (e.kind === 'phase') return e.map.rooms;
  throw new Error('The trace has no phase snapshots');
}

export function buildFrames(trace: readonly TraceEvent[]): Frame[] {
  const rooms = traceRooms(trace);
  const frames: Frame[] = [];
  const st = emptyState(rooms);
  const deck = new Array<number>(10).fill(0);
  const push = (stage: Stage, event: number, extra: Partial<Frame> = {}) =>
    frames.push({ stage, event, state: copy(st), deck: deck.slice(), focus: [], ...extra });

  push('start', -1);
  for (let i = 0; i < trace.length; i++) {
    const e = trace[i];
    switch (e.kind) {
      case 'quotas':
        deck.fill(0);
        deck[Room.Rest] = e.quotas.rests;
        deck[Room.Shop] = e.quotas.shops;
        deck[Room.Elite] = e.quotas.elites;
        deck[Room.Unknown] = e.quotas.unknowns;
        push('quotas', i);
        break;
      case 'path':
        for (let k = 0; k < e.cells.length; k++) {
          const cell = e.cells[k];
          if (st.type[cell] === Room.Empty) st.type[cell] = Room.Unassigned;
          if (k > 0) {
            const prev = e.cells[k - 1];
            st.up[prev] |= 1 << ((cell % COLS) - (prev % COLS) + 1);
          }
          push('carve', i, { focus: e.cells.slice(0, k + 1), path: { index: e.index, designed: e.designed, step: k } });
        }
        break;
      case 'fixed':
        for (const cell of e.cells) st.type[cell] = e.type;
        push('assign', i, { focus: e.cells });
        break;
      case 'pin':
        st.type[e.cell] = e.type;
        if (deck[e.type] > 0) deck[e.type]--;
        push('assign', i, { focus: [e.cell] });
        break;
      case 'assign':
        st.type[e.cell] = e.type;
        deck[e.type]--;
        push('assign', i, { focus: [e.cell] });
        break;
      case 'fill':
        for (const cell of e.cells) st.type[cell] = Room.Monster;
        push('assign', i, { focus: e.cells });
        break;
      case 'duplicates':
        push('prune', i, { routes: e.routes, focus: e.routes.flat() });
        break;
      case 'remove': {
        const gone = { node: e.cell, type: st.type[e.cell] as Room, col: st.col[e.cell] };
        removeNode(st, e.cell);
        push('prune', i, { gone });
        break;
      }
      case 'cut':
        st.up[e.from] &= ~(1 << ((e.to % COLS) - (e.from % COLS) + 1));
        push('prune', i, { gone: { from: e.from, to: e.to } });
        break;
      case 'repair':
        st.type[e.cell] = e.type;
        push('prune', i, { focus: [e.cell] });
        break;
      case 'move': {
        st.col[e.node] = e.to;
        // Centering shifts every node at once: one frame for the lot.
        const next = trace[i + 1];
        if (e.step === 'center' && next?.kind === 'move' && next.step === 'center') break;
        const focus = e.step === 'center' ? movedTogether(trace, i) : [e.node];
        push('layout', i, { focus });
        break;
      }
      case 'phase':
        break;
    }
  }
  push('done', -1);
  return frames;
}

function removeNode(st: ReplayState, cell: number): void {
  st.type[cell] = Room.Empty;
  st.up[cell] = 0;
  for (let d = 0; d < 3; d++) {
    const parent = cell - COLS - 1 + d;
    if (parent >= 0) st.up[parent] &= ~(1 << (2 - d));
  }
}

/** The nodes of the run of center moves ending at event `last`. */
function movedTogether(trace: readonly TraceEvent[], last: number): number[] {
  const out: number[] = [];
  for (let i = last; i >= 0; i--) {
    const e = trace[i];
    if (e.kind !== 'move' || e.step !== 'center') break;
    out.push(e.node);
  }
  return out;
}

/** The first frame of each stage, for jumping to it. */
export function stageStarts(frames: readonly Frame[]): Partial<Record<Stage, number>> {
  const out: Partial<Record<Stage, number>> = {};
  frames.forEach((f, i) => {
    if (out[f.stage] === undefined) out[f.stage] = i;
  });
  return out;
}

/** Each node's grid neighbors as (row, col) pairs, for comparing a frame with a map. */
export function stateEdges(st: ReplayState): string[] {
  const out: string[] = [];
  for (let id = 0; id < st.type.length; id++) {
    const m = st.up[id];
    for (let d = 0; d < 3; d++) {
      if (!(m & (1 << d))) continue;
      const child = id + COLS - 1 + d;
      out.push(`${(id / COLS) | 0},${st.col[id]}>${(child / COLS) | 0},${st.col[child]}`);
    }
  }
  return out.sort();
}
