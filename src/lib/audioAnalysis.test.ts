import { describe, expect, it } from "vitest";
import { amplitudeDb, measureStereo, polarSample, polarLevels } from "./audioAnalysis";

const samples = (fn: (i: number) => number) => Float32Array.from({ length: 2048 }, (_, i) => fn(i));
const sine = samples((i) => Math.sin(2 * Math.PI * i / 64));
const invert = sine.map((v) => -v);
const silence = new Float32Array(2048);

describe("stereo audio measurements", () => {
  it("measures a full-scale sine as 0 dBFS sample peak and -3.01 dBFS RMS", () => {
    const result = measureStereo(sine, sine);
    expect(amplitudeDb(result.peakL)).toBeCloseTo(0, 5);
    expect(amplitudeDb(result.rmsL)).toBeCloseTo(-3.0103, 3);
    expect(result.correlation).toBeCloseTo(1);
  });
  it("distinguishes polarity inversion from silence and hard panning", () => {
    expect(measureStereo(sine, invert).correlation).toBeCloseTo(-1);
    expect(measureStereo(sine, silence).correlation).toBeNull();
    expect(measureStereo(silence, silence).correlation).toBeNull();
    expect(amplitudeDb(0)).toBe(-Infinity);
  });
  it("maps mono vertically, anti-phase horizontally, and keeps L/R orientation", () => {
    expect(polarSample(0.5, 0.5).x).toBe(0);
    expect(polarSample(0.5, -0.5).y).toBe(0);
    expect(polarSample(1, 0).x).toBeLessThan(0);
    expect(polarSample(-1, 0).x).toBeLessThan(0);
    expect(polarSample(0, 1).x).toBeGreaterThan(0);
    expect(polarSample(0, -1).x).toBeGreaterThan(0);
  });
  it("aggregates polar levels without amplifying silence or quiet signals", () => {
    expect([...polarLevels(silence, silence, 90)].every((v) => v === 0)).toBe(true);
    const full = Math.max(...polarLevels(sine, sine, 90));
    const quiet = sine.map((v) => v * 0.1);
    expect(Math.max(...polarLevels(quiet, quiet, 90)) / full).toBeCloseTo(0.1, 5);
  });
});
