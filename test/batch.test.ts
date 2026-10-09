import { describe, expect, it } from 'vitest';
import { collectStats, createStats, findMaps, forEachMap, meanRooms, mergeStats } from '../src/batch.ts';
import { resolveConfig } from '../src/config.ts';
import { compileConstraints } from '../src/constraints.ts';
import { MapGenerator } from '../src/generator.ts';
import { mapToString } from '../src/map.ts';
import { Room } from '../src/types.ts';
import { handleRequest } from '../src/worker.ts';

describe('batches', () => {
  const config = resolveConfig({ act: 'hive' });

  it('visits consecutive seeds with a reused map, matching single generation', () => {
    const seen: string[] = [];
    forEachMap(config, { seed: 40, count: 5 }, (map) => {
      seen.push(mapToString(map));
    });
    const gen = new MapGenerator();
    expect(seen).toEqual([40, 41, 42, 43, 44].map((s) => mapToString(gen.generate(config, s))));
  });

  it('finds maps by seed and stops at the limit', () => {
    const predicate = compileConstraints([{ kind: 'rooms', type: Room.Unknown, min: 11 }]);
    const all = findMaps(config, predicate, { seed: 1, count: 300 });
    expect(all.tried).toBe(300);
    const gen = new MapGenerator();
    for (const s of all.seeds) expect(predicate(gen.generate(config, s))).toBe(true);
    const some = findMaps(config, predicate, { seed: 1, count: 300, limit: 3 });
    expect(some.seeds).toEqual(all.seeds.slice(0, 3));
  });

  it('collects and merges statistics', () => {
    const a = collectStats(config, { seed: 1, count: 200 });
    const b = collectStats(config, { seed: 201, count: 200 });
    const both = collectStats(config, { seed: 1, count: 400 });
    const merged = createStats(config.rooms);
    mergeStats(merged, a);
    mergeStats(merged, b);
    expect(merged).toEqual(both);
    expect(both.maps).toBe(400);
    expect(meanRooms(both, Room.Shop)).toBe(3);
    expect(meanRooms(both, Room.Elite)).toBeCloseTo(5, 0);
  });

  it('answers worker requests', () => {
    const find = handleRequest({
      id: 1,
      kind: 'find',
      options: { act: 'hive' },
      constraints: [{ kind: 'someRoute', terms: [{ type: Room.Shop, min: 2 }] }],
      seed: 1,
      count: 100,
    });
    expect(find.kind).toBe('find');
    if (find.kind === 'find') expect(find.result.tried).toBe(100);
    const stats = handleRequest({ id: 2, kind: 'stats', options: { act: 'glory' }, seed: 1, count: 50 });
    expect(stats.kind === 'stats' && stats.result.maps).toBe(50);
    const bad = handleRequest({ id: 3, kind: 'stats', options: { rooms: 2 }, seed: 1, count: 1 });
    expect(bad).toMatchObject({ id: 3, kind: 'error' });
  });
});
