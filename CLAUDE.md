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
npm run lint      # ESLint 9 flat config; type-aware, and deliberately few rules

npx vite-node scripts/inspect-track.ts   # circuit geometry report: corners, curvature, gradient
npx vite-node scripts/hotlap.ts          # headless lap times for every team
npx vite-node scripts/hotlap.ts kestrel rapier
npx vite-node scripts/load-profile.ts    # where the load time goes, and what could leave the main thread
npx vite-node scripts/shadow-report.ts   # how much of the lap the city shades, and where the gaps are
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

**No binary assets, with one exception.** Tracks, craft, scenery and UI are all generated from
numbers. A new constructor is an entry in `data/teams`; a new circuit is a list of corners in
`data/tracks`. Keep it that way unless there is a reason that survives review.

The exception is `public/sky/sky-05-2k.png`, a painted equirectangular panorama used as the
circuit's background and as the source of its lighting probe. It is 8-bit sRGB and carries no sun
energy — the directional sun is unchanged — but it puts recognisable cloud into every reflection,
which a gradient cannot. A second such file needs a better argument than this one had.

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

- **`track/TrackWorker.ts`** — a circuit's arithmetic, off the main thread. Resampling the
  centreline and sweeping the road, barriers and tunnels along it is four fifths of a load and
  touches no GPU, so it happens in a worker and comes back as transferable buffers.
  `TrackGeometry.ts` exists to keep `three/webgpu` out of that worker: materials compile shaders
  and shaders need a device, so the sweeps live in a module that cannot import one. `TrackLoader`
  falls back to building inline if a worker is unavailable — the fallback is the original path,
  not a degraded one.
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
  chromatic aberration as a TSL graph. The tone map is **Khronos PBR Neutral, not ACES** — ACES
  rolls saturated highlights toward white, the right instinct for film and what stops a sunlit
  circuit tearing, but on white concrete under a white sky it takes the last of the colour with
  it and the circuit reads as an overcast afternoon. A vibrance grade sits on top, but it can
  only amplify what is there: raising it alone did nothing, because a third more of almost
  nothing is still almost nothing. Bloom, the exposure and the tunnel glare all run before the
  tone map in linear HDR, so none of them needed retuning when it changed. Bloom threshold sits above 1.0 because the pass is linear
  HDR and sunlit concrete is already brighter than that.
- **`core/Renderer.ts`** — renders at the display's real pixel density (`devicePixelRatio`), with
  a `matchMedia` listener for the window moving between monitors. Dynamic resolution is a
  separate multiplier on top of native, never a replacement for it.
- **`core/Audio.ts`** — every sound synthesised at runtime. No files, same as the visuals. The
  crowd is a noise bed through a formant, panned with a `StereoPannerNode` rather than through
  Three's `PositionalAudio`: all that machinery exists to derive a gain and a pan from two
  transforms, and `AudioDirector.placeCrowd` already has both from the craft's arc length.
  `game/AudioDirector.ts` watches race state for edges and turns them into sound, so the
  simulation stays free of side effects and a replay cannot double-trigger anything.
  **The announcer is the one sound that is not synthesised**, and it is the one thing in the
  game that cannot be: `speechSynthesis` writes straight to the output device in every browser
  and there is no way to route it into an `AudioContext`, so the words are dry, centred and
  outside the mix — their level is derived from the player's own sliders instead of being summed
  with them. What *is* in the graph is the tannoy chime that introduces them, panned at the
  gantry and sent to a convolver whose impulse response is generated noise. A formant
  synthesiser saying the circuit's name would have been in the graph and unintelligible.
- **`game/Replay.ts`** — pose and speed for every craft at 30 Hz, played back on a loop once the
  flag is out. Playback writes into the craft's own state, so the camera, the models and the
  engine note cannot tell the difference between being driven and being replayed.
- **`track/scenery/Skyline.ts`** — the city, and the shadows it throws across the road. After
  placement it raises existing buildings until the sun bars as much of the lap as it can reach:
  cheapest-first by floors *added*, capped by the traffic lanes overhead. It only ever adds
  storeys — the window grid is driven by a per-instance `storeys` attribute, so a building that
  gains sixty metres gains fourteen floors rather than fourteen tall ones. It lands near 47%,
  not the 60% it asks for: a quarter of the lap has nothing between it and the sun and another
  quarter is capped by the traffic lane overhead. Lifting `SHADOW_MAX_GAIN` past 320 m buys
  under a point and then nothing at all — check with the report before assuming otherwise.
