# ZEROLINE

Anti-gravity racing in the browser. WipEout Pure's handling and item game, Mirror's Edge's
palette, Three.js r185 on WebGPU. Single player for now; the simulation is built so multiplayer
can be added without rewriting it.

## Commands

```bash
npm run dev        # Vite dev server on http://127.0.0.1:5173
npm run build      # typecheck + production build
npm test           # Vitest, headless, no GPU
npm run typecheck  # tsc --noEmit
npm run lint

npx vite-node scripts/inspect-track.ts   # circuit geometry report: corners, curvature, gradient
npx vite-node scripts/hotlap.ts          # headless lap times for every team
npx vite-node scripts/hotlap.ts kestrel rapier
```

The two scripts are the tuning loop. Change a number in `Handling.ts` or a corner in a track
file, re-run, read the numbers. Do not tune handling by driving — it is slower and it lies.

## Ground rules

**Units are metres, seconds, radians, kilograms.** Speeds are m/s in the simulation and only
converted to km/h at the HUD.

**The simulation must stay deterministic.** No `Math.random`, no `Date.now`, no `performance.now`
anywhere under `src/game` or `src/track`. Randomness comes from `core/Rng.ts`, seeded per race.
This is what makes ghosts, replays and future netcode possible, and it is why the headless
scripts can reproduce a race exactly.

**Everything that drives a craft writes an `InputSnapshot`.** The keyboard, the AI, the autopilot
weapon and — later — a network peer all go through the same struct. Nothing downstream of
`stepCraft` knows which one produced it.

**The sim runs at a fixed 120 Hz; the renderer runs at display rate.** Craft keep their previous
state and the renderer interpolates (`Craft.sampleRender`). Never read the render alpha inside
simulation code.

**No binary assets.** Tracks, craft, scenery and UI are all generated from numbers. A new
constructor is an entry in `data/teams`; a new circuit is a list of corners in `data/tracks`.
Keep it that way unless there is a reason that survives review.

**Shaders are TSL, not GLSL/WGSL strings.** `three/tsl` node graphs, so they compile for whichever
backend the browser gives us and stay type-checked.

**Chrome-latest only.** WebGPU, no fallback path is maintained. Do not add compatibility shims.

## Layout

```
src/
  core/      renderer, loop, input, post chain, math, seeded RNG
  game/      race rules, craft, physics, AI, HUD, weapons
  track/     spline, collision, mesh generation, scenery
  data/      circuits and constructors — the tuning surface
  menu/      the front end
  ui/        shared text and panel primitives
scripts/     headless tuning tools
tests/       Vitest suites for the simulation
```

### The pieces that matter

- **`track/TrackPath.ts`** — a circuit is a closed polygon of corners, each with a radius. The
  road runs straight between them and arcs through each one, so the lap closes by construction.
  Earlier revisions used a numerical closure solve; it worked and produced garbage circuits.
- **`track/TrackSpline.ts`** — resamples the centreline to uniform arc length and carries a
  rotation-minimising frame around the loop, with the closure twist distributed evenly. Uniform
  arc length is why every downstream lookup is a division instead of a curve evaluation.
- **`track/TrackCollision.ts`** — world point to `(s, lateral, height)`. Windowed scan around a
  hint for gameplay queries; a hash grid for cold ones.
- **`game/Physics.ts`** — a magnetically coupled hover craft. While the hover field has purchase,
  gravity points into the road rather than at the world floor, so banking and loops need no
  special cases.
- **`core/PostFX.ts`** — one MRT scene pass, then TRAA, motion blur, speed streaks, bloom and
  chromatic aberration as a TSL graph. Bloom threshold sits above 1.0 because the pass is linear
  HDR and sunlit concrete is already brighter than that.
- **`core/Renderer.ts`** — renders at the display's real pixel density (`devicePixelRatio`), with
  a `matchMedia` listener for the window moving between monitors. Dynamic resolution is a
  separate multiplier on top of native, never a replacement for it.

## Conventions

- British spelling in prose and identifiers (`colour`, `centre`), because the lore is a European
  racing league and consistency beats habit.
- Comments explain *why*, and are worth writing where a reader would otherwise assume a mistake.
  Do not narrate what the next line does.
- Every magic number gets a named constant with a unit in its doc comment.
- Scratch vectors are module-level `_name` constants. Nothing allocates on the per-tick path.
- Tests cover the simulation and the track maths. Rendering is checked by eye, not asserted.

## Naming

Futuristic motorsport, not science fiction. Constructors read like Formula 1 teams (AUROC,
KESTREL DYNAMICS, SABRE-9). Circuits are named after their location plus a designation
(MERIDIAN COAST — CIRCUIT 01). Speed classes are WipEout's: VECTOR, VENOM, FLASH, RAPIER.
Corners get real names (T6 HAIRPIN, T5 MERIDIAN BEND) and the tuning report prints them.
