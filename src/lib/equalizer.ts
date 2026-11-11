export const equalizerFrequencies = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;

export const equalizer31Frequencies = [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
export function frequenciesForBands(bands: readonly number[]) { return bands.length === 31 ? equalizer31Frequencies : [...equalizerFrequencies]; }
export function resampleBands(values: number[], from: readonly number[], to: readonly number[]) {
  return to.map(f => { let hi=from.findIndex(x=>x>=f); if(hi<0)hi=from.length-1; if(hi===0)return Number(values[0])||0;const lo=hi-1;const t=Math.max(0,Math.min(1,Math.log(f/from[lo])/Math.log(from[hi]/from[lo])));return Math.round(((Number(values[lo])||0)*(1-t)+(Number(values[hi])||0)*t)*2)/2; });
}
const legacy18 = [55,77,110,156,220,331,440,622,880,1200,1800,2500,3500,5000,7000,10000,14000,20000];
function migrateStorage() {
  const storage=window.localStorage;
  const raw=storage.getItem("aria-equalizer-settings");
  if(raw && !storage.getItem(equalizerStorageKey)) {
    const old=JSON.parse(raw);const curves={"10":resampleBands(old.gains?.["18"]??[],legacy18,equalizerFrequencies),"31":sanitizeEqualizerBands(Array.isArray(old.gains)?old.gains:(old.gains?.["31"]??Array(31).fill(0)))};
    if(!storage.getItem("aria-equalizer-settings-backup-18"))storage.setItem("aria-equalizer-settings-backup-18",raw);
    storage.setItem("aria-equalizer-layout-curves-v2",JSON.stringify(curves));
    storage.setItem(equalizerStorageKey,JSON.stringify({enabled:!!old.enabled,preset:"custom",bands:old.mode==="18"?curves["10"]:curves["31"]}));
  }
  const presets=storage.getItem("aria-equalizer-presets");
  if(presets && !storage.getItem(equalizerPresetsStorageKey)) {
    const old=JSON.parse(presets);if(!Array.isArray(old))return;
    if(!storage.getItem("aria-equalizer-presets-backup-18"))storage.setItem("aria-equalizer-presets-backup-18",presets);
    storage.setItem(equalizerPresetsStorageKey,JSON.stringify(old.map(p=>({...p,bands:p.mode==="18"?resampleBands(p.gains??[],legacy18,equalizerFrequencies):sanitizeEqualizerBands(p.gains)}))));
  }
}

export type EqualizerPresetId = "flat" | "pop" | "rock" | "vocal" | "bass" | "electronic" | "loudness" | "custom";

export type EqualizerSettings = {
  enabled: boolean;
  preset: EqualizerPresetId;
  bands: number[];
};

export const equalizerPresets: Array<{ id: EqualizerPresetId; label: string; description: string; bands: number[] }> = [
  { id: "flat", label: "平直", description: "不改变原始声音", bands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "pop", label: "流行", description: "明亮人声与轻快节奏", bands: [-1, 0, 1, 3, 4, 3, 1, -1, -2, -2] },
  { id: "rock", label: "摇滚", description: "厚实低频与吉他存在感", bands: [4, 3, 2, 0, -1, 1, 3, 4, 3, 2] },
  { id: "vocal", label: "人声", description: "突出中频与咬字细节", bands: [-2, -1, 0, 2, 4, 4, 2, 0, -1, -2] },
  { id: "bass", label: "低音", description: "更深的低频与下潜", bands: [6, 5, 3, 1, 0, 0, -1, -1, 0, 0] },
  { id: "electronic", label: "电子", description: "强劲低频与明亮高频", bands: [4, 3, 1, 0, -2, 1, 2, 3, 4, 4] },
  { id: "loudness", label: "等响度", description: "小音量下补足两端，接近等响曲线", bands: [6, 5, 3, 1, 0, -1, -1, 1, 3, 5] },
];

const equalizerStorageKey = "aria-equalizer-settings-v1";
export const maxEqualizerGain = 12;

export function sanitizeEqualizerBands(value: unknown): number[] {
  const source = Array.isArray(value) ? value : [];
  return (source.length === 31 ? equalizer31Frequencies : equalizerFrequencies).map((_, index) => {
    const gain = Number(source[index]);
    if (!Number.isFinite(gain)) return 0;
    return Math.max(-maxEqualizerGain, Math.min(maxEqualizerGain, Math.round(gain * 10) / 10));
  });
}

export function equalizerPresetBands(id: EqualizerPresetId) {
  return equalizerPresets.find((preset) => preset.id === id)?.bands ?? equalizerPresets[0].bands;
}

export function defaultEqualizerSettings(): EqualizerSettings {
  return { enabled: false, preset: "flat", bands: [...equalizerPresets[0].bands] };
}

export function readCachedEqualizerSettings(): EqualizerSettings {
  try {
    migrateStorage();
    const raw = window.localStorage.getItem(equalizerStorageKey);
    if (!raw) return defaultEqualizerSettings();
    const parsed = JSON.parse(raw) as Partial<EqualizerSettings>;
    const preset = equalizerPresets.some((item) => item.id === parsed.preset) || parsed.preset === "custom"
      ? parsed.preset as EqualizerPresetId
      : (parsed.preset as string) === "night" ? "custom" : "flat";
    return {
      enabled: Boolean(parsed.enabled),
      preset,
      bands: sanitizeEqualizerBands(parsed.bands),
    };
  } catch {
    return defaultEqualizerSettings();
  }
}

export function writeCachedEqualizerSettings(settings: EqualizerSettings) {
  try {
    window.localStorage.setItem(equalizerStorageKey, JSON.stringify({
      enabled: Boolean(settings.enabled),
      preset: settings.preset,
      bands: sanitizeEqualizerBands(settings.bands),
    }));
    return true;
  } catch {
    return false;
  }
}

export type EqualizerCustomPreset = {
  id: string;
  name: string;
  bands: number[];
  createdAt: number;
};

const equalizerPresetsStorageKey = "aria-equalizer-presets-v1";
export const maxEqualizerCustomPresets = 30;
export const maxEqualizerPresetNameLength = 24;

function createPresetId(now: number) {
  return `equalizer-preset:${now.toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

export function createEqualizerCustomPreset(name: string, bands: number[], now = Date.now()): EqualizerCustomPreset {
  const trimmed = name.trim().slice(0, maxEqualizerPresetNameLength) || "我的预设";
  return { id: createPresetId(now), name: trimmed, bands: sanitizeEqualizerBands(bands), createdAt: now };
}

export function sanitizeEqualizerCustomPresets(value: unknown): EqualizerCustomPreset[] {
  const source = Array.isArray(value) ? value : Array.isArray((value as { presets?: unknown })?.presets) ? (value as { presets: unknown[] }).presets : [];
  const seen = new Set<string>();
  const presets: EqualizerCustomPreset[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<EqualizerCustomPreset>;
    const name = typeof record.name === "string" ? record.name.trim().slice(0, maxEqualizerPresetNameLength) : "";
    if (!name) continue;
    const createdAt = Number(record.createdAt);
    const id = typeof record.id === "string" && record.id.trim() && !seen.has(record.id.trim())
      ? record.id.trim()
      : createPresetId(Number.isFinite(createdAt) ? createdAt : Date.now());
    if (seen.has(id)) continue;
    seen.add(id);
    presets.push({
      id,
      name,
      bands: sanitizeEqualizerBands(record.bands),
      createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
    });
    if (presets.length >= maxEqualizerCustomPresets) break;
  }
  return presets;
}

export function readCachedEqualizerPresets(): EqualizerCustomPreset[] {
  try {
    migrateStorage();
    const raw = window.localStorage.getItem(equalizerPresetsStorageKey);
    if (!raw) return [];
    return sanitizeEqualizerCustomPresets(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeCachedEqualizerPresets(presets: EqualizerCustomPreset[]) {
  try {
    window.localStorage.setItem(equalizerPresetsStorageKey, JSON.stringify(sanitizeEqualizerCustomPresets(presets)));
    return true;
  } catch {
    return false;
  }
}

export function equalizerPresetFileName(now = new Date()) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `aria-equalizer-presets-${stamp}.json`;
}

export function equalizerPresetExportPayload(presets: EqualizerCustomPreset[]) {
  return JSON.stringify({
    app: "Aria",
    kind: "equalizer-presets",
    version: 1,
    exportedAt: new Date().toISOString(),
    frequencies: [...equalizerFrequencies],
    presets: sanitizeEqualizerCustomPresets(presets).map(({ name, bands }) => ({ name, bands })),
  }, null, 2);
}

export function parseEqualizerPresetImport(raw: unknown, bandCount = 10): { presets: EqualizerCustomPreset[]; error: string | null } {
  const target = bandCount === 31 ? equalizer31Frequencies : equalizerFrequencies;
  if (typeof raw === "string" && /graphiceq:/i.test(raw)) {
    const pairs = [...raw.matchAll(/(\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)].map(m=>({frequency:Number(m[1]),gain:Number(m[2])})).filter(p=>p.frequency>=10&&p.frequency<=24000&&Math.abs(p.gain)<=40).sort((a,b)=>a.frequency-b.frequency);
    if (pairs.length < 2) return {presets:[],error:"GraphicEQ 至少需要两个有效频点。"};
    return {presets:[createEqualizerCustomPreset("GraphicEQ 导入",resampleBands(pairs.map(p=>p.gain),pairs.map(p=>p.frequency),target))],error:null};
  }
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { presets: [], error: "文件不是有效的 JSON，请选择 Aria 导出的均衡器预设文件。" };
    }
  }
  if (parsed && typeof parsed === "object" && "curves" in parsed) {
    const legacy = parsed as {curves?: {"18"?: number[]; "31"?: number[]; "10"?: number[]}; presets?: Array<{name:string;mode:string;gains:number[]}>};
    const entries: EqualizerCustomPreset[] = [];
    if(legacy.curves?.["18"]) entries.push(createEqualizerCustomPreset("18段曲线转换",resampleBands(legacy.curves["18"],legacy18,equalizerFrequencies)));
    if(legacy.curves?.["10"]) entries.push(createEqualizerCustomPreset("10段曲线",legacy.curves["10"]));
    if(legacy.curves?.["31"]) entries.push(createEqualizerCustomPreset("31段曲线",legacy.curves["31"]));
    for(const item of legacy.presets??[]) if(Array.isArray(item.gains)) entries.push(createEqualizerCustomPreset(item.name,item.mode==="18"?resampleBands(item.gains,legacy18,equalizerFrequencies):item.gains));
    return {presets:entries,error:entries.length?null:"预设内容为空。"};
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { presets?: unknown }).presets)
      ? (parsed as { presets: unknown[] }).presets
      : parsed && typeof parsed === "object" && "bands" in parsed
        ? [parsed]
        : null;
  if (!list) {
    return { presets: [], error: "没有在文件中找到均衡器预设列表。" };
  }
  const presets = sanitizeEqualizerCustomPresets(list);
  if (!presets.length) {
    return { presets: [], error: "预设内容为空或格式不正确，未导入任何预设。" };
  }
  return { presets, error: null };
}

export function equalizerBandsMatch(a: number[], b: number[]) {
  const left = sanitizeEqualizerBands(a);
  const right = sanitizeEqualizerBands(b);
  return left.length === right.length && left.every((gain, index) => Math.abs(gain - right[index]) < 0.05);
}

/** Smooth cubic curve for the animated response graph.
 *  Points sit at the centre of each band column so the curve, the grid and the
 *  draggable handles all share one coordinate system. */
export function equalizerCurvePath(bands: number[], width = 720, height = 180) {
  const values = sanitizeEqualizerBands(bands);
  const points = values.map((gain, index) => ({
    x: (width * (index + 0.5)) / Math.max(1, values.length),
    y: height * (1 - (gain + maxEqualizerGain) / (maxEqualizerGain * 2)),
  }));
  if (!points.length) return "";
  let path = `M ${points[0].x.toFixed(1)} ${points[0].y.toFixed(1)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const midpoint = (previous.x + current.x) / 2;
    path += ` C ${midpoint.toFixed(1)} ${previous.y.toFixed(1)}, ${midpoint.toFixed(1)} ${current.y.toFixed(1)}, ${current.x.toFixed(1)} ${current.y.toFixed(1)}`;
  }
  return path;
}