- **`track/TrackGeometry.ts` — `glassSpans`** — four short stretches of the run down to the
  tunnel, where the circuit is low enough over the water to be worth opening up. `buildRoad`
  cuts the hole (the surface becomes ranged ribbons rather than one closed one, with a concrete
  margin left along each edge) and `scenery/TunnelGlass` fills it with the same pane it uses
  under a tunnel. Both read the same function, because the day they disagree is the day there
  is a gap in the circuit somebody drives through.
- **`track/scenery/PlatformParks.ts`** — parks on the concrete decks the tower clusters stand
  on. The ground is laid out before anything is planted: a promenade round every deck, cross
  paths threaded *between* the towers rather than through them, lawns in the blocks that are
  left, and a tree only ever on a lawn. Trees dotted straight onto concrete read as weeds, which
  is what this replaced. Four instanced draws, 48k triangles, no per-frame cost. It is handed
  `Skyline.footprints`, not just each deck's own cluster: platforms overlap one another in plan
  and plenty of towers stand in the sea on no platform at all, so a deck's own list let lawns be
  laid through a neighbour's building with trees inside it. Trunk and crown are separate meshes for the same reason the crowd's bodies and
  helmets are. Placement checks the road *above* each spot: platforms are allowed to sit under
  the circuit where it is high, but a nine-metre tree on one is not.
- **`track/scenery/Grandstands.ts`** — stands on the straights and a facing pair at the grid,
  with about 3000 spectators in one instanced draw. `STAND_LIFT` is derived from the sight line
  rather than chosen: the shortest spectator in the front row has to see over `WALL_HEIGHT`,
  and every row behind is higher again, so clearing the front row clears the house. Built off
  the road plane instead — as it was — the front rows sat below both the track's wall and the
  stand's own rail, looking at concrete, and from the cockpit they read as being under the
  circuit. `tests/scenery.test.ts` asserts the sight line, not the number. Dark anodised steel, the one built thing on
  the circuit that is not white: a stand in the same precast as the city behind it has no
  silhouette, and the crowd needs a dark ground to read against. Each stand is nine straight
  boxes following a road that climbs and turns, so every swept box is cut a tenth longer than
  its pitch — cut to the pitch they meet only on their centrelines and the canopy reads as a
  flight of steps with daylight between them. The canopy panels are then deliberately skewed
  and staggered against each other: a shallow roof over a hundred metres is one flat rectangle
  in almost every shot, and turning the plates gives it an edge to catch the sun on. Alternate
  sections are also shrunk four parts in a thousand — the overlap closes the joints, but on a
  level straight two neighbours are the *same box* offset along the road, and the metre they
  share has coplanar faces the depth buffer cannot choose between. It showed on the apron,
  which is the one large horizontal slab in the set. The crowd is a tapered cylinder with a sphere on it; the
  Daft Punk read is entirely the helmet, which is metal above a local-Y line with a dark band
  smoothstepped across it. Cheering is `sin(time·rate + phase)` in the vertex shader off a
  per-instance attribute, so the CPU never touches a figure after load and a full house costs
  what an empty one does. Placed *before* the skyline, which is handed their footprints as a
  keep-out.
- **`game/RaceStage.ts`** — `settleField()` runs the rest of the field to the flag in one go when
  the player crosses. Without it the classification freezes on projected intervals that do not
  even sort in the same order as the positions beside them.

## Things that were slow, and why they are not any more

Every one of these was found by measurement, and every one would be easy to reintroduce:

- **The intro's cuts stalled for a second each.** Every pass a frame is made of — the sun's
  shadow map, the water's reflection, the post chain's depth buffer — builds its state the first
  time it is asked for, and a camera that teleports across the circuit asks for all of it at
  once. `App.warmPipelines` draws each shot behind the curtain **with frustum culling suspended
  across the scene**: a pipeline is built when its object is first *drawn*, so anything culled
  during a warm frame is a stall still waiting to happen. One frame per shot is enough and more
  is waste — a pipeline is keyed on material, geometry and pass, never on the camera, and
  nothing camera-fitted moves during a warm-up because `RaceStage.render` is not what runs it.
  Measured after: 12–18 ms a frame either side of all three cuts. It does not cover anything
  *hidden*, though — an invisible object is skipped before it is culled — so the countdown
  lamps and the deflector bubble still compile the first time they are shown.
- **The racing line's relaxation** sampled the spline three times per point per pass — six
  hundred passes over sixteen hundred points. Three seconds of blocked main thread on every
  circuit load. The frames do not change between passes, so they are flattened into typed
  arrays once and the inner loop is plain arithmetic. Now 44 ms.
- **The collision query's search window** was sized for sixty metres of travel per tick. A
  craft covers under two at RAPIER speed. Narrowing it to fifteen made the headless test suite
  three times faster and changed no lap time by a millisecond.
