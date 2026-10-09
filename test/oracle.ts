// Slow, obviously-correct reference implementations for tests.

import { bossCell, childrenOf, COLS, parentsOf, rowOf, START, type StsMap } from '../src/map.ts';

/** Every start-to-boss route, start and boss included. */
export function allFullRoutes(map: StsMap): number[][] {
  const out: number[][] = [];
  const boss = bossCell(map);
  const walk = (path: number[]) => {
    const last = path[path.length - 1];
    if (last === boss) {
      out.push(path);
      return;
    }
    for (const c of childrenOf(map, last)) walk([...path, c]);
  };
  walk([START]);
  return out;
}

/**
 * Duplicate segments as the game defines them: two routes from a fork F to a
 * merge M (2+ parents) at least two steps on, through the same room types,
 * sharing no inner node. Returns one description per (F, M, types) that has a pair.
 */
export function findDuplicateSegments(map: StsMap): string[] {
  const routes = allFullRoutes(map);
  const segments = new Map<string, number[][]>();
  for (const route of routes) {
    for (let i = 0; i < route.length; i++) {
      const f = route[i];
      if (f !== START && childrenOf(map, f).length < 2) continue;
      for (let j = i + 2; j < route.length; j++) {
        const m = route[j];
        if (parentsOf(map, m).length < 2) continue;
        const seg = route.slice(i, j + 1);
        const key = `${f}-${m}:${seg.slice(1, -1).map((c) => map.type[c]).join(',')}`;
        const list = segments.get(key) ?? [];
        if (!list.some((s) => s.join() === seg.join())) list.push(seg);
        segments.set(key, list);
      }
    }
  }
  const found: string[] = [];
  for (const [key, list] of segments) {
    let pair = false;
    for (let a = 0; a < list.length && !pair; a++) {
      for (let b = a + 1; b < list.length && !pair; b++) {
        const inner = new Set(list[a].slice(1, -1));
        if (!list[b].slice(1, -1).some((c) => inner.has(c))) pair = true;
      }
    }
    if (pair) found.push(key);
  }
  return found;
}

/** Grid routes (row 1 first) with brute force. */
export function gridRoutes(map: StsMap): number[][] {
  return allFullRoutes(map).map((r) => r.slice(1, -1));
}

export const cellName = (cell: number) => `(${rowOf(cell)},${cell % COLS})`;
