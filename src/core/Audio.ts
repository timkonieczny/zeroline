import { clamp01, lerp } from './math';

export interface AudioMix {
  master: number;
  /** Engine, wind, impacts, weapons. */
  effects: number;
  /** The generative pad under everything. */
  music: number;
}

export const DEFAULT_MIX: AudioMix = { master: 0.8, effects: 0.9, music: 0.5 };

/** Engine pitch at a standstill and at top speed, in Hz. */
const ENGINE_LOW = 48;
const ENGINE_HIGH = 168;
/** Cutoff of the engine's low-pass at rest and flat out, in Hz. */
const ENGINE_FILTER_LOW = 260;
const ENGINE_FILTER_HIGH = 3200;
/**
 * The crowd's voice, in Hz.
 *
 * Two resonances over a noise bed. A stand full of people is not white noise —
 * it has a formant around the vowel everybody is shouting and a hiss on top of
 * it, and those two numbers are the whole difference between a crowd and rain.
 */
const CROWD_BODY = 620;
const CROWD_AIR = 2600;
/** How long the crowd takes to swell and fade as a craft passes, in seconds. */
const CROWD_GLIDE = 0.22;
/** Loudest the crowd ever gets, against the effects bus. */
const CROWD_PEAK = 0.24;

/** Root of the ambient pad, in Hz. A low D. */
const PAD_ROOT = 73.42;

/**
 * All of the game's sound, synthesised at runtime.
 *
 * There are no audio files. The engine is two detuned saws and a noise bed
 * through a moving filter; impacts are shaped noise bursts; the music is a slow
 * generative pad built from a handful of oscillators. That keeps the repository
 * free of binaries, matches how the visuals are made, and means the engine note
 * is genuinely continuous with speed rather than a loop being pitch-shifted.
 *
 * Nothing is created until `resume()` is called from a real user gesture, which
 * is both the browser's rule and the right moment to spend the allocation.
 */
