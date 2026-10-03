// Shared DSP equalizer model. One band layout per mode (18-band wide spacing
// and 31-band ISO 1/3-octave), and the same curve drives both audio paths:
// the Chromium Web Audio graph (System output mode) and mpv's audio filters
// (WASAPI Shared/Exclusive modes), so a preset sounds the same in either mode.

export type EqualizerMode = "18" | "31";

export const equalizerModes: EqualizerMode[] = ["18", "31"];

export const equalizerModeLabels: Record<EqualizerMode, string> = {
  "18": "18 段",
  "31": "31 段",
};

export const equalizerModeDescriptions: Record<EqualizerMode, string> = {
  "18": "18 个频点（55Hz–20kHz），调整直观、开销更低",
  "31": "标准 ISO 1/3 倍频程，精细到每个频点",
};

export type EqualizerBand = {
  /** Center frequency in Hz. */
  frequency: number;
  /** Pre-formatted label for the fader. */
  label: string;
};

// ISO 1/3-octave centers: 20 Hz … 20 kHz.
const isoThirdOctaveFrequencies = [
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

// Wide-spacing set: 18 bands from 55 Hz to 20 kHz (the layout requested for
// the coarse mode).
const wideFrequencies = [
  55, 77, 110, 156, 220, 331, 440, 622, 880, 1200, 1800, 2500, 3500, 5000, 7000, 10000, 14000, 20000,
];

/** Peaking-filter Q that matches each layout's spacing. */
export const equalizerModeQ: Record<EqualizerMode, number> = {
  // ~1/2-octave spacing.
  "18": 2.87,
  // ISO 1/3-octave spacing.
  "31": 4.32,
};

export function formatFrequencyLabel(frequency: number) {
  if (frequency >= 1000) {
    const kilo = frequency / 1000;
    return `${Number.isInteger(kilo) ? kilo : kilo.toFixed(1)}k`;
  }
  return Number.isInteger(frequency) ? String(frequency) : String(frequency);
}

export function equalizerBandsForMode(mode: EqualizerMode): EqualizerBand[] {
  const frequencies = mode === "31" ? isoThirdOctaveFrequencies : wideFrequencies;
  return frequencies.map((frequency) => ({ frequency, label: formatFrequencyLabel(frequency) }));
}

export const equalizerGainRange = 12;

export type EqualizerSettings = {
  enabled: boolean;
  /** Active band layout. */
  mode: EqualizerMode;
  /** Independent curve per layout so switching modes never loses a setting. */
  gains: Record<EqualizerMode, number[]>;
};

export type EqualizerPreset = {
  id: string;
  label: string;
  description: string;
  /** Gains at the 10 anchor frequencies below; interpolated onto every layout. */
  anchors: number[];
};

/** Anchor frequencies shared by all presets (10-band octave centers). */
const presetAnchorFrequencies = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const equalizerPresets: EqualizerPreset[] = [
  {
    id: "flat",
    label: "平直",
    description: "不改变任何频段，用作对照",
    anchors: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  },
  {
    id: "pop",
    label: "流行",
    description: "人声清晰，中低频饱满",
    anchors: [-1, 1, 3, 4, 3, 0, -1, -1, 0, 1],
  },
  {
    id: "rock",
    label: "摇滚",
    description: "强化低音鼓与吉他高频",
    anchors: [4, 3, 2, 0, -1, -1, 1, 3, 4, 4],
  },
  {
    id: "jazz",
    label: "爵士",
    description: "温暖的中频，柔和的低频",
    anchors: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  },
  {
    id: "classical",
    label: "古典",
    description: "保持动态，突出厅堂感",
    anchors: [3, 2, 1, 0, -1, -1, 0, 2, 3, 3],
  },
  {
    id: "bass",
    label: "低音增强",
    description: "大幅抬高低频，压低高频",
    anchors: [6, 5, 4, 2, 0, -1, -2, -3, -4, -5],
  },
  {
    id: "vocal",
    label: "人声",
    description: "突出 500Hz-2kHz 的演唱频段",
    anchors: [-3, -2, 0, 2, 4, 4, 3, 1, 0, -1],
  },
  {
    id: "electronic",
    label: "电子",
    description: "强劲低频与明亮高频",
    anchors: [4, 3, 1, 0, -2, 1, 2, 3, 4, 4],
  },
  {
    id: "loudness",
    label: "等响度",
    description: "小音量下补足两端，接近等响曲线",
    anchors: [6, 5, 3, 1, 0, -1, -1, 1, 3, 5],
  },
];

const equalizerSettingsKey = "aria-equalizer-settings";

function clampGain(value: number) {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(-equalizerGainRange, Math.min(equalizerGainRange, value));
  // Snap to the fader step so preset matching stays exact.
  return Math.round(clamped * 2) / 2;
}

function normalizeGainsForMode(value: unknown, mode: EqualizerMode): number[] {
  const bands = equalizerBandsForMode(mode);
  const source = Array.isArray(value) ? value : [];
  return bands.map((_band, index) => clampGain(Number(source[index] ?? 0)));
}

export function flatEqualizerGains(mode: EqualizerMode) {
  return equalizerBandsForMode(mode).map(() => 0);
}

export function equalizerPresetById(id: string) {
  return equalizerPresets.find((preset) => preset.id === id) ?? null;
}

/** Interpolates preset anchors onto the requested layout (log-frequency). */
export function presetGainsForMode(preset: EqualizerPreset, mode: EqualizerMode) {
  return equalizerBandsForMode(mode).map((band) => {
    const frequency = band.frequency;
    const first = presetAnchorFrequencies[0];
    const last = presetAnchorFrequencies[presetAnchorFrequencies.length - 1];
    if (frequency <= first) return clampGain(preset.anchors[0]);
    if (frequency >= last) return clampGain(preset.anchors[preset.anchors.length - 1]);
    for (let index = 0; index < presetAnchorFrequencies.length - 1; index += 1) {
      const low = presetAnchorFrequencies[index];
      const high = presetAnchorFrequencies[index + 1];
      if (frequency < low || frequency > high) continue;
      const ratio = (Math.log(frequency) - Math.log(low)) / (Math.log(high) - Math.log(low));
      return clampGain(preset.anchors[index] + (preset.anchors[index + 1] - preset.anchors[index]) * ratio);
    }
    return 0;
  });
}

/** Preset whose interpolated curve matches the stored gains exactly. */
export function detectEqualizerPreset(settings: EqualizerSettings) {
  const gains = settings.gains[settings.mode];
  const match = equalizerPresets.find((preset) => {
    const candidate = presetGainsForMode(preset, settings.mode);
    return candidate.length === gains.length && candidate.every((gain, index) => gain === gains[index]);
  });
  return match ?? null;
}

export function isFlatEqualizer(settings: EqualizerSettings) {
  return settings.gains[settings.mode].every((gain) => Math.abs(gain) < 0.05);
}

/** True when the DSP chain would actually change the signal. */
export function isEqualizerActive(settings: EqualizerSettings) {
  return settings.enabled && !isFlatEqualizer(settings);
}

export function createDefaultEqualizerSettings(): EqualizerSettings {
  return {
    enabled: false,
    mode: "31",
    gains: {
      "18": flatEqualizerGains("18"),
      "31": flatEqualizerGains("31"),
    },
  };
}

export function readCachedEqualizerSettings(): EqualizerSettings {
  try {
    const raw = window.localStorage.getItem(equalizerSettingsKey);
    if (!raw) return createDefaultEqualizerSettings();
    const parsed = JSON.parse(raw) as {
      enabled?: boolean;
      mode?: string;
      gains?: { "18"?: unknown; "31"?: unknown } | unknown;
    };
    const mode: EqualizerMode = parsed.mode === "18" ? "18" : "31";
    const gainsSource = (parsed.gains ?? {}) as { "18"?: unknown; "31"?: unknown };
    // Older builds stored a flat array; treat it as the 31-band curve.
    const legacyGains = Array.isArray(parsed.gains) ? (parsed.gains as unknown) : null;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : false,
      mode,
      gains: {
        "18": normalizeGainsForMode(gainsSource["18"], "18"),
        "31": normalizeGainsForMode(legacyGains ?? gainsSource["31"], "31"),
      },
    };
  } catch {
    return createDefaultEqualizerSettings();
  }
}

