// Generating many maps: the finder, statistics, and benchmarks. A batch reuses
// one generator and one output map, so it allocates nothing per map. Matches
// are reported by seed (a map is cheap to regenerate), which keeps results
// small enough to post from a worker.

import { countRoutes, edgeCount } from './analysis.ts';
import type { GenConfig } from './config.ts';
import type { MapPredicate } from './constraints.ts';
import { MapGenerator } from './generator.ts';
import { cellCount, COLS, createMap, type StsMap } from './map.ts';

export interface BatchOptions {
  /** First seed; the batch uses consecutive seeds from here. */
  seed: number;
  count: number;
  generator?: MapGenerator;
}

/** Generate `count` maps, calling `visit` on each (the map is reused: clone it to keep it). Return false to stop. */
export function forEachMap(
  config: GenConfig,
  { seed, count, generator = new MapGenerator() }: BatchOptions,
  visit: (map: StsMap, seed: number) => boolean | void,
): number {
  let map = createMap(config.rooms);
  for (let i = 0; i < count; i++) {
    const s = (seed + i) >>> 0;
    map = generator.generate(config, s, map);
    if (visit(map, s) === false) return i + 1;
  }
  return count;
}

export interface FindResult {
  /** Maps generated. */
  tried: number;
  /** Seeds whose maps passed, in order. */
  seeds: number[];
}

/** Seeds of maps that pass `predicate`, stopping after `limit` matches. */
export function findMaps(config: GenConfig, predicate: MapPredicate, options: BatchOptions & { limit?: number }): FindResult {
  const seeds: number[] = [];
  const limit = options.limit ?? Infinity;
  const tried = forEachMap(config, options, (map, s) => {
    if (predicate(map)) seeds.push(s);
    return seeds.length < limit;
  });
  return { tried, seeds };
}

const TYPES = 10;
const HIST = 64;

/**
 * Aggregate statistics over many maps of one config: how often each cell
 * holds each room type (heatmaps), and histograms of per-map counts. Plain
 * typed arrays, so workers can post them and the page can merge them.
 */
export interface MapStatsData {
  rooms: number;
  maps: number;
  /** [cell * 10 + type]: maps with that type at that cell. */
  cellTypes: Uint32Array;
  /** [n]: maps with n grid nodes. */
  nodes: Uint32Array;
  /** [n]: maps with n grid edges. */
  edges: Uint32Array;
  /** [type * 64 + n]: maps with n rooms of that type. */
  typeCounts: Uint32Array;
  /** [floor(log2(routes))]: maps by route count, in powers of two. */
  routesLog2: Uint32Array;
  /** Sum of route counts, for the mean. */
  routesSum: number;
  /** [n]: maps whose pruning took n iterations (only when collected from a generator). */
  pruneIterations: Uint32Array;
}

export function createStats(rooms: number): MapStatsData {
  return {
    rooms,
    maps: 0,
    cellTypes: new Uint32Array(cellCount(rooms) * TYPES),
    nodes: new Uint32Array(HIST * 2),
    edges: new Uint32Array(HIST * 2),
    typeCounts: new Uint32Array(TYPES * HIST),
    routesLog2: new Uint32Array(HIST),
    routesSum: 0,
    pruneIterations: new Uint32Array(HIST * 3),
  };
}

const typeTally = new Int32Array(TYPES);

export function addToStats(stats: MapStatsData, map: StsMap, pruneIterations = 0): void {
  if (map.rooms !== stats.rooms) throw new Error(`Stats are for ${stats.rooms} rows, map has ${map.rooms}`);
  stats.maps++;
  typeTally.fill(0);
  let nodes = 0;
  const end = (map.rooms + 1) * COLS;
  for (let cell = COLS; cell < end; cell++) {
    const t = map.type[cell];
    if (t === 0) continue;
    nodes++;
    typeTally[t]++;
    stats.cellTypes[cell * TYPES + t]++;
  }
  stats.nodes[nodes]++;
  stats.edges[Math.min(edgeCount(map), stats.edges.length - 1)]++;
  for (let t = 1; t < TYPES; t++) stats.typeCounts[t * HIST + Math.min(typeTally[t], HIST - 1)]++;
  const routes = countRoutes(map);
  stats.routesSum += routes;
  stats.routesLog2[Math.min(Math.floor(Math.log2(routes)), HIST - 1)]++;
  stats.pruneIterations[Math.min(pruneIterations, stats.pruneIterations.length - 1)]++;
}

export function mergeStats(into: MapStatsData, from: MapStatsData): void {
  if (into.rooms !== from.rooms) throw new Error('Cannot merge stats for different map heights');
  into.maps += from.maps;
  into.routesSum += from.routesSum;
  const add = (a: Uint32Array, b: Uint32Array) => {
    for (let i = 0; i < a.length; i++) a[i] += b[i];
  };
  add(into.cellTypes, from.cellTypes);
  add(into.nodes, from.nodes);
  add(into.edges, from.edges);
  add(into.typeCounts, from.typeCounts);
  add(into.routesLog2, from.routesLog2);
  add(into.pruneIterations, from.pruneIterations);
}

/** Statistics over `count` maps from consecutive seeds. */
export function collectStats(config: GenConfig, options: BatchOptions): MapStatsData {
  const generator = options.generator ?? new MapGenerator();
  const stats = createStats(config.rooms);
  forEachMap(config, { ...options, generator }, (map) => addToStats(stats, map, generator.pruneIterations));
  return stats;
}

/** Mean of a histogram. */
export function histogramMean(hist: Uint32Array, offset = 0, length = hist.length - offset): number {
  let n = 0;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    n += hist[offset + i];
    sum += i * hist[offset + i];
  }
  return n === 0 ? 0 : sum / n;
}

/** Mean count of a room type per map. */
export function meanRooms(stats: MapStatsData, type: number): number {
  return histogramMean(stats.typeCounts, type * HIST, HIST);
}
