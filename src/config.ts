// Turns user-facing options into a validated config. Batch callers resolve
// once and generate many maps from the same config.

import { COLS, MAX_ROOMS, MIN_ROOMS } from './map.ts';
import {
  ACTS,
  DEFAULT_RULES,
  GRID_ROOMS,
  type ActConfig,
  type GenerateOptions,
  type Pin,
  type Rules,
} from './types.ts';

export interface GenConfig {
  act: ActConfig;
  ascension: number;
  rooms: number;
  rules: Rules;
  /** Elites dealt per map (5, or 8 from A1's Swarming Elites). */
  elites: number;
  shops: number;
  /** STS1-style elite share (8%, ×1.6 from A1). Used when `rules.quotas` is 'sts1'. */
  sts1EliteShare: number;
  secondBoss: boolean;
  designPaths: Int8Array[];
  pins: Pin[];
}

/** A1 "Swarming Elites" multiplies the elite count by 1.6 (5 → 8), as STS1's A1 did. */
const SWARMING_ELITES = 1.6;
const DOUBLE_BOSS_ASCENSION = 10;

export function resolveConfig(options: GenerateOptions = {}): GenConfig {
  const act = ACTS[options.act ?? 'overgrowth'];
  if (!act) throw new Error(`Unknown act: ${String(options.act)}`);
  const ascension = options.ascension ?? 0;
  if (!Number.isInteger(ascension) || ascension < 0 || ascension > 10) {
    throw new Error(`Ascension must be an integer from 0 to 10, got ${ascension}`);
  }
  const rooms = options.rooms ?? act.rooms;
  if (!Number.isInteger(rooms) || rooms < MIN_ROOMS || rooms > MAX_ROOMS) {
    throw new Error(`Rooms must be an integer from ${MIN_ROOMS} to ${MAX_ROOMS}, got ${rooms}`);
  }
  const rules: Rules = { ...DEFAULT_RULES, ...options.rules };
  if (!Number.isInteger(rules.paths) || rules.paths < 0 || rules.paths > 20) {
    throw new Error(`Paths must be an integer from 0 to 20, got ${rules.paths}`);
  }
  const swarm = ascension >= 1 ? SWARMING_ELITES : 1;

  const designPaths = (options.design?.paths ?? []).map((cols, i) => {
    if (cols.length !== rooms) {
      throw new Error(`Design path ${i} has ${cols.length} columns; it needs one per row (${rooms})`);
    }
    for (let r = 0; r < cols.length; r++) {
      const c = cols[r];
      if (!Number.isInteger(c) || c < 0 || c >= COLS) throw new Error(`Design path ${i}: column ${c} at row ${r + 1}`);
      if (r > 0 && Math.abs(c - cols[r - 1]) > 1) {
        throw new Error(`Design path ${i}: rows ${r} to ${r + 1} jump more than one column`);
      }
    }
    return Int8Array.from(cols);
  });
  if (rules.paths + designPaths.length === 0) throw new Error('A map needs at least one path');

  const pins = (options.design?.pins ?? []).map((pin) => {
    if (!Number.isInteger(pin.row) || pin.row < 1 || pin.row > rooms) throw new Error(`Pin row ${pin.row} is off the grid`);
    if (!Number.isInteger(pin.col) || pin.col < 0 || pin.col >= COLS) throw new Error(`Pin column ${pin.col} is off the grid`);
    if (!(GRID_ROOMS as readonly number[]).includes(pin.type)) throw new Error(`Pin type ${pin.type} can't go on the grid`);
    return { ...pin };
  });

  return {
    act,
    ascension,
    rooms,
    rules,
    elites: Math.round(5 * swarm),
    shops: 3,
    sts1EliteShare: 0.08 * swarm,
    secondBoss: act.index === 2 && ascension >= DOUBLE_BOSS_ASCENSION,
    designPaths,
    pins,
  };
}