export function writeCachedEqualizerSettings(settings: EqualizerSettings) {
  try {
    window.localStorage.setItem(equalizerSettingsKey, JSON.stringify(settings));
  } catch {
    // Equalizer settings are best-effort.
  }
}

/** Applies a gain list to the active layout and keeps the other layout intact. */
export function withEqualizerGains(settings: EqualizerSettings, gains: number[]): EqualizerSettings {
  return {
    ...settings,
    gains: {
      ...settings.gains,
      [settings.mode]: normalizeGainsForMode(gains, settings.mode),
    },
  };
}

export function withEqualizerBand(settings: EqualizerSettings, bandIndex: number, gain: number): EqualizerSettings {
  const current = settings.gains[settings.mode].slice();
  if (bandIndex < 0 || bandIndex >= current.length) return settings;
  current[bandIndex] = clampGain(gain);
  return withEqualizerGains(settings, current);
}

export function withEqualizerMode(settings: EqualizerSettings, mode: EqualizerMode): EqualizerSettings {
  if (settings.mode === mode) return settings;
  return { ...settings, mode };
}

export function equalizerSummary(settings: EqualizerSettings) {
  const modeLabel = equalizerModeLabels[settings.mode];
  if (!settings.enabled) return `已关闭 · ${modeLabel}`;
  if (isFlatEqualizer(settings)) return `已开启 · ${modeLabel} · 平直`;
  const preset = detectEqualizerPreset(settings);
  return `已开启 · ${modeLabel} · ${preset ? preset.label : "自定义"}`;
}

/**
 * mpv audio-filter chain. mpv's `equalizer` biquad takes f (Hz), t (q|o),
 * w (width) and g (dB); one peaking filter per band reproduces the same curve
 * the Web Audio biquads produce for the System output mode.
 */
export function buildMpvEqualizerFilter(settings: EqualizerSettings) {
  if (!isEqualizerActive(settings)) return "";
  const bands = equalizerBandsForMode(settings.mode);
  const gains = settings.gains[settings.mode];
  const q = equalizerModeQ[settings.mode];
  const filters = bands
    .map((band, index) => ({ band, gain: gains[index] ?? 0 }))
    .filter(({ gain }) => Math.abs(gain) >= 0.05)
    .map(({ band, gain }) => `equalizer=f=${band.frequency}:t=q:w=${q}:g=${gain.toFixed(1)}`);
  return filters.join(",");
}
