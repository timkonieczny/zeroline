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
| Performance overlay | `F3` | — |

Airbrakes are the whole game. Steering alone will not get a fast craft through T6.

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
