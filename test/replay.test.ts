import { describe, expect, it } from 'vitest';
import { generateMap, type TraceEvent } from '../src/generator.ts';
import { COLS, type StsMap } from '../src/map.ts';
import { buildFrames, stageStarts, stateEdges, type ReplayState } from '../src/replay.ts';
import { ACTS, Room, type ActId } from '../src/types.ts';

/** A map's nodes and edges by (row, col), comparable with a replay state. */
function mapPicture(map: StsMap): { nodes: string[]; edges: string[] } {
  const nodes: string[] = [];
  const edges: string[] = [];
  for (let cell = COLS; cell < (map.rooms + 1) * COLS; cell++) {
    if (map.type[cell] === Room.Empty) continue;
    const row = (cell / COLS) | 0;
    const col = cell % COLS;
    nodes.push(`${row},${col}:${map.type[cell]}`);
    for (let d = 0; d < 3; d++) if (map.up[cell] & (1 << d)) edges.push(`${row},${col}>${row + 1},${col + d - 1}`);
  }
  return { nodes: nodes.sort(), edges: edges.sort() };
}

function statePicture(st: ReplayState): { nodes: string[]; edges: string[] } {
  const nodes: string[] = [];
  for (let id = 0; id < st.type.length; id++) {
    if (st.type[id] !== Room.Empty) nodes.push(`${(id / COLS) | 0},${st.col[id]}:${st.type[id]}`);
  }
  return { nodes: nodes.sort(), edges: stateEdges(st) };
}

describe('replay', () => {
  for (const act of Object.keys(ACTS) as ActId[]) {
    it(`${act}: frames reproduce every phase snapshot and the final map`, () => {
      for (let seed = 1; seed <= 40; seed++) {
        const trace: TraceEvent[] = [];
        const map = generateMap(seed, { act, ascension: seed % 2 ? 10 : 0 }, trace);
        const frames = buildFrames(trace);
        const last = frames[frames.length - 1];
        expect(statePicture(last.state)).toEqual(mapPicture(map));

        // The last frame of each stage matches that phase's snapshot.
        for (const e of trace) {
          if (e.kind !== 'phase') continue;
          const stage = e.phase;
          const lastOfStage = frames.filter((f) => f.stage === stage).at(-1);
          if (!lastOfStage) continue; // e.g. no duplicates to prune
          expect(statePicture(lastOfStage.state), `${act} seed ${seed} ${stage}`).toEqual(mapPicture(e.map));
        }
      }
    });
  }

  it('deals the deck down during assignment and orders stages', () => {
    const trace: TraceEvent[] = [];
    generateMap(7, {}, trace);
    const frames = buildFrames(trace);
    const starts = stageStarts(frames);
    expect(Object.keys(starts)).toEqual(['start', 'quotas', 'carve', 'assign', 'prune', 'layout', 'done']);
    const quotas = frames[starts.quotas!];
    expect(quotas.deck[Room.Shop]).toBe(3);
    const assigned = frames[starts.prune! - 1];
    // Everything dealt that found a valid room has left the deck.
    const placed = (t: number) => [...assigned.state.type].filter((x) => x === t).length;
    expect(quotas.deck[Room.Elite] - assigned.deck[Room.Elite]).toBe(placed(Room.Elite));
    // Frames are independent copies.
    expect(frames[1].state.type).not.toBe(frames[2].state.type);
  });
});
