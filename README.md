# ZEROLINE

**Find the line.**

An anti-gravity racer for the browser, built on Three.js and WebGPU. Nine corners of coastal
circuit, five constructors, the WipEout Pure weapon set, and no downloaded assets — every
surface, hull and skyline is generated from numbers at load time.

![status](https://img.shields.io/badge/status-in%20development-orange)

## Running it

```bash
npm install
npm run dev
```

Then open http://127.0.0.1:5173 in **Chrome**. WebGPU is required; there is no WebGL fallback
path and none is planned.

## Controls

| Action | Keyboard | Gamepad |
| --- | --- | --- |
| Thrust | `W` / `↑` | Right trigger |
| Steer | `A` `D` / `←` `→` | Left stick |
| Left airbrake | `Q` | Left bumper |
| Right airbrake | `E` | Right bumper |
| Sideshift | double-tap an airbrake | double-tap a bumper |
| Barrel roll | double-tap an airbrake, airborne | double-tap a bumper, airborne |
| Fire | `Space` | A / cross |
| Absorb weapon | `Shift` | B / circle |
| Look back | `C` | Left trigger |
| Pitch, airborne | `R` / `F` | Left stick vertical |
| Pause | `Esc` | Start |
| Hide / show results | `Tab` or `H` | Y / triangle |
| Performance overlay | `F3` | — |

Airbrakes are the whole game. Steering alone will not get a fast craft through T6.

Open the throttle in the last moment of the countdown for a **getaway bonus** — the later you
time it inside the window, the bigger the boost. Too early and you get nothing, so it is worth
watching the lights rather than mashing the button.

## The circuit

**MERIDIAN COAST — CIRCUIT 01.** 3.25 km, nine corners, 34 m of elevation. Off the start/finish
viaduct into the Harbour Hook, along the sea wall, through the chicane, under the freight
terminal, up the banked Meridian Bend to the hairpin, then the elevated back straight and one
long right past the grandstands.

## The grid

| Constructor | Character |
| --- | --- |
| **AUROC** | No weaknesses, no excuses |
| **KESTREL DYNAMICS** | Fastest in a straight line, argues about corners |
| **IONFLUX** | Violent out of corners, runs out of legs on the straights |
| **SABRE-9** | Armoured, heavy, still there on the last lap |
| **HALCYON MOTIV** | Goes exactly where you point it |

Speed classes, slowest first: **VECTOR · VENOM · FLASH · RAPIER**.

## Weapons

`TURBO · ROCKETS · HOMING MISSILE · MINES · PLASMA BOMB · PLASMA BOLT · QUAKE · DEFLECTOR ·
AUTOPILOT`

What you draw depends on where you are running: the leader gets defensive and utility items, the
back of the field gets the heavy ordnance. Holding `Shift` throws the weapon away and converts it
into shield energy instead — which is often the better call.

## After the flag

Your finishing position lands on its own for three seconds, then the classification slides in:
position, constructor and time to the millisecond, with your row picked out. The rest of the
field is run through to the flag at that moment, so every row is a real time rather than a
projection.

The controls go dead and the race behind you becomes a **looping replay** of the one you just
drove. `Tab` (or `H`) tucks the table away if you would rather watch it; `Enter` returns to the
menu, and it returns on its own after twenty seconds.

## Settings

`SETTINGS` from the main menu, adjusted with left and right. Graphics quality, antialiasing,
adaptive resolution, frame target, and three volume faders. Everything is stored in local storage
and survives a reload.

The game always renders at the display's real pixel density. Adaptive resolution is a separate
multiplier layered on top of native — it trades sharpness for frame rate under load, and it is
**off by default**, because dropping below your display's real resolution should be a choice.

Antialiasing defaults to SMAA. Temporal antialiasing is available and resolves subpixel detail
better, but it is softer and its per-frame jitter ends up in the velocity buffer that the motion
blur reads, so the blur wobbles. SMAA is sharper and stable.

## Sound

There are no audio files either. The engine is two detuned saws and a filtered noise bed driven
continuously by speed, impacts are shaped noise bursts, and the music is a slow generative pad.
Audio starts on your first key press, because browsers require a gesture.

## Interface

Set in [Geo](https://fonts.google.com/specimen/Geo), with the italic for headlines and anything
picked out. The front end is a lit showroom — the craft turns on a plinth, reflected in the floor,
with overhead softboxes sliding across the hull — and the in-race HUD is light type over the
circuit. Two palettes, so both stay legible on their own background.

## Development

See [CLAUDE.md](CLAUDE.md) for architecture and ground rules.

```bash
npm test        # simulation and track-maths suites, headless
npm run build   # typecheck and bundle

npx vite-node scripts/inspect-track.ts   # circuit geometry report
npx vite-node scripts/hotlap.ts          # headless lap times per constructor
```

## Licence

MIT.
