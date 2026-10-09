// Room types, acts, and the rules the generator follows.

/** A map node's room type. 0 means "no node in this cell". */
export const Room = {
  Empty: 0,
  Monster: 1,
  Elite: 2,
  Rest: 3,
  Shop: 4,
  Treasure: 5,
  Unknown: 6,
  Ancient: 7,
  Boss: 8,
  /** A node whose type isn't decided yet. Appears only in trace snapshots, never in finished maps. */
  Unassigned: 9,
} as const;
export type Room = (typeof Room)[keyof typeof Room];

export const ROOM_NAMES = [
  'empty',
  'monster',
  'elite',
  'rest',
  'shop',
  'treasure',
  'unknown',
  'ancient',
  'boss',
  'unassigned',
] as const satisfies readonly string[];

/** The six types a grid node can hold (everything but empty, start, and boss). */
export const GRID_ROOMS = [
  Room.Monster,
  Room.Elite,
  Room.Rest,
  Room.Shop,
  Room.Treasure,
  Room.Unknown,
] as const;

/** One-letter codes for compact text maps, matching the room order. */
export const ROOM_CODES = '.MERST?ABo';

/** How many rest sites an act asks for (beyond its fixed rest row). */
export type RestCount =
  | { kind: 'gaussian'; mean: number; sd: number; min: number; max: number }
  | { kind: 'uniform'; min: number; max: number };

export interface ActConfig {
  id: ActId;
  name: string;
  /** Position in the run (0-based). Picks the map stream, and the last act gets the double boss. */
  index: number;
  /** Grid rows, i.e. rooms between the Ancient and the boss (single player). */
  rooms: number;
  rests: RestCount;
  /** Added to the standard `?` count (Gaussian μ12 σ1 in [10, 14]). */
  unknownOffset: number;
}

export type ActId = 'overgrowth' | 'underdocks' | 'hive' | 'glory';

// From each act's `GetMapPointTypes` and `BaseNumberOfRooms` in the game.
export const ACTS: Record<ActId, ActConfig> = {
  overgrowth: {
    id: 'overgrowth',
    name: 'Overgrowth',
    index: 0,
    rooms: 15,
    rests: { kind: 'gaussian', mean: 7, sd: 1, min: 6, max: 7 },
    unknownOffset: 0,
  },
  underdocks: {
    id: 'underdocks',
    name: 'Underdocks',
    index: 0,
    rooms: 15,
    rests: { kind: 'gaussian', mean: 7, sd: 1, min: 6, max: 7 },
    unknownOffset: 0,
  },
  hive: {
    id: 'hive',
    name: 'Hive',
    index: 1,
    rooms: 14,
    rests: { kind: 'gaussian', mean: 6, sd: 1, min: 6, max: 7 },
    unknownOffset: -1,
  },
  glory: {
    id: 'glory',
    name: 'Glory',
    index: 2,
    rooms: 13,
    rests: { kind: 'uniform', min: 5, max: 6 },
    unknownOffset: -1,
  },
};

/**
 * Every switch in the generator. The defaults are the game's behavior; the
 * rest exist to show what each rule does.
 */
export interface Rules {
  /** Random paths carved from row 1 to the top. Game: 7 (STS1 used 6). */
  paths: number;
  /** The second path must start in a different column from the first. */
  distinctStarts: boolean;
  /** A step may not cross an existing diagonal edge. */
  noCrossing: boolean;
  /** 'sts2': fixed counts per act. 'sts1': counts as a share of the nodes, STS1-style. */
  quotas: 'sts2' | 'sts1';
  /** No Elite or Rest Site in rows 1–5. */
  noEarlyEliteOrRest: boolean;
  /** No Rest Site in the two rows below the fixed rest row. */
  noRestBeforeRestRow: boolean;
  /** Elite, Rest, Treasure and Shop never directly follow themselves. */
  noRepeats: boolean;
  /** Children of the same parent never share a type (Rest, Unknown, Elite, Shop). */
  distinctSiblings: boolean;
  /** Remove duplicate branches: two routes between the same fork and merge with the same rooms. */
  prune: boolean;
  /** Center, spread, and straighten the drawing. Changes columns only, never the graph. */
  layout: boolean;
}

export const DEFAULT_RULES: Readonly<Rules> = {
  paths: 7,
  distinctStarts: true,
  noCrossing: true,
  quotas: 'sts2',
  noEarlyEliteOrRest: true,
  noRestBeforeRestRow: true,
  noRepeats: true,
  distinctSiblings: true,
  prune: true,
  layout: true,
};

/** A user-placed room type, for designing maps. */
export interface Pin {
  row: number;
  col: number;
  type: Room;
}

/** Hand-made structure the generator must keep (direction: "design your own map"). */
export interface Design {
  /**
   * Paths drawn by hand: each is the column for rows 1..rooms (one entry per
   * row, steps of at most one column). They are carved before the random
   * paths, and their nodes and edges are never pruned.
   */
  paths?: readonly (readonly number[])[];
  /** Fixed room types. Pins on cells no path reaches are ignored. Pinned nodes are never pruned. */
  pins?: readonly Pin[];
}

export interface GenerateOptions {
  act?: ActId;
  /** 0–10. A1+ has 8 elites instead of 5; A10 gives the last act a second boss. */
  ascension?: number;
  /** Override the act's height (grid rows). 8–17. */
  rooms?: number;
  rules?: Partial<Rules>;
  design?: Design;
}

/** Room-type targets drawn for one map. */
export interface Quotas {
  rests: number;
  shops: number;
  elites: number;
  unknowns: number;
}
