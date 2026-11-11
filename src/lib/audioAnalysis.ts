export type AnalysisMode = "original" | "levels" | "spectrum" | "spectrogram" | "field";
export type FieldMode = "polar-sample" | "polar-level" | "lissajous";
export type StereoAnalysers = { current: readonly [AnalyserNode, AnalyserNode] | null };
export const analysisOptions = [
  { id: "original", label: "原频谱" },
  { id: "levels", label: "电平" },
  { id: "spectrum", label: "频谱" },
  { id: "spectrogram", label: "声谱图" },
  { id: "field", label: "声场" },
] as const;

export function amplitudeDb(value: number) {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

/** Sample-window measurements. Neither a true-peak meter nor a LUFS meter. */
export function measureStereo(left: Float32Array, right: Float32Array) {
  let sumL = 0, sumR = 0, cross = 0, peakL = 0, peakR = 0;
  const length = Math.min(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const l = Number.isFinite(left[i]) ? left[i] : 0;
    const r = Number.isFinite(right[i]) ? right[i] : 0;
    sumL += l * l; sumR += r * r; cross += l * r;
    peakL = Math.max(peakL, Math.abs(l)); peakR = Math.max(peakR, Math.abs(r));
  }
  const denominator = Math.sqrt(sumL * sumR);
  return {
    peakL, peakR,
    rmsL: Math.sqrt(sumL / Math.max(1, length)),
    rmsR: Math.sqrt(sumR / Math.max(1, length)),
    correlation: denominator > 1e-12 ? Math.max(-1, Math.min(1, cross / denominator)) : null,
  };
}

/** Fold signed samples onto the upper M/S semicircle. L is left, R is right. */
export function polarSample(left: number, right: number) {
  const mid = (left + right) / Math.SQRT2;
  const side = (right - left) / Math.SQRT2;
  return { x: mid < 0 ? -side : side, y: Math.abs(mid) };
}

/** RMS radius of samples falling into each angular sector, no automatic gain. */
export function polarLevels(left: Float32Array, right: Float32Array, bins: number) {
  const energy = new Float32Array(bins);
  const counts = new Uint32Array(bins);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const { x, y } = polarSample(left[i], right[i]);
    const radiusSquared = x * x + y * y;
    if (!Number.isFinite(radiusSquared) || radiusSquared < 1e-12) continue;
    const angle = Math.atan2(y, x);
    const bin = Math.min(bins - 1, Math.floor(angle / Math.PI * bins));
    energy[bin] += radiusSquared; counts[bin]++;
  }
  return energy.map((value, bin) => counts[bin] ? Math.sqrt(value / counts[bin]) : 0);
}
