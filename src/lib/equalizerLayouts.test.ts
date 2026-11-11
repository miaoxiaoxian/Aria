import { afterEach, describe, expect, it, vi } from "vitest";
import { equalizerCurvePath, readCachedEqualizerSettings, readCachedEqualizerPresets, writeCachedEqualizerSettings, sanitizeEqualizerBands, parseEqualizerPresetImport } from "./equalizer";
import { createRequire } from "node:module";
const { MpvAudioEngine } = createRequire(import.meta.url)("../../electron/mpvEngine.cjs");
afterEach(() => vi.unstubAllGlobals());
describe("10/31 EQ", () => {
  it("retains a 31-band curve through save and reload", () => {
    const data = new Map<string,string>();
    vi.stubGlobal("window", {localStorage:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)}});
    const bands=Array.from({length:31},(_,i)=>(i-15)/2);
    writeCachedEqualizerSettings({enabled:true,preset:"custom",bands});
    expect(readCachedEqualizerSettings().bands).toEqual(bands);
    expect(equalizerCurvePath(bands).match(/ C /g)).toHaveLength(30);
  });
  it("backs up legacy settings/presets and converts 18 bands without changing 31", () => {
    const settings=JSON.stringify({enabled:true,mode:"18",gains:{"18":Array(18).fill(3),"31":Array(31).fill(-2)}});
    const presets=JSON.stringify([{id:"p",name:"旧预设",mode:"18",gains:Array(18).fill(4),createdAt:1}]);
    const data=new Map([["aria-equalizer-settings",settings],["aria-equalizer-presets",presets]]);
    vi.stubGlobal("window", {localStorage:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v)}});
    expect(readCachedEqualizerSettings().bands).toEqual(Array(10).fill(3));
    expect(readCachedEqualizerPresets()[0].bands).toEqual(Array(10).fill(4));
    expect(data.get("aria-equalizer-settings-backup-18")).toBe(settings);
    expect(data.get("aria-equalizer-presets-backup-18")).toBe(presets);
    expect(JSON.parse(data.get("aria-equalizer-layout-curves-v2")!)["31"]).toEqual(Array(31).fill(-2));
    writeCachedEqualizerSettings({enabled:false,preset:"flat",bands:Array(10).fill(0)});
    expect(readCachedEqualizerSettings().bands).toEqual(Array(10).fill(0));
    expect(data.get("aria-equalizer-settings-backup-18")).toBe(settings);
  });
  it("sends all 31 frequencies to mpv, preserves normalization, and removes EQ on bypass",async()=>{
    const engine=Object.create(MpvAudioEngine.prototype);engine.normalizationQueue=Promise.resolve();engine.state={};const calls:unknown[][]=[];
    engine.command=async(...args:unknown[])=>{calls.push(args);return args[0]==="get_property"?[{label:"aria-normalization"}]:undefined;};
    await engine.setEqualizer(true,Array(31).fill(2));
    expect(calls.some(c=>String(c[2]).includes("equalizer=f=20000:width_type=q:width=4.32:g=2"))).toBe(true);
    expect(calls.some(c=>c[1]==="remove" && c[2]==="@aria-normalization")).toBe(false);
    engine.command=async(...args:unknown[])=>{calls.push(args);return args[0]==="get_property"?[{label:"aria-normalization"},{label:"aria-eq"}]:undefined;};
    await engine.setEqualizer(false,Array(31).fill(2));
    expect(calls.some(c=>c[1]==="remove" && c[2]==="@aria-eq")).toBe(true);
    expect(sanitizeEqualizerBands(Array(31).fill(20))).toEqual(Array(31).fill(12));
  });
});

it("imports GraphicEQ into 31 bands and retains legacy 31-band presets",()=>{
 const eq=parseEqualizerPresetImport("GraphicEQ: 20 3; 1000 3; 20000 3",31);expect(eq.error).toBeNull();expect(eq.presets[0].bands).toEqual(Array(31).fill(3));
 const legacy=parseEqualizerPresetImport(JSON.stringify({curves:{"18":Array(18).fill(2),"31":Array(31).fill(1)}}));expect(legacy.presets.map(p=>p.bands.length)).toEqual([10,31]);
});