- **Two thirds of the frame was post-processing.** GPU timestamps on the F3 overlay put High at
  115 ms on an Intel Gen9: 35 for the scene and 77 for the passes over it. Motion blur and the
  speed streaks were two full-screen passes walking the same texture in two directions, and the
  result was left as an expression that bloom then compiled a second time. They are one loop now
  (`core/SpeedBlur.ts`), resolved once. GTAO went to Ultra alone — 35 ms for an effect that is
  genuinely subtle on a white, convex, sunlit circuit. The player also gets a resolution ladder,
  because at 1.7 million pixels every one of those passes pays for all of them.

## Two things that are easy to get wrong twice

- **Per-instance colour goes through `setColorAt`, not a custom attribute.** The crowd's
  clothing was a `vec3` instanced attribute read with `attribute('shirt')`, alongside the
  `cheer` attribute the animation uses. It worked for the first few stands and rendered every
  later one flat grey — with the right values sitting in the buffer at exactly those indices,
  and a constant emissive test proving the material was fine. Not a count boundary and not
  lighting. Whatever the cause, `instanceColor` is the path three actually maintains. It
  multiplies the *whole* `colorNode` though, helmet included, which is why the crowd is two
  meshes: bodies take the instance colour, helmets have none to be tinted by.
- **A track frame is left-handed.** `right` is `tangent × up`, so
  `makeBasis(right, up, tangent)` has determinant −1. A quaternion cannot hold a reflection, so
  `setFromRotationMatrix` silently discards it and hands back an unrelated rotation — the
  grandstands shipped 25° off the road at the grid and 92° off at half distance, showing
  backfaces. Negate one axis. Which one is not free: negate the tangent when the thing is
  symmetric (`Craft`, the stands, the pillar capitals), and negate `right` when local −Z has to
  stay the driver-facing side (`StartLine`, whose sign, trim and lamps all hang off it).
  `tests/scenery.test.ts` pins the direction, not the determinant — the determinant of the
  finished instance matrix is always positive, because the reflection never survives the
  quaternion.
- **Never let an animation take a real frame's `dt`.** `Loop` clamps what it hands the renderer
  to 100 ms. A hitch — a tab regaining focus, a shader compiling, the field settling at the flag
  — otherwise arrives as one multi-second step and every eased value in the game teleports.
- **A saturated sky is a terrible bounce light.** The visual sky can be as vivid as it likes, but
  the hemisphere fill takes a washed-out version of it. Feeding the zenith in directly puts a
  blue cast on every white surface and the circuit stops reading as concrete.
- **Hash the cell, not the pixel.** `fract(sin(uv · k) · big)` on a continuous UV is a white-noise
  generator, not a pattern. Quantise with `floor` to the feature you want — a window, a tile —
  and hash that. The building facades were television static for two commits because of this.
- **A white subject on a white set has no silhouette.** The showroom needs a graded backdrop and a
  floor a few stops under the ceiling, or the craft dissolves into the room. When something looks
  transparent here, check the contrast before checking the material — twice now it has been the
  set, not a bug.
- **Airbrakes cannot hold a stationary craft.** Their drag is proportional to speed, so at zero
  speed they do nothing. Anything that has to stay put — the grid during a countdown — needs its
  thrust zeroed outright.

## Interface

- **Typeface is Geo**, loaded from Google Fonts and awaited before any label is built. It ships a
  single weight in roman and italic, so hierarchy comes from size, tracking and the italic —
  never from `weight`, which would only get a synthesised faux-bold out of the canvas rasteriser.
- **Sentence case.** `TextStyle.upper` is off by default. Shout only genuine abbreviations:
  constructor tags, nation codes, SMAA, the wordmark.
- **Two palettes, in `ui/Palette.ts`.** `DARK_UI` for anything over the circuit, `LIGHT_UI` for
  the showroom. Widgets take one as an option; none of them hard-code a colour. Note the light
  scheme's accent is a deeper blue than the HUD's cyan — 0x24d4ff has about two-to-one contrast
  on white, which is decoration rather than legibility.
- **Text is rasterised once per string.** `TextMesh.setText` is free when the string has not
  changed, which is why per-frame readouts are cheap.

## Things that render the scene more than once

Each of these costs a full extra scene render per frame, at a reduced
resolution. They are worth it, but they are the first place to look if the frame
budget is tight:

- The ocean (`WaterMesh`) renders its own planar reflection at 0.25 scale.
- The showroom floor's mirror renders at 0.5 scale — menu only.

GTAO is *not* one of these, though it is easy to assume so: it runs a half
resolution full-screen pass off the depth buffer that is already there, and
never re-renders the scene. It reconstructs normals from depth rather than
adding a third MRT attachment, because on an integrated GPU that attachment's
bandwidth costs more than the maths does.

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
