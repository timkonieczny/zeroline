import { clamp, clamp01, lerp } from './math';

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
/**
 * The circuit announcer: a two-tone tannoy chime, then the track's name.
 *
 * The chime is synthesised like everything else and goes through the effects
 * bus, so it can be placed at the gantry and thrown into the reverb below. The
 * *words* cannot be. `speechSynthesis` writes straight to the output device in
 * every browser and there is no way to route it into an `AudioContext`, so the
 * voice is dry, centred, and its level can only track the player's own mix
 * rather than being summed with it. The alternatives were a formant
 * synthesiser saying it, which would not have been intelligible, or an audio
 * file, which this repository does not have.
 */
const CHIME_LOW = 587.33;
const CHIME_HIGH = 880;
/** Seconds between the two notes of the chime, and how long each rings. */
const CHIME_GAP = 0.26;
const CHIME_RING = 0.9;
/** Milliseconds after the chime before the voice starts. */
const ANNOUNCE_DELAY = 620;
/**
 * How loud the announcement is against the crowd.
 *
 * Above one: a PA is built to be heard over a full grandstand, and at parity
 * with the crowd it disappeared into it.
 */
const ANNOUNCE_OVER_CROWD = 1.15;
/** How much of the chime is sent to the hall. */
const ANNOUNCE_WET = 0.5;
/**
 * How much the voice's level is scaled up before it leaves.
 *
 * `SpeechSynthesisUtterance.volume` is a fraction of the *device* volume, not
 * of this graph, so the two are not on the same scale. This makes the words
 * land somewhere near the chime that introduced them.
 */
const VOICE_MAKEUP = 2.2;

/**
 * Length of the synthesised reverb tail, in seconds, and how fast it decays.
 *
 * A convolver rather than a delay line, because what a gantry tannoy needs is
 * a room — a stadium's worth of concrete over open water — and not a slapback.
 * The impulse is exponentially-decaying noise generated here, like every other
 * sound in this file; a recorded impulse response would be a binary asset.
 */
const REVERB_SECONDS = 2.4;
const REVERB_DECAY = 3.4;

/**
 * The safety limiter on the master bus.
 *
 * Nothing in this graph was watching the ceiling. Alongside a grandstand the
 * sustained sum is now the crowd at 0.62 plus the engine's tone and air at
 * about 0.43, and a detonation adds another 0.6 of shaped noise on top of a
 * 0.45 blip — so a missile going off as the player passes a stand clipped at
 * the destination. Raising the crowd made that routine rather than marginal.
 *
 * A limiter rather than turning the crowd back down, because the loudness is
 * the point: a full stand alongside should be the loudest thing in the race
 * after the engine. Threshold just under unity, a high ratio and a fast
 * attack, so it does nothing at all until something is genuinely about to
 * clip and then only ducks the peak.
 */
const LIMIT_THRESHOLD = -2;
const LIMIT_RATIO = 20;
const LIMIT_KNEE = 3;
const LIMIT_ATTACK = 0.003;
const LIMIT_RELEASE = 0.25;

/**
 * Loudest the crowd ever gets, against the effects bus.
 *
 * A grandstand alongside is meant to be the loudest thing in the race after
 * the engine. It was set conservatively against a single stand and there are
 * seven of them now, most of the lap within earshot of one.
 */
