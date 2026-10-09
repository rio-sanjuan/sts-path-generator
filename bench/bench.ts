// Throughput benchmarks. Run: npm run bench (Node 23+ runs the TypeScript directly).

import { countRange, countRoutes, solveRoute } from '../src/analysis.ts';
import { collectStats, findMaps, forEachMap } from '../src/batch.ts';
import { resolveConfig, type GenConfig } from '../src/config.ts';
import { compileConstraints } from '../src/constraints.ts';
import { MapGenerator, type TraceEvent } from '../src/generator.ts';
import { createMap } from '../src/map.ts';
import { Room, type GenerateOptions } from '../src/types.ts';

const N = Number(process.env.N ?? 20_000);

function time(label: string, count: number, fn: () => void): number {
  fn(); // warm up the JIT on the same work
  const t0 = performance.now();
  fn();
  const ms = performance.now() - t0;
  const us = (ms * 1000) / count;
  console.log(`${label.padEnd(44)} ${us.toFixed(1).padStart(7)} µs/map  ${Math.round(count / (ms / 1000)).toLocaleString().padStart(9)} maps/s`);
  return us;
}

function generate(options: GenerateOptions, label: string) {
  const config = resolveConfig(options);
  const gen = new MapGenerator();
  time(label, N, () => forEachMap(config, { seed: 1, count: N, generator: gen }, () => {}));
}

console.log(`${N.toLocaleString()} maps per row\n`);
console.log('— generation —');
generate({ act: 'overgrowth' }, 'overgrowth (full)');
generate({ act: 'hive' }, 'hive (full)');
generate({ act: 'glory', ascension: 10 }, 'glory A10 (full)');
generate({ rules: { prune: false } }, 'overgrowth, no pruning');
generate({ rules: { layout: false } }, 'overgrowth, no layout');
generate({ rules: { prune: false, layout: false } }, 'overgrowth, carve + assign only');

{
  const config = resolveConfig({});
  const gen = new MapGenerator();
  time('overgrowth with trace (1/10 the maps)', N / 10, () => {
    for (let s = 1; s <= N / 10; s++) gen.generate(config, s, undefined, [] as TraceEvent[]);
  });
}

// Per-map worst case: the duplicate search walks every route out of every fork.
{
  const config = resolveConfig({});
  const gen = new MapGenerator();
  const out = createMap(config.rooms);
  let worst = 0;
  let worstSeed = 0;
  let maxIters = 0;
  const times: number[] = [];
  for (let s = 1; s <= N; s++) {
    const t0 = performance.now();
    gen.generate(config, s, out);
    const dt = performance.now() - t0;
    times.push(dt);
    if (dt > worst) [worst, worstSeed] = [dt, s];
    if (gen.pruneIterations > maxIters) maxIters = gen.pruneIterations;
  }
  times.sort((a, b) => a - b);
  const pct = (p: number) => (times[Math.floor(p * (times.length - 1))] * 1000).toFixed(0);
  console.log(`latency p50 ${pct(0.5)} µs, p99 ${pct(0.99)} µs, max ${(worst * 1000).toFixed(0)} µs (seed ${worstSeed}); max prune iterations ${maxIters}`);
}

console.log('\n— analysis (per map, on pre-generated maps) —');
{
  const config = resolveConfig({});
  const maps = Array.from({ length: 2000 }, (_, i) => new MapGenerator().generate(config, i + 1));
  const each = (label: string, fn: (m: (typeof maps)[number]) => unknown) =>
    time(label, maps.length, () => {
      for (const m of maps) fn(m);
    });
  each('countRoutes', countRoutes);
  each('countRange (elites)', (m) => countRange(m, { type: Room.Elite }));
  each('solveRoute: ≥2 shops, 0 elites before row 9', (m) =>
    solveRoute(m, { terms: [{ type: Room.Shop, min: 2 }, { type: Room.Elite, max: 0, toRow: 8 }] }),
  );
  each('solveRoute: max elites (scored)', (m) => solveRoute(m, { score: (t) => (t === Room.Elite ? 1 : 0) }));
}

console.log('\n— finder and stats (generation included) —');
function find(label: string, config: GenConfig, constraints: Parameters<typeof compileConstraints>[0]) {
  const predicate = compileConstraints(constraints);
  let result = { tried: 0, seeds: [] as number[] };
  const us = time(label, N, () => {
    result = findMaps(config, predicate, { seed: 1, count: N });
  });
  console.log(`${''.padEnd(44)} matched ${result.seeds.length} of ${result.tried} (${((100 * result.seeds.length) / result.tried).toFixed(2)}%), ${us.toFixed(1)} µs/map`);
}
find('some route: ≥2 shops, 0 elites before treasure', resolveConfig({}), [
  { kind: 'someRoute', terms: [{ type: Room.Shop, min: 2 }, { type: Room.Elite, max: 0, toRow: 8 }] },
]);
find('every route ≥3 elites (A10)', resolveConfig({ ascension: 10 }), [{ kind: 'everyRoute', terms: [{ type: Room.Elite, min: 3 }] }]);
{
  const config = resolveConfig({});
  time('collectStats', N, () => collectStats(config, { seed: 1, count: N }));
}
