# How Slay the Spire II generates its maps

Research notes, 2026-10-09. Groundwork for a rio-sanjuan.dev post with an interactive constrained-path tool.

## Where this comes from (and how much to trust it)

There is no official write-up of the STS2 map algorithm. The game is Godot 4, but all game logic lives in a C#/.NET 8 assembly (`sts2.dll`) that decompiles cleanly with ILSpy ([spire-codex](https://github.com/ptrlrd/spire-codex) documents that pipeline). The best public source is a port, not prose:

- **[Dominik-O22/sts2-ai](https://github.com/Dominik-O22/sts2-ai), `sim/src/map.rs` and `sim/src/game_rng.rs`** (merged 2026-09-29 in [PR #37](https://github.com/Dominik-O22/sts2-ai/pull/37)). It's a Rust port of the game's `Map/StandardActMap.cs`, `MapPathPruning.cs`, `MapPostProcessing.cs`, `MapPointTypeCounts.cs` and each act's `GetMapPointTypes`. The author checks it against an oracle that runs the game's own DLL: **4,800 of 4,800 maps match point for point** (A0 and A10, every act). Everything in the STS2 section below comes from that port unless noted otherwise.
  - ⚠️ The repo has **no license**. Read it and describe the algorithm, but write our own implementation. Don't copy its code into the blog repo.
  - ⚠️ STS2 is in Early Access, so a patch can change any of this. The port matches the game as of late September 2026.
- Strategy guides ([sts2.gg](https://sts2.gg/guides/map-routing-guide), [untapped](https://sts2.untapped.gg/en/guides/how-to-make-the-best-map-choices-in-slay-the-spire-2)) describe the player's view only: maps are generated up front, rest before the boss, treasure mid-act. They have no algorithm detail.
- For STS1 (useful for comparison): the [wiki](https://slaythespire.wiki.gg/wiki/Map_Generation), a [KosGames guide](https://kosgames.com/slay-the-spire-map-generation-guide-26769/), and [sts_map_oracle](https://github.com/Ru5ty0ne/sts_map_oracle) (an exact Rust copy of the STS1 generator).

---

## The STS2 pipeline at a glance

```
seed ─► map RNG stream "act_N_map"
          │
          ├─ 1. draw room-type quotas      (rests, unknowns; elites & shops fixed)
          ├─ 2. carve 7 random paths       (7-column grid, bottom → top, no crossings)
          ├─ 3. assign room types          (fixed rows, then quota queue + placement rules)
          ├─ 4. prune duplicate segments   (remove redundant "same choice twice" branches)
          │     └─ repair quotas           (turn monsters back into missing types; ≤3 rounds)
          └─ 5. cosmetic layout            (center, spread, straighten; topology unchanged)
```

### Coordinates and dimensions

- **Width:** 7 columns (`_mapWidth = 7`).
- **Height:** each act has a fixed number of rooms:

  | Act | Rooms | Grid rows | Treasure row | Rest row | Boss |
  |---|---|---|---|---|---|
  | Overgrowth / Underdocks (Act 1) | 15 | 1–15 | 9 | 15 | above row 15 |
  | Hive (Act 2) | 14 | 1–14 | 8 | 14 | above row 14 |
  | Glory (Act 3) | 13 | 1–13 | 7 | 13 | above row 13 |

  Multiplayer acts get one room fewer.
- **Row 0 holds one start node, the Ancient** (Neow in Act 1, another Ancient in later acts). It connects to *every* row-1 node, so you can start anywhere. If you start Act 1 without Neow, it becomes a Monster after generation.
- **The Boss is a single node** above the top row, and every top-row node connects to it. At **A10 (Double Boss)** a second boss is chained above the first in the last act.

### RNG (needed only for seed-exact reproduction)

- PRNG: **xoshiro256\*\***, seeded through splitmix64 (`MegaRandom`).
- The seed string (e.g. `TBL5VNYN4M`) is hashed with a deterministic djb2-style hash over UTF-16 units (`StringHelper.GetDeterministicHashCode`). Each subsystem gets its own named stream: `seed + hash("act_1_map")`, etc. The map for Act N therefore never depends on what happened earlier in the run.
- `NextInt(max)` is `floor(nextDouble * max)`, not a modulo. `Shuffle` is Fisher–Yates from the back. `NextGaussianInt` uses Box–Muller with banker's rounding and **redraws** (rather than clamps) until the value lands in [min, max].
- One subtle point: parent/child sets are .NET `HashSet`s, and pruning order depends on their enumeration order. The port reproduces this with a "slot set". Matching seeds exactly is fiddly. Matching the *distribution* is not.

---

## Step 1: Room-type quotas

**This is the biggest conceptual change from STS1.** STS2 does not roll each room against percentages. It draws a target count for each type up front and deals them out like a deck.

| Type | Act 1 | Hive | Glory |
|---|---|---|---|
| Rest sites (excluding the fixed rest row) | Gaussian(μ7, σ1) in [6,7] | Gaussian(μ6, σ1) in [6,7] | uniform 5 or 6 |
| Unknown `?` | Gaussian(μ12, σ1) in [10,14] | that − 1 | that − 1 |
| Shops | 3 | 3 | 3 |
| Elites | 5 (**8** at A1+ "Swarming Elites", round(5 × 1.6)) | same | same |
| Monsters | everything left over | | |

## Step 2: Carving paths

```
repeat 7 times:
    start = random column in row 1          (path 2's start must differ from path 1's)
    walk upward until the top row:
        try steps {-1, 0, +1} in shuffled order
        take the first that doesn't cross an existing edge
        create the target node if it doesn't exist (paths merge freely)
connect every top-row node → Boss; Ancient → every row-1 node
```

- **No-crossing rule:** if you step right from column *c* to *c+1*, the existing node at *(c+1, same row)* must not already have an edge going left to *c* on the row above (and the mirror case for stepping left). Vertical steps never cross.
- **Edge bias (a nice detail for the post):** steps clamp to the grid, so at column 0 the three options are really {0, 0, +1}, and going straight is twice as likely. The same holds at column 6. Paths stick to the walls a bit.
- STS1 used 6 paths. STS2 uses **7**.
- STS1 also had "don't merge too soon after splitting" rules (common-ancestor gap checks) at this stage. **STS2 drops those** and fixes redundant branches later, in Step 4.

## Step 3: Assigning room types

Fixed rows first (these nodes are marked `CanBeModified = false`):

- row 1 → all **Monster**
- treasure row (rows − 7) → all **Treasure**
- top row → all **Rest Site**

Then the quota queue `[rests…, shops…, elites…, unknowns…]` is dealt onto the remaining nodes:

```
up to 3 passes:
    shuffle all still-unassigned nodes
    for each node:
        take the first queued type that is valid here; skipped types go to the back of the queue
        (if none fit, leave the node unassigned for now)
leftover unassigned nodes → Monster
```

**Placement rules** (`IsValidPointType`):

1. **No Elites or Rest Sites in rows 1–5.**
2. **No Rest Site in the two rows just below the fixed rest row.**
3. **No back-to-back repeats** of Elite, Rest, Treasure or Shop: a node can't share one of those types with any parent or child.
4. **Siblings differ:** a node can't share its type with another child of any of its parents. This applies to Rest, Unknown, Elite and Shop. The rule nominally covers Monster too, but monsters are only ever filler, so it never comes into play.

Quotas are therefore *targets*, not guarantees. If a type can't find valid nodes in 3 passes, the map ends up with fewer of it.

## Step 4: Pruning duplicate segments (new in STS2)

This step makes the choices on the map mean something.

- A **segment** is a stretch of path that starts at a fork (a node with 2+ children, or the start) and ends at a merge (a node with 2+ parents) at least two steps later.
- Two segments are **duplicates** when they share both endpoints *and* pass through the same sequence of room types. A fork that offers "Monster → ? → Monster" on both sides is not a real choice.
- For each group of duplicates, the generator shuffles the group and **removes the nodes of all but one segment**. It only removes nodes that wouldn't strand anything, i.e. nodes with a single parent and child on the segment. If no node can be removed, it **cuts an edge** between the fork and the merge instead. This repeats until no duplicates remain (with a hard cap of 50 iterations).
- Removing nodes can push a type under its quota, so a **repair** pass converts modifiable Monsters back into the missing Shops / Elites / Rests / Unknowns, under the same placement rules. Repair can create new duplicates, so prune and repair alternate for **up to 3 rounds**.

## Step 5: Cosmetic layout

These steps only change columns. The graph stays the same, and every edge still goes to column −1, 0 or +1.

- **Center:** if both leftmost columns are empty and the right side isn't (or the reverse), shift everything one column toward the middle.
- **Spread:** row by row, move each node to whichever allowed column (within ±1 of all its parents and children) is farthest from the other nodes in its row. Repeat until nothing moves.
- **Straighten:** a node with one parent and one child that are both on the same side of it moves one column toward them, if that cell is free.

---

## Things that bypass or modify the standard map

- **`?` rooms are not decided at generation.** They're rolled *on entry* from a separate `unknown_map_point` stream (`UnknownMapPointOdds`). Base odds are Monster 10%, Treasure 2%, Shop 3%, and otherwise Event. Elite starts at −100%, which rules it out. Each roll resets the type it landed on to its base value and raises the others by their base. The odds reset every act.
- **Relics can replace the generated map** through a `ModifyGeneratedMap` hook: Golden Compass → `GoldenPathActMap`; Spoils Map → `SpoilsActMap`, an "hourglass" through a single treasure. Fur Coat also edits the map. The port doesn't model these.

## STS1 vs STS2 summary

| | STS1 | STS2 |
|---|---|---|
| Grid | 7 × 15 | 7 wide, 15 / 14 / 13 rows by act |
| Start | any row-1 node | single Ancient node → all row-1 nodes |
| Paths | 6 | 7 |
| Early-merge prevention | during path carving (ancestor-gap checks) | after typing, by pruning duplicate *typed* segments |
| Room mix | percentage-based (Monster 53 / ? 22 / Rest 12 / Elite 8 / Shop 5 per wiki) | fixed counts: 3 shops, 5 (8) elites, ~6–7 rests, ~11–12 `?` |
| Fixed rows | 1 monster, 9 treasure, 15 rest | row 1 monster, rows−7 treasure, top rest |
| Placement rules | no elite/rest below floor 6, no rest on 14, no consecutive, siblings unique | essentially the same rule set |
| A1 / A1-equivalent | elites × 1.6 | elites × 1.6 (Swarming Elites) |
| Final boss | single | double boss in Act 3 at A10 |

---

## Findings from building the engine (2026-10-09)

The engine ([src/generator.ts](../src/generator.ts)) was checked against 201 maps generated by the game's own code. That's the `sim/testdata/oracle-maps.txt` fixture in sts2-ai, kept out of this repo because sts2-ai has no license. Things the source alone doesn't make obvious:

- **"Two distinct starts" doesn't survive pruning.** Path 2 must start in a different column from path 1, but pruning can remove a row-1 node. **5 of 201 game maps (2.5%) have a single starting room**; this engine gives about 1.5%, which is consistent.
- **The rest-site repair almost never fires.** Repair counts *all* rest sites on the grid against the rest quota, including the fixed rest row (4–6 nodes). So it nearly always thinks there are enough. (The engine reproduces this quirk.)
- **Pruning leaves no duplicates in practice:** 0 of 201 game maps and 0 of 6,000 engine maps have a duplicate branch left. In principle the last repair round could re-create one.
- **Pruning is where all the cost is.** Listing every route and every fork-to-merge segment, as the game does, costs ~500 µs per map in TypeScript (20 ms in the first Rust port). A row-by-row search that drops partial routes without a "partner" branch finds the same duplicates in ~10 µs.
- **Per-map stats** (Overgrowth A0): ~59 nodes, ~68 edges, ~3 starting rooms, a median of ~90 distinct routes (log2 ≈ 6.5), ~9.5 rest sites including the rest row, 12 `?`, 3 shops, 5 elites, ~3.8 treasures.

## Implications for the interactive tool

Some directions to choose from (not decided yet):

1. **Faithful generator in TypeScript.** Implement steps 1–5 so readers can watch each phase animate: carve, type, prune, layout. Seed-exact reproduction (xoshiro + hash + HashSet order) is optional. A distribution-faithful version is much simpler and enough to explain the algorithm.
2. **Constraints as generate-and-test.** Readers ask for maps where, say, "a path exists with ≥2 shops and 0 elites before the treasure", or "every path hits ≥3 elites". Generate many maps and keep the ones that satisfy the request. A per-node DP over the DAG (min/max count of each type on paths through a node; the sts2-ai observation encoder does exactly this) makes the checks cheap. This also shows readers how rare a given constraint is.
3. **Constraints as construction.** Let users pin node types or path shapes and have the generator fill in the rest under the real placement rules. This is more interesting but diverges from the game's algorithm.
4. **Path queries on a generated map.** Find the best route under a user-defined scoring (count elites, rest before boss, etc.). A longest/shortest path on a DAG is easy and fits a blog post well.

Good details for the post: the wall bias in path carving, quotas instead of percentages, and duplicate-segment pruning as the game's way of making sure "a fork is a real choice".
