// Seeded randomness for the generator.
//
// The game draws from xoshiro256** (64-bit). Matching it bit for bit would mean
// BigInt or paired-32-bit arithmetic on every draw, and seed-exact maps also
// depend on .NET HashSet enumeration order, so this engine is faithful to the
// game's *rules and distributions*, not to its seeds. xoshiro128** keeps every
// draw in 32-bit integer math, which JS engines run fast.

/** splitmix32 step: spreads a 32-bit seed into well-mixed state words. */
function splitmix32(state: number): number {
  state = (state + 0x9e3779b9) | 0;
  let z = state;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

/** FNV-1a over UTF-16 code units with a murmur3 finalizer. Stable across platforms. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A seed as a uint32: a raw number, an all-digit string (the same number, so
 * seeds the finder reports can be typed back in), or a run seed as the game
 * shows it (e.g. "TBL5VNYN4M"), hashed.
 */
export function seedValue(seed: number | string): number {
  if (typeof seed === 'number') return seed >>> 0;
  const s = seed.trim().toUpperCase();
  return /^\d{1,10}$/.test(s) && Number(s) <= 0xffffffff ? Number(s) : hashString(s);
}

/**
 * The seed of one act's map stream. Like the game's named streams
 * (`seed + hash("act_1_map")`), each act's map is independent of the others
 * and of anything that happens earlier in the run.
 */
export function actStreamSeed(runSeed: number, actIndex: number): number {
  return (runSeed + hashString(`act_${actIndex + 1}_map`)) >>> 0;
}

const INV_2_32 = 1 / 4294967296;

export class Rng {
  private s0 = 0;
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;

  constructor(seed = 0) {
    this.reseed(seed);
  }

  reseed(seed: number): void {
    let x = seed >>> 0;
    this.s0 = splitmix32(x);
    x = (x + 0x9e3779b9) | 0;
    this.s1 = splitmix32(x);
    x = (x + 0x9e3779b9) | 0;
    this.s2 = splitmix32(x);
    x = (x + 0x9e3779b9) | 0;
    this.s3 = splitmix32(x);
    // All-zero state is the one bad state for xoshiro.
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Next uint32 (xoshiro128**). */
  u32(): number {
    const s0 = this.s0;
    const s1 = this.s1;
    const s2 = this.s2;
    const s3 = this.s3;
    const m = Math.imul(s1, 5);
    const result = Math.imul((m << 7) | (m >>> 25), 9);
    const t = s1 << 9;
    const n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    this.s1 = s1 ^ n2;
    this.s0 = s0 ^ n3;
    this.s2 = n2 ^ t;
    this.s3 = (n3 << 11) | (n3 >>> 21);
    return result >>> 0;
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.u32() * INV_2_32;
  }

  /** Uniform integer in [0, n). Scaled from the draw like the game's `NextInt`, not a modulo. */
  int(n: number): number {
    return (this.u32() * INV_2_32 * n) | 0;
  }

  /**
   * The game's `NextGaussianInt`: Box–Muller, rounded, and *redrawn* (not
   * clamped) until it lands in [min, max].
   */
  gaussianInt(mean: number, sd: number, min: number, max: number): number {
    for (;;) {
      const d = 1 - this.float();
      const u = 1 - this.float();
      const z = Math.sqrt(-2 * Math.log(d)) * Math.sin(2 * Math.PI * u);
      const n = Math.round(mean + sd * z);
      if (n >= min && n <= max) return n;
    }
  }

  /** Fisher–Yates over the first `len` items, from the back, like the game's `Shuffle`. */
  shuffle(items: { [i: number]: number }, len: number): void {
    for (let i = len - 1; i > 0; i--) {
      const j = (this.u32() * INV_2_32 * (i + 1)) | 0;
      const t = items[i];
      items[i] = items[j];
      items[j] = t;
    }
  }
}
