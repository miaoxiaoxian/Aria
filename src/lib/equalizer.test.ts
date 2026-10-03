import { describe, expect, it } from "vitest";
import {
  buildEqualizerExportPayload,
  buildGraphicEqText,
  buildMpvEqualizerFilter,
  createDefaultEqualizerSettings,
  detectEqualizerPreset,
  equalizerBandsForMode,
  equalizerPresets,
  parseEqualizerImport,
  presetGainsForMode,
  presetsFromImport,
  upsertEqualizerPreset,
  withEqualizerBand,
  withEqualizerGains,
  type EqualizerCustomPreset,
  type EqualizerSettings,
} from "@/lib/equalizer";

function settingsWith(mode: "18" | "31", gains: number[]): EqualizerSettings {
  const base = createDefaultEqualizerSettings();
  return { ...withEqualizerGains({ ...base, mode }, gains), enabled: true };
}

describe("equalizer band layouts", () => {
  it("exposes the requested 18-band frequencies", () => {
    expect(equalizerBandsForMode("18").map((band) => band.frequency)).toEqual([
      55, 77, 110, 156, 220, 331, 440, 622, 880, 1200, 1800, 2500, 3500, 5000, 7000, 10000, 14000, 20000,
    ]);
  });

  it("exposes the ISO 1/3-octave 31-band frequencies", () => {
    const frequencies = equalizerBandsForMode("31").map((band) => band.frequency);
    expect(frequencies).toHaveLength(31);
    expect(frequencies[0]).toBe(20);
    expect(frequencies.at(-1)).toBe(20000);
    expect(frequencies).toContain(1000);
  });

  it("labels kilohertz bands compactly", () => {
    const labels = equalizerBandsForMode("18").map((band) => band.label);
    expect(labels).toContain("1.2k");
    expect(labels).toContain("20k");
    expect(labels).toContain("55");
  });
});

describe("preset interpolation", () => {
  it("round-trips every preset through detection on both layouts", () => {
    for (const mode of ["18", "31"] as const) {
      for (const preset of equalizerPresets) {
        const settings = settingsWith(mode, presetGainsForMode(preset, mode));
        expect(detectEqualizerPreset(settings)?.id, `${mode}/${preset.id}`).toBe(preset.id);
      }
    }
  });

  it("keeps the untouched layout when editing bands", () => {
    const base = settingsWith("31", new Array(31).fill(0));
    const edited = withEqualizerBand({ ...base, mode: "18" }, 0, 5);
    expect(edited.gains["18"][0]).toBe(5);
    expect(edited.gains["31"].every((gain) => gain === 0)).toBe(true);
  });
});

describe("mpv filter chain", () => {
  it("is empty for a disabled or flat curve", () => {
    expect(buildMpvEqualizerFilter(createDefaultEqualizerSettings())).toBe("");
    expect(buildMpvEqualizerFilter(settingsWith("31", new Array(31).fill(0)))).toBe("");
  });

  it("emits one peaking filter per non-zero band with the layout Q", () => {
    const wide = settingsWith("18", [3, ...new Array(17).fill(0)]);
    expect(buildMpvEqualizerFilter(wide)).toBe("equalizer=f=55:t=q:w=2.87:g=3.0");

    const dense = settingsWith("31", [4, ...new Array(30).fill(0)]);
    expect(buildMpvEqualizerFilter(dense)).toBe("equalizer=f=20:t=q:w=4.32:g=4.0");
  });
});