const CROWD_PEAK = 0.62;

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
  private limiter: DynamicsCompressorNode | null = null;
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

  private reverb: ConvolverNode | null = null;
  /** Voices arrive asynchronously, so the one we settle on is kept. */
  private announcer: SpeechSynthesisVoice | null = null;
  /** Pending handle for the gap between the chime and the words. */
  private voiceTimer = 0;

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
    // Everything meets here, and the limiter is the last thing before the
    // speakers: `master` is a plain gain the player controls, so it cannot be
    // the thing that keeps the sum in range.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = LIMIT_THRESHOLD;
    this.limiter.ratio.value = LIMIT_RATIO;
    this.limiter.knee.value = LIMIT_KNEE;
    this.limiter.attack.value = LIMIT_ATTACK;
    this.limiter.release.value = LIMIT_RELEASE;
    this.limiter.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.mix.master;
    this.master.connect(this.limiter);

    this.effectsBus = ctx.createGain();
    this.effectsBus.gain.value = this.mix.effects;
    this.effectsBus.connect(this.master);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.mix.music;
    this.musicBus.connect(this.master);

    // Asked for once, and the answer thrown away. `getVoices` returns an
    // empty list until the platform has populated it, and on Chrome it is this
    // first call that starts that off — so asking here, on the first gesture,
    // is what makes the list ready by the time a race announces itself.
    // Without it the announcer falls through to the platform default, which is
    // a man on this machine and the announcer is supposed to be a woman.
    window.speechSynthesis?.getVoices();

    // One second of white noise, reused by every noise-based effect.
    const frames = Math.floor(ctx.sampleRate);
    this.noiseBuffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    Audio.fillNoise(this.noiseBuffer.getChannelData(0), 0x9e3779b9);
  }

  /**
   * Fills a channel with white noise from a fixed sequence.
   *
   * Not `Math.random`: a session has to sound the same twice, and a bed that
   * happened to start on a click would do it every time. Shared by the noise
   * bed and the reverb's impulse, so the two cannot drift apart.
   */
  private static fillNoise(data: Float32Array, seed: number): void {
    let state = seed >>> 0;
    for (let i = 0; i < data.length; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      data[i] = (state / 0xffffffff) * 2 - 1;
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
  private blip(
    frequency: number,
    duration: number,
    gain: number,
    to = frequency,
    type: OscillatorType = 'triangle',
    delay = 0,
    destination?: AudioNode,
  ): OscillatorNode | null {
    const ctx = this.context;
    if (!ctx || !this.effectsBus) return null;
    const now = ctx.currentTime + delay;

    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    if (to !== frequency) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, now);
    env.gain.exponentialRampToValueAtTime(gain, now + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(env).connect(destination ?? this.effectsBus);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    return osc;
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

  // --- The announcer ------------------------------------------------------

  /**
   * The circuit's name over the tannoy on the gantry.
   *
   * @param name The circuit, in the wording its own sign uses.
   * @param level 0 with the gantry out of earshot, 1 standing under it.
   * @param pan -1 hard left, 1 hard right. The chime follows this; the voice
   *   cannot, for the reason given on `CHIME_LOW`.
   */
  announce(name: string, level: number, pan: number): void {
    const ctx = this.context;
    if (!ctx || !this.effectsBus) return;

    const hall = this.hall(ctx);
    const loudness = clamp01(level) * CROWD_PEAK * ANNOUNCE_OVER_CROWD;
    const panner = ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    panner.connect(this.effectsBus);

    const send = ctx.createGain();
    send.gain.value = ANNOUNCE_WET;
    send.connect(hall);
    panner.connect(send);

    // Two notes into the panner rather than the bus, so both the placement and
    // the hall apply. The second one takes the nodes down with it when it ends
    // — six of them per race, and they would otherwise stay wired to the
    // convolver for the life of the context.
    this.blip(CHIME_LOW, CHIME_RING, loudness * 0.5, CHIME_LOW, 'triangle', 0, panner);
    const last = this.blip(
      CHIME_HIGH,
      CHIME_RING,
      loudness * 0.5,
      CHIME_HIGH,
      'triangle',
      CHIME_GAP,
      panner,
    );
    if (last) {
      last.onended = () => {
        panner.disconnect();
        send.disconnect();
      };
    }

    this.speak(`Welcome to ${name}`, loudness);
  }

  /**
   * The hall, built the first time something needs it.
   *
   * Off the first-gesture path deliberately. Generating the impulse is eleven
   * milliseconds and most of a megabyte, and handing it to a `ConvolverNode`
   * costs a few more while Chrome partitions it — all of which a player who
   * opens the menu and never starts a race would otherwise pay for a sound
   * they never hear.
   */
  private hall(ctx: AudioContext): ConvolverNode {
    if (this.reverb) return this.reverb;
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = Audio.impulse(ctx);
    this.reverb.connect(this.effectsBus!);
    return this.reverb;
  }

  /**
   * The words, through the browser's own speech synthesis.
   *
   * The rate and pitch are pushed toward an announcer rather than a screen
   * reader: slower, a little brighter, never the default cadence.
   */
  private speak(text: string, loudness: number): void {
    const speech = window.speechSynthesis;
    if (!speech) return;

    // Held so `dispose` can cancel it. Without that the timer outlives the
    // context and speaks a line into a torn-down game.
    this.voiceTimer = window.setTimeout(() => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voice = this.pickAnnouncer();
      if (voice) utterance.voice = voice;
      utterance.lang = voice?.lang ?? 'en-GB';
      utterance.rate = 0.92;
      utterance.pitch = 1.05;
      utterance.volume = this.voiceLevel(loudness);
      speech.speak(utterance);
    }, ANNOUNCE_DELAY);
  }

  /**
   * Where the voice sits, given how loud it would have been in the graph.
   *
   * The one place the bus gains are applied by hand. `speechSynthesis` never
   * reaches `effectsBus` or `master`, so a mix change that everything else
   * gets for free has to be read off here instead — and having exactly one
   * place that does it is what keeps the next one from being forgotten.
   */
  private voiceLevel(loudness: number): number {
    return clamp01(loudness * this.mix.effects * this.mix.master * VOICE_MAKEUP);
  }

  /**
   * A clear female English voice, or the nearest the platform will give us.
   *
   * There is no attribute for the sex of a voice — the list is names and
   * locales — so this is a search through the ones that are reliably female on
   * each desktop platform, then any English voice, then whatever is first.
   *
   * Cached on the first call that finds anything. `getVoices` returns an empty
   * list until the platform has populated it, which is why `build` asks once
   * to start that off: by the time a race reaches its intro the list is there.
   */
  private pickAnnouncer(): SpeechSynthesisVoice | null {
    if (this.announcer) return this.announcer;
    const voices = window.speechSynthesis?.getVoices() ?? [];
    if (voices.length === 0) return null;

    const known = ['samantha', 'zira', 'hazel', 'sonia', 'libby', 'aria', 'jenny', 'karen', 'moira'];
    const english = voices.filter((voice) => voice.lang.toLowerCase().startsWith('en'));
    this.announcer =
      english.find((voice) => known.some((name) => voice.name.toLowerCase().includes(name))) ??
      english.find((voice) => voice.name.toLowerCase().includes('female')) ??
      english[0] ??
      voices[0];
    return this.announcer;
  }

  /**
   * A stadium's worth of concrete, as exponentially-decaying noise.
   *
   * Stereo and decorrelated: the same noise in both ears is a comb filter, not
   * a room. The envelope is the expensive half — a fractional exponent, so a
   * `Math.pow` per sample and not a multiply — and it is identical in both
   * ears, so it is computed once and applied twice.
   */
  private static impulse(ctx: AudioContext): AudioBuffer {
    const frames = Math.floor(ctx.sampleRate * REVERB_SECONDS);
    const buffer = ctx.createBuffer(2, frames, ctx.sampleRate);
    const envelope = new Float32Array(frames);
    for (let i = 0; i < frames; i++) envelope[i] = (1 - i / frames) ** REVERB_DECAY;

    for (let channel = 0; channel < 2; channel++) {
      const data = buffer.getChannelData(channel);
      Audio.fillNoise(data, channel === 0 ? 0x1d872b41 : 0x6b1f39c7);
      for (let i = 0; i < frames; i++) data[i] *= envelope[i]!;
    }
    return buffer;
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
    this.crowd.panner.pan.setTargetAtTime(clamp(pan, -1, 1), now, CROWD_GLIDE);
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
    window.clearTimeout(this.voiceTimer);
    window.speechSynthesis?.cancel();
    this.stopEngine();
    this.stopCrowd();
    this.stopAmbience();
    void this.context?.close().catch(() => undefined);
    this.context = null;
    this.reverb = null;
    this.limiter = null;
    this.master = null;
    this.started = false;
  }

  get isStarted(): boolean {
    return this.started;
  }
}
