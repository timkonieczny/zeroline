import { DEFAULT_MIX, type AudioMix } from './Audio';
import type { AntialiasMode, QualityLevel } from './PostFX';
import { clamp01 } from './math';

export interface GameSettings {
  quality: QualityLevel;
  /** Overrides the quality preset's antialiasing. */
  antialias: AntialiasMode;
  /**
   * The resolution ceiling, as a multiplier on the display's pixel density.
   *
   * Stored as the multiplier rather than as a rung index, because a rung index
   * means nothing on a different display: moving the window to a monitor with
   * another pixel ratio would silently change what was chosen. The ladder finds
   * the nearest rung to this on whatever display it is asked about.
   */
  resolutionScale: number;
  /** Drop resolution under load to hold the frame budget. */
  adaptiveResolution: boolean;
  /** Frame rate the adaptive scaler aims for. */
  targetFps: 60 | 120;
  mix: AudioMix;
}

export const DEFAULT_SETTINGS: GameSettings = {
  quality: 'high',
  antialias: 'smaa',
  // Native. The game renders at the display's real pixels until told
  // otherwise; dropping below that is the player's call to make.
  resolutionScale: 1,
  // Off by default. Dropping below the display's real pixel density is a
  // visible cost, and it should be a choice rather than something that quietly
  // happens the first time a frame runs long.
  adaptiveResolution: false,
  targetFps: 60,
  mix: { ...DEFAULT_MIX },
};

const STORAGE_KEY = 'zeroline.settings.v1';

/**
 * Player settings, persisted to local storage.
 *
 * Loading is defensive on purpose: the stored blob comes from an earlier
 * version of the game as often as not, and a missing or nonsensical field
 * should fall back to the default rather than start a race with the volume at
 * `undefined`.
 */
export function loadSettings(): GameSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS, mix: { ...DEFAULT_MIX } };
    const parsed = JSON.parse(raw) as Partial<GameSettings>;
    return {
      quality: isQuality(parsed.quality) ? parsed.quality : DEFAULT_SETTINGS.quality,
      resolutionScale:
        typeof parsed.resolutionScale === 'number' && parsed.resolutionScale > 0 && parsed.resolutionScale <= 1
          ? parsed.resolutionScale
          : DEFAULT_SETTINGS.resolutionScale,
      antialias: isAntialias(parsed.antialias) ? parsed.antialias : DEFAULT_SETTINGS.antialias,
      adaptiveResolution:
        typeof parsed.adaptiveResolution === 'boolean'
          ? parsed.adaptiveResolution
          : DEFAULT_SETTINGS.adaptiveResolution,
      targetFps: parsed.targetFps === 120 ? 120 : 60,
      mix: {
        master: volume(parsed.mix?.master, DEFAULT_MIX.master),
        effects: volume(parsed.mix?.effects, DEFAULT_MIX.effects),
        music: volume(parsed.mix?.music, DEFAULT_MIX.music),
      },
    };
  } catch {
    // Private browsing, a full quota, or corrupted JSON. Defaults are fine.
    return { ...DEFAULT_SETTINGS, mix: { ...DEFAULT_MIX } };
  }
}

export function saveSettings(settings: GameSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Nothing to be done, and nothing worth interrupting the player over.
  }
}

function isQuality(value: unknown): value is QualityLevel {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'ultra';
}

function isAntialias(value: unknown): value is AntialiasMode {
  return value === 'none' || value === 'smaa' || value === 'traa';
}

function volume(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : fallback;
}
