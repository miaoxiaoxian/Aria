export type NativeDopState = {
  /** True while the audible stream is a bit-perfect DoP stream. */
  active: boolean;
  /** DSD tier of the prepared stream, e.g. "DSD64". */
  tier?: string;
  /** PCM rate DoP runs at (DSD rate / 16). */
  rate?: number;
  /** Container the payload came from, for diagnostics. */
  source?: string;
};

export type NativeAudioState = {
  supported: boolean;
  ready: boolean;
  active: boolean;
  trackId: string | null;
  url: string | null;
  position: number;
  duration: number;
  paused: boolean;
  volume: number;
  exclusive: boolean;
  deviceId: string;
  bitrate: number | null;
  gaplessGeneration?: number;
  /** null/absent = ordinary PCM path; active = native DoP output. */
  dop?: NativeDopState | null;
  kind?: string;
};
