// A message protocol for running batches in Web Workers. The page splits a
// job into chunks of seeds, posts one request per chunk to a pool of workers,
// and merges the results, so progress streams in and a job can be cancelled
// between chunks. `handleRequest` is pure; worker-entry.ts wires it to a worker.

import { collectStats, findMaps, type FindResult, type MapStatsData } from './batch.ts';
import { resolveConfig, type GenConfig } from './config.ts';
import { compileConstraints, type Constraint, type MapPredicate } from './constraints.ts';
import { MapGenerator } from './generator.ts';
import type { GenerateOptions } from './types.ts';

export type WorkerRequest =
  | {
      id: number;
      kind: 'find';
      options: GenerateOptions;
      constraints: Constraint[];
      seed: number;
      count: number;
      /** Stop the chunk after this many matches. */
      limit?: number;
    }
  | { id: number; kind: 'stats'; options: GenerateOptions; seed: number; count: number };

export type WorkerResponse =
  | { id: number; kind: 'find'; result: FindResult; ms: number }
  | { id: number; kind: 'stats'; result: MapStatsData; ms: number }
  | { id: number; kind: 'error'; message: string };

const generator = new MapGenerator();
// Chunks of one job repeat the same options and constraints; compile them once.
let lastOptions = '';
let lastConfig: GenConfig | null = null;
let lastConstraints = '';
let lastPredicate: MapPredicate | null = null;

function configFor(options: GenerateOptions): GenConfig {
  const key = JSON.stringify(options);
  if (key !== lastOptions || !lastConfig) {
    lastConfig = resolveConfig(options);
    lastOptions = key;
  }
  return lastConfig;
}

function predicateFor(constraints: Constraint[]): MapPredicate {
  const key = JSON.stringify(constraints);
  if (key !== lastConstraints || !lastPredicate) {
    lastPredicate = compileConstraints(constraints);
    lastConstraints = key;
  }
  return lastPredicate;
}

export function handleRequest(req: WorkerRequest): WorkerResponse {
  const t0 = performance.now();
  try {
    const config = configFor(req.options);
    if (req.kind === 'find') {
      const result = findMaps(config, predicateFor(req.constraints), {
        seed: req.seed,
        count: req.count,
        limit: req.limit,
        generator,
      });
      return { id: req.id, kind: 'find', result, ms: performance.now() - t0 };
    }
    const result = collectStats(config, { seed: req.seed, count: req.count, generator });
    return { id: req.id, kind: 'stats', result, ms: performance.now() - t0 };
  } catch (error) {
    return { id: req.id, kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

/** The buffers in a response, to transfer instead of copy. */
export function transferables(res: WorkerResponse): ArrayBuffer[] {
  if (res.kind !== 'stats') return [];
  const s = res.result;
  return [s.cellTypes, s.nodes, s.edges, s.typeCounts, s.routesLog2, s.pruneIterations].map((a) => a.buffer as ArrayBuffer);
}