describe("export and import", () => {
  it("round-trips a JSON export including custom presets", () => {
    const settings = settingsWith("18", [1, 2, 3, ...new Array(15).fill(0)]);
    const preset: EqualizerCustomPreset = {
      id: "preset-1",
      name: "我的低音",
      mode: "18",
      gains: settings.gains["18"],
      createdAt: Date.now(),
    };
    const payload = buildEqualizerExportPayload(settings, [preset]);
    const parsed = parseEqualizerImport(JSON.stringify(payload), "31");

    expect(parsed.format).toBe("aria");
    expect(parsed.settings?.mode).toBe("18");
    expect(parsed.settings?.gains["18"]).toEqual(settings.gains["18"]);
    expect(parsed.presets).toHaveLength(1);
    expect(parsed.presets[0].name).toBe("我的低音");
    expect(parsed.warnings).toEqual([]);
  });

  it("reads a GraphicEQ line onto the active layout", () => {
    const text = "GraphicEQ: 20 -6.0; 100 -3.0; 1000 0.0; 10000 3.0; 20000 6.0";
    const parsed = parseEqualizerImport(text, "18");
    expect(parsed.format).toBe("graphiceq");
    expect(parsed.curve?.mode).toBe("18");
    expect(parsed.curve?.gains).toHaveLength(18);
    // 55Hz sits between the 20Hz (-6) and 100Hz (-3) anchors.
    const first = parsed.curve?.gains[0] ?? 0;
    expect(first).toBeGreaterThan(-6);
    expect(first).toBeLessThan(-3);
    // Bands at or above the last anchor inherit its gain.
    expect(parsed.curve?.gains.at(-1)).toBe(6);
  });

  it("reads a plain 31-number list", () => {
    const values = Array.from({ length: 31 }, (_value, index) => (index === 5 ? 4.5 : 0));
    const parsed = parseEqualizerImport(values.join(", "), "18");
    expect(parsed.curve?.mode).toBe("31");
    expect(parsed.curve?.gains[5]).toBe(4.5);
  });

  it("reads a 10-value list by interpolating onto the active layout", () => {
    const parsed = parseEqualizerImport("6 5 4 2 0 -1 -2 -3 -4 -5", "18");
    expect(parsed.curve?.mode).toBe("18");
    expect(parsed.curve?.gains[0]).toBeGreaterThan(4);
    expect(parsed.curve?.gains.at(-1) ?? 0).toBeLessThan(0);
  });

  it("reads frequency/gain text", () => {
    const parsed = parseEqualizerImport("31:-2\n125:0\n1000:2.5\n16000:-3.5", "31");
    expect(parsed.curve?.mode).toBe("31");
    expect(parsed.curve?.gains).toHaveLength(31);
  });

  it("warns instead of throwing on unusable input", () => {
    const parsed = parseEqualizerImport("这不是均衡器文件", "31");
    expect(parsed.curve).toBeNull();
    expect(parsed.settings).toBeNull();
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it("exports a GraphicEQ text that parses back", () => {
    const settings = settingsWith("31", Array.from({ length: 31 }, () => 2));
    const text = buildGraphicEqText(settings);
    expect(text.startsWith("GraphicEQ: ")).toBe(true);
    const parsed = parseEqualizerImport(text, "18");
    expect(parsed.format).toBe("graphiceq");
    expect(parsed.curve?.gains.every((gain) => gain === 2)).toBe(true);
  });
});

describe("custom preset library", () => {
  it("saves a curve and overwrites the same name in the same layout", () => {
    const settings = settingsWith("31", [1, ...new Array(30).fill(0)]);
    const first = upsertEqualizerPreset([], "夜间", settings);
    expect(first).toHaveLength(1);
    expect(first[0].mode).toBe("31");

    const changed = settingsWith("31", [5, ...new Array(30).fill(0)]);
    const second = upsertEqualizerPreset(first, "夜间", changed);
    expect(second).toHaveLength(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].gains[0]).toBe(5);
  });

  it("keeps presets of the other layout separate", () => {
    const wide = settingsWith("18", [2, ...new Array(17).fill(0)]);
    const dense = settingsWith("31", [3, ...new Array(30).fill(0)]);
    const library = upsertEqualizerPreset(upsertEqualizerPreset([], "同名", wide), "同名", dense);
    expect(library).toHaveLength(2);
    expect(library.map((preset) => preset.mode).sort()).toEqual(["18", "31"]);
  });

  it("never lets a custom preset shadow the built-in 平直 baseline", () => {
    const flat = settingsWith("31", new Array(31).fill(0));
    const library = upsertEqualizerPreset([], "平直", flat);
    expect(library[0].name).toBe("平直 · 自定义");
    // The built-in preset itself stays the all-zero baseline.
    expect(equalizerPresets.find((preset) => preset.label === "平直")?.anchors.every((gain) => gain === 0)).toBe(true);
  });
});

describe("import keeps the working curve untouched", () => {
  it("turns a curves-only file into named presets for both layouts", () => {
    const settings = settingsWith("31", [4, ...new Array(30).fill(0)]);
    const payload = buildEqualizerExportPayload(settings, []);
    const parsed = parseEqualizerImport(JSON.stringify(payload), "31");
    const presets = presetsFromImport(parsed, "hd600 to he1.json");

    expect(presets).toHaveLength(2);
    expect(presets.map((preset) => preset.name)).toEqual(["hd600 to he1 (18 段)", "hd600 to he1 (31 段)"]);
    expect(presets.find((preset) => preset.mode === "31")?.gains[0]).toBe(4);
  });

  it("keeps presets that the file already carries", () => {
    const settings = settingsWith("18", [1, ...new Array(17).fill(0)]);
    const payload = buildEqualizerExportPayload(settings, [
      { id: "p1", name: "我的低音", mode: "18", gains: settings.gains["18"], createdAt: 1 },
    ]);
    const presets = presetsFromImport(parseEqualizerImport(JSON.stringify(payload), "31"), "x.json");
    expect(presets.map((preset) => preset.name)).toEqual(["我的低音"]);
  });

  it("turns a GraphicEQ file into a single preset named after the file", () => {
    const parsed = parseEqualizerImport("GraphicEQ: 20 6; 1000 -3; 20000 2", "31");
    const presets = presetsFromImport(parsed, "curve.txt");
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe("curve (31 段)");
    expect(presets[0].mode).toBe("31");
  });
});
