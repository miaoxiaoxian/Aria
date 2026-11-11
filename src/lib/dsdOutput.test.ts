import { afterEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { dsdOutputSettings, isLocalDsd } from "./dsdOutput";
import { readCachedAudioSettings, writeCachedAudioSettings } from "./playerPresentation";
const { MpvAudioEngine } = createRequire(import.meta.url)("../../electron/mpvEngine.cjs");
afterEach(() => vi.unstubAllGlobals());

it("only applies DSD settings to local DSD, never QQ or Bilibili", () => {
  const local = { source: "local" as const, format: "DSF", filePath: "C:\\music\\song.dsf" };
  expect(isLocalDsd(local)).toBe(true);
  expect(dsdOutputSettings(local, "176400", true, false)).toEqual({ isDsd: true, samplerate: 176400, exclusive: true });
  for (const source of ["qq", "bilibili", "netease"] as const) {
    expect(dsdOutputSettings({ ...local, source }, "176400", true, false)).toEqual({ isDsd: false, samplerate: 0, exclusive: false });
  }
  expect(dsdOutputSettings({ ...local, format: "FLAC", filePath: "song.flac" }, "176400", true, false)).toEqual({ isDsd: false, samplerate: 0, exclusive: false });
  expect(dsdOutputSettings(local, "auto", false, false)).toEqual({ isDsd: true, samplerate: 0, exclusive: false });
});

it("preserves ASIO settings when output settings are saved, and keeps DoP inactive", () => {
  const data = new Map<string, string>();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value) } });
  const base = { sinkId: "default", hifiEnabled: true, masterQualityEnabled: false, gaplessEnabled: false, exclusiveMode: false, outputMode: "system" as const };
  writeCachedAudioSettings({ ...base, asioDriver: "driver", asioDsdMode: "pcm", asioChannels: { left: 2, right: 3 }, dsdPlayback: "dop", dsdPcmRate: "88200" });
  writeCachedAudioSettings({ ...base, normalizationEnabled: true });
  expect(readCachedAudioSettings()).toMatchObject({ asioDriver: "driver", asioDsdMode: "pcm", asioChannels: { left: 2, right: 3 }, dsdPlayback: "d2p", dsdPcmRate: "88200", normalizationEnabled: true });
});

it("pins the native sample rate and resets it for the next PCM load without disturbing EQ", async () => {
  const engine = Object.create(MpvAudioEngine.prototype);
  const calls: unknown[][] = [];
  engine.state = { exclusive: false, normalizationEnabled: undefined };
  engine.ensureProcess = async () => undefined;
  engine.emit = () => undefined;
  engine.snapshot = () => engine.state;
  engine.writeLog = () => undefined;
  engine.command = async (...args: unknown[]) => { calls.push(args); return undefined; };
  await engine.applyOutputSettings({ samplerate: 88200 });
  await engine.applyOutputSettings({ samplerate: 0 });
  expect(calls).toEqual([["set_property", "audio-samplerate", 88200], ["set_property", "audio-samplerate", 0]]);
  expect(engine.state.samplerate).toBe(0);
  await expect(engine.applyOutputSettings({ samplerate: 12345 })).rejects.toThrow("Unsupported");
});