export class Audio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private effectsBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  private engine: {
    oscA: OscillatorNode;
    oscB: OscillatorNode;
    noise: AudioBufferSourceNode;
    noiseGain: GainNode;
    filter: BiquadFilterNode;
    gain: GainNode;
  } | null = null;

  private crowd: {
    noise: AudioBufferSourceNode;
    gain: GainNode;
    panner: StereoPannerNode;
    body: BiquadFilterNode;
  } | null = null;

  private padVoices: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode }[] = [];
  /** True while the pause panel holds the world. */
  private engineMuted = false;
  private noiseBuffer: AudioBuffer | null = null;
  private mix: AudioMix = { ...DEFAULT_MIX };
  private started = false;

  get ready(): boolean {
    return this.context !== null && this.context.state === 'running';
  }

  /**
   * Creates the graph on first call and unblocks the context. Safe to call on
   * every input; it does the work once.
   */
  async resume(): Promise<void> {
    if (!this.context) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.context = new Ctor({ latencyHint: 'interactive' });
      this.build();
    }
    if (this.context.state === 'suspended') await this.context.resume().catch(() => undefined);
  }

  private build(): void {
    const ctx = this.context!;
    this.master = ctx.createGain();
    this.master.gain.value = this.mix.master;
    this.master.connect(ctx.destination);

    this.effectsBus = ctx.createGain();
    this.effectsBus.gain.value = this.mix.effects;
    this.effectsBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.mix.music;
    this.musicBus.connect(this.master);

    // One second of white noise, reused by every noise-based effect.
    const frames = Math.floor(ctx.sampleRate);
    this.noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    // A fixed sequence rather than Math.random, so a session sounds the same
    // twice and the noise bed never happens to start on a click.
    let seed = 0x9e3779b9;
    for (let i = 0; i < frames; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
  }

  setMix(mix: Partial<AudioMix>): void {
    this.mix = { ...this.mix, ...mix };
    if (this.master) this.master.gain.value = this.mix.master;
    if (this.effectsBus) this.effectsBus.gain.value = this.mix.effects;
    if (this.musicBus) this.musicBus.gain.value = this.mix.music;
  }

  getMix(): AudioMix {
    return { ...this.mix };
  }

  // --- Engine -----------------------------------------------------------

  /** Spins the engine up. Idempotent. */
  startEngine(): void {
    const ctx = this.context;
    if (!ctx || !this.effectsBus || this.engine || !this.noiseBuffer) return;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = ENGINE_FILTER_LOW;
    filter.Q.value = 3.5;

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.value = ENGINE_LOW;
    // A few cents apart, which is what makes it sound like a machine rather
    // than a test tone.
    const oscB = ctx.createOscillator();
    oscB.type = 'sawtooth';
    oscB.frequency.value = ENGINE_LOW * 1.008;

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0;

    oscA.connect(filter);
    oscB.connect(filter);
    noise.connect(noiseGain).connect(filter);
    filter.connect(gain).connect(this.effectsBus);

    oscA.start();
    oscB.start();
    noise.start();

    this.engine = { oscA, oscB, noise, noiseGain, filter, gain };
    this.started = true;
  }

  stopEngine(): void {
    if (!this.engine || !this.context) return;
    const now = this.context.currentTime;
    this.engine.gain.gain.setTargetAtTime(0, now, 0.08);
    const { oscA, oscB, noise } = this.engine;
    window.setTimeout(() => {
      oscA.stop();
      oscB.stop();
      noise.stop();
    }, 400);
    this.engine = null;
    this.engineMuted = false;
  }

  /**
   * Silences the engine without tearing it down.
   *
   * The pause panel freezes the simulation but the render loop keeps running,
   * so the director keeps handing the engine the speed the craft was doing when
   * it stopped — a paused game droning at 400 km/h. Muting rather than stopping
   * keeps the oscillators running and their phase intact, so resuming does not
   * click.
   */
  setEngineMuted(muted: boolean): void {
    if (muted === this.engineMuted) return;
    this.engineMuted = muted;
    if (muted && this.crowd && this.context) {
      // The crowd is driven from the player's position, which the pause panel
      // freezes: without this it holds whatever roar it was on, forever.
      this.crowd.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.05);
    }
    if (!muted || !this.engine || !this.context) return;
    // Only the fade down is written here; `updateEngine` brings it back on the
    // first frame after the panel closes, from wherever the ramp left it.
    // Quick enough to read as the game stopping, slow enough not to click.
    this.engine.gain.gain.setTargetAtTime(0, this.context.currentTime, 0.03);
    this.engine.noiseGain.gain.setTargetAtTime(0, this.context.currentTime, 0.03);
  }

  /**
   * Drives the engine from the craft's state.
   *
   * Pitch follows speed, the filter opens with load, and the noise bed comes up
   * with speed alone — that bed is the air rush, and it is what actually sells
   * how fast the craft is going once the tone stops climbing.
   */
  updateEngine(speedFraction: number, thrust: number, boosting: boolean): void {
    const ctx = this.context;
    // Muted: leave the ramp `setEngineMuted` started alone. Writing a target
    // every frame would hold the note up against it.
    if (!ctx || !this.engine || this.engineMuted) return;
    const now = ctx.currentTime;
    const speed = clamp01(speedFraction);

    const pitch = lerp(ENGINE_LOW, ENGINE_HIGH, Math.pow(speed, 0.85)) * (boosting ? 1.16 : 1);
    this.engine.oscA.frequency.setTargetAtTime(pitch, now, 0.05);
    this.engine.oscB.frequency.setTargetAtTime(pitch * 1.008, now, 0.05);

    const cutoff = lerp(ENGINE_FILTER_LOW, ENGINE_FILTER_HIGH, clamp01(speed * 0.7 + thrust * 0.4));
    this.engine.filter.frequency.setTargetAtTime(cutoff, now, 0.06);

    this.engine.gain.gain.setTargetAtTime(lerp(0.05, 0.16, speed) + (boosting ? 0.05 : 0), now, 0.06);
    this.engine.noiseGain.gain.setTargetAtTime(speed * speed * 0.22, now, 0.1);
  }

  // --- One-shots --------------------------------------------------------

  /** A shaped noise burst. The building block for impacts and explosions. */
  private burst(options: {
    duration: number;
    gain: number;
    type: BiquadFilterType;
    from: number;
    to: number;
    q?: number;
  }): void {
    const ctx = this.context;
    if (!ctx || !this.effectsBus || !this.noiseBuffer) return;
    const now = ctx.currentTime;

    const source = ctx.createBufferSource();
    source.buffer = this.noiseBuffer;
    source.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = options.type;
    filter.Q.value = options.q ?? 1;
    filter.frequency.setValueAtTime(options.from, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, options.to), now + options.duration);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(options.gain, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + options.duration);

    source.connect(filter).connect(gain).connect(this.effectsBus);
    source.start(now);
    source.stop(now + options.duration + 0.02);
  }

  /** A pitched blip. The building block for UI and pickups. */
  private blip(frequency: number, duration: number, gain: number, to = frequency, type: OscillatorType = 'triangle'): void {
    const ctx = this.context;
    if (!ctx || !this.effectsBus) return;
    const now = ctx.currentTime;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    if (to !== frequency) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env).connect(this.effectsBus);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /** Hitting a barrier or another craft. `severity` is 0..1. */
  impact(severity: number): void {
    const s = clamp01(severity);
    if (s < 0.03) return;
    this.burst({ duration: lerp(0.09, 0.34, s), gain: lerp(0.06, 0.5, s), type: 'bandpass', from: lerp(900, 260, s), to: 90, q: 1.4 });
    if (s > 0.35) this.blip(lerp(90, 50, s), 0.22, 0.3 * s, 32, 'sine');
  }

  /** Scraping along a wall. Called continuously, so it must stay cheap and quiet. */
  scrape(intensity: number): void {
    if (intensity < 0.05) return;
    this.burst({ duration: 0.08, gain: 0.04 * intensity, type: 'highpass', from: 2200, to: 3000, q: 0.7 });
  }

  boost(): void {
    this.burst({ duration: 0.5, gain: 0.3, type: 'lowpass', from: 380, to: 4200, q: 2 });
    this.blip(120, 0.35, 0.16, 320, 'sawtooth');
  }

  weaponFire(): void {
    this.burst({ duration: 0.22, gain: 0.24, type: 'bandpass', from: 2600, to: 420, q: 2.2 });
  }

  explosion(size: number): void {
    const s = clamp01(size);
    this.burst({ duration: lerp(0.3, 0.8, s), gain: lerp(0.25, 0.6, s), type: 'lowpass', from: lerp(1400, 2600, s), to: 90, q: 1 });
    this.blip(lerp(70, 44, s), lerp(0.3, 0.6, s), lerp(0.2, 0.45, s), 28, 'sine');
  }

  pickup(): void {
    this.blip(660, 0.09, 0.14);
    window.setTimeout(() => this.blip(990, 0.13, 0.12), 70);
  }

  absorb(): void {
    this.blip(880, 0.22, 0.13, 330);
  }

  menuMove(): void {
    this.blip(1320, 0.045, 0.06, 1560, 'square');
  }

  menuConfirm(): void {
    this.blip(880, 0.07, 0.1);
    window.setTimeout(() => this.blip(1320, 0.11, 0.09), 55);
  }

  menuBack(): void {
    this.blip(520, 0.09, 0.08, 340);
  }

  countdownTick(final: boolean): void {
    this.blip(final ? 880 : 440, final ? 0.35 : 0.14, 0.16, final ? 880 : 440, 'square');
  }

  // --- Music ------------------------------------------------------------

  /**
   * A slow, wide pad: a root, a fifth, an octave and a ninth, each drifting
   * through its own filter at its own rate. It never resolves and never
   * repeats, which is exactly what a menu and a race both want underneath them.
   */
  startAmbience(): void {
    const ctx = this.context;
    if (!ctx || !this.musicBus || this.padVoices.length > 0) return;

    const intervals = [1, 1.5, 2, 2.25, 3];
    intervals.forEach((interval, i) => {
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? 'sawtooth' : 'triangle';
      osc.frequency.value = PAD_ROOT * interval * (1 + (i - 2) * 0.0012);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 300 + i * 120;
      filter.Q.value = 4;

      const gain = ctx.createGain();
      gain.gain.value = 0;

      // Each voice breathes on its own slow LFO, so the chord never sits still.
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.021 + i * 0.013;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 220 + i * 90;
      lfo.connect(lfoDepth).connect(filter.frequency);
      lfo.start();

      osc.connect(filter).connect(gain).connect(this.musicBus!);
      osc.start();
      gain.gain.setTargetAtTime(0.075 / (1 + i * 0.35), ctx.currentTime, 3.5);

      this.padVoices.push({ osc, gain, filter });
    });
  }

  stopAmbience(): void {
    const ctx = this.context;
    if (!ctx) return;
    for (const voice of this.padVoices) {
      voice.gain.gain.setTargetAtTime(0, ctx.currentTime, 1.2);
      const osc = voice.osc;
      window.setTimeout(() => osc.stop(), 4000);
    }
    this.padVoices = [];
  }

  // --- Crowd ------------------------------------------------------------

  /**
   * Brings up the grandstands. Idempotent.
   *
   * Synthesised like everything else: a noise loop through a resonant peak at
   * the vowel a crowd shouts and a wide shelf of air above it. It is panned
   * with a `StereoPannerNode` rather than through Three's `PositionalAudio`,
   * because the whole of that machinery — an `AudioListener` in the scene
   * graph, an HRTF panner per source — exists to work out a gain and a pan
   * from two transforms, and the director already knows both. This is the same
   * effect for one node and no scene-graph coupling.
   */
  startCrowd(): void {
    const ctx = this.context;
    if (!ctx || !this.effectsBus || this.crowd || !this.noiseBuffer) return;

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;
    noise.loop = true;

    const body = ctx.createBiquadFilter();
    body.type = 'bandpass';
    body.frequency.value = CROWD_BODY;
    // Broad. A narrow Q here whistles, which reads as a kettle rather than a
    // hundred people.
    body.Q.value = 0.7;

    const air = ctx.createBiquadFilter();
    air.type = 'highshelf';
    air.frequency.value = CROWD_AIR;
    air.gain.value = -9;

    const panner = ctx.createStereoPanner();
    const gain = ctx.createGain();
    gain.gain.value = 0;

    noise.connect(body);
    body.connect(air);
    air.connect(panner);
    panner.connect(gain);
    gain.connect(this.effectsBus);
    noise.start();

    this.crowd = { noise, gain, panner, body };
  }

  /**
   * Places the crowd relative to the listener.
   *
   * @param level 0 when the nearest stand is out of earshot, 1 alongside it.
   * @param pan -1 hard left, 1 hard right.
   * @param excitement Raises the formant a little, so a close pass sounds like
   *   the stand getting to its feet rather than merely getting louder.
   */
  setCrowd(level: number, pan: number, excitement = 0): void {
    const ctx = this.context;
    if (!ctx || !this.crowd) return;
    const target = this.engineMuted ? 0 : clamp01(level) * CROWD_PEAK;
    const now = ctx.currentTime;
    this.crowd.gain.gain.setTargetAtTime(target, now, CROWD_GLIDE);
    this.crowd.panner.pan.setTargetAtTime(Math.max(-1, Math.min(1, pan)), now, CROWD_GLIDE);
    this.crowd.body.frequency.setTargetAtTime(
      CROWD_BODY * (1 + clamp01(excitement) * 0.35),
      now,
      CROWD_GLIDE * 2,
    );
  }

  stopCrowd(): void {
    if (!this.crowd || !this.context) return;
    const { noise, gain } = this.crowd;
    gain.gain.setTargetAtTime(0, this.context.currentTime, 0.1);
    window.setTimeout(() => noise.stop(), 500);
    this.crowd = null;
  }

  /** Ducks the music while something loud is happening. */
  duckMusic(amount: number, seconds = 0.8): void {
    const ctx = this.context;
    if (!ctx || !this.musicBus) return;
    const target = this.mix.music * (1 - clamp01(amount));
    this.musicBus.gain.setTargetAtTime(target, ctx.currentTime, 0.08);
    this.musicBus.gain.setTargetAtTime(this.mix.music, ctx.currentTime + seconds, 0.4);
  }

  dispose(): void {
    this.stopEngine();
    this.stopCrowd();
    this.stopAmbience();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }
}
