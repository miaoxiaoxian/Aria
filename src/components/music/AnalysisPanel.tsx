import { useEffect, useRef, useState } from "react";
import { Activity, ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { analysisOptions, amplitudeDb, measureStereo, polarLevels, polarSample, type AnalysisMode, type FieldMode, type StereoAnalysers } from "@/lib/audioAnalysis";
import { cn } from "@/lib/utils";

export function useAnalysisMode() {
  const [mode, setMode] = useState<AnalysisMode>(() => {
    try {
      const saved = localStorage.getItem("aria-analysis-mode");
      return analysisOptions.find((option) => option.id === saved)?.id ?? "original";
    } catch { return "original"; }
  });
  return [mode, (next: AnalysisMode) => {
    setMode(next);
    try { localStorage.setItem("aria-analysis-mode", next); } catch { /* Storage may be unavailable. */ }
  }] as const;
}

type SpectrogramView = "2d" | "3d";
function useSpectrogramView() {
  const read = (): SpectrogramView => { try { return localStorage.getItem("aria-spectrogram-view") === "2d" ? "2d" : "3d"; } catch { return "3d"; } };
  const [view, setView] = useState<SpectrogramView>(read);
  useEffect(() => {
    const sync = () => setView(read());
    window.addEventListener("aria-spectrogram-change", sync);
    return () => window.removeEventListener("aria-spectrogram-change", sync);
  }, []);
  return [view, (next: SpectrogramView) => {
    setView(next);
    try { localStorage.setItem("aria-spectrogram-view", next); } catch { /* Optional persistence. */ }
    window.dispatchEvent(new Event("aria-spectrogram-change"));
  }] as const;
}
function SpectrogramSwitch({ view, onChange, dark = false }: { view: SpectrogramView; onChange: (value: SpectrogramView) => void; dark?: boolean }) {
  return <div role="group" aria-label="声谱图显示方式" className={cn("inline-flex rounded-full p-0.5", dark ? "bg-white/10" : "bg-neutral-950/5")}>
    {(["2d", "3d"] as const).map((value) => <button key={value} aria-pressed={view === value} onClick={() => onChange(value)} className={cn("rounded-full px-2.5 py-1 text-[10px] font-medium", view === value ? dark ? "bg-white/85 text-neutral-950" : "bg-neutral-800 text-white" : dark ? "text-white/55" : "text-neutral-500")}>{value.toUpperCase()}</button>)}
  </div>;
}

export function AnalysisMenu({ mode, onChange, className, includeOriginal = true }: { mode: AnalysisMode; onChange: (mode: AnalysisMode) => void; className: string; includeOriginal?: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => { window.removeEventListener("pointerdown", dismiss); window.removeEventListener("keydown", escape); };
  }, [open]);
  return <div ref={rootRef} className="relative">
    <Button variant="glass" className={className} aria-label="选择音频分析模块" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Activity />{mode === "original" ? "分析" : analysisOptions.find((item) => item.id === mode)?.label}<ChevronDown />
    </Button>
    {open && <div role="menu" aria-label="音频分析" className="absolute left-0 top-full z-40 mt-2 w-44 rounded-2xl border border-white/80 bg-white/95 p-1.5 shadow-xl backdrop-blur-2xl">
      {analysisOptions.filter(item => includeOriginal || item.id !== "original").map((item) => <button key={item.id} role="menuitemradio" aria-checked={mode === item.id} className="flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-100 focus-visible:bg-neutral-100" onClick={() => { onChange(item.id); setOpen(false); rootRef.current?.querySelector('button')?.focus(); }}>
        {item.label}{mode === item.id && <Check className="size-3.5" />}
      </button>)}
    </div>}
  </div>;
}

const fieldOptions: { id: FieldMode; label: string }[] = [
  { id: "polar-sample", label: "Polar Sample" },
  { id: "polar-level", label: "Polar Level" },
  { id: "lissajous", label: "Lissajous" },
];

export function AnalysisPanel({ mode, onChange, analysersRef, playing, active, nativeCopy, note, trackId, hideTabs = false }: {
  mode: Exclude<AnalysisMode, "original">;
  onChange: (mode: AnalysisMode) => void;
  analysersRef: StereoAnalysers;
  playing: boolean;
  active: boolean;
  nativeCopy: boolean;
  note?: string | null;
  trackId: string;
  hideTabs?: boolean;
}) {
  const [spectrogramView, setSpectrogramView] = useSpectrogramView();
  const [fieldMode, setFieldMode] = useState<FieldMode>("polar-sample");
  const [fieldGain, setFieldGain] = useState(() => {
    try {
      const value = Number(localStorage.getItem("aria-field-gain"));
      return value >= 1 && value <= 3 && Number.isInteger(value * 2) ? value : 2.5;
    } catch { return 2.5; }
  });
  return <section aria-label="音频分析面板" className="rounded-2xl bg-white/35 p-2.5">
    {!hideTabs && <div className="flex flex-wrap items-center gap-1" role="group" aria-label="分析模块">
      {analysisOptions.map((option) => <button key={option.id} aria-pressed={mode === option.id} onClick={() => onChange(option.id)} className={cn("rounded-full px-2 py-1 text-[10px] font-medium transition", mode === option.id ? "bg-neutral-800 text-white" : "text-neutral-500 hover:bg-white/80")}>{option.label}</button>)}
    </div>}
    <div className="my-1.5 flex flex-wrap items-center justify-between gap-1 text-[9px] text-neutral-500">
      <span>{nativeCopy ? "mpv 分析副本 · 非设备输出测量" : "系统音频 · 均衡器后 / 标准化与音量前"}</span>
      <span>{mode === "levels" ? "采样峰值 / 窗口 RMS · dBFS" : mode === "spectrum" ? "双声道能量平均 · dBFS" : mode === "spectrogram" ? spectrogramView === "3d" ? "3D 瀑布 · 频率 / 时间 / 能量" : "2D · 频率 → / 时间 ↑ / 颜色表示能量" : "M/S · 相关度 −1 至 +1"}</span>
    </div>
    {mode === "field" && <div className="flex flex-wrap items-center justify-between gap-x-3"><div className="mb-1 flex gap-1" role="group" aria-label="声场模式">{fieldOptions.map((item) => <button key={item.id} aria-pressed={fieldMode === item.id} onClick={() => setFieldMode(item.id)} className={cn("rounded-full px-2 py-1 text-[10px]", fieldMode === item.id ? "bg-neutral-800 text-white" : "text-neutral-500 hover:bg-white/80")}>{item.label}</button>)}</div>
    <label className="mb-2 flex items-center gap-2 px-1 text-[10px] text-neutral-500">
      <span className="shrink-0">显示增益</span>
      <span>1</span>
      <input type="range" min={1} max={3} step={0.5} value={fieldGain} aria-label="声场显示增益" aria-valuetext={fieldGain + " 倍"} className="h-1 w-28 min-w-0 accent-neutral-700" onChange={(event) => {
        const value = Number(event.target.value);
        setFieldGain(value);
        try { localStorage.setItem("aria-field-gain", String(value)); } catch { /* Storage may be unavailable. */ }
      }} />
      <span>3</span><output className="ml-1 w-8 tabular-nums">×{fieldGain}</output>
    </label></div>}
    {mode === "spectrogram" && <div className="mb-2 flex justify-end"><SpectrogramSwitch view={spectrogramView} onChange={setSpectrogramView} /></div>}
    <AnalysisCanvas spectrogramView={spectrogramView} fieldGain={fieldGain} key={`${trackId}:${mode}:${fieldMode}:${spectrogramView}`} mode={mode} fieldMode={fieldMode} analysersRef={analysersRef} playing={playing} active={active} note={note} />
  </section>;
}

const dbText = (value: number) => value > 0 ? amplitudeDb(value).toFixed(1) : "−∞";
const floor = -90;
const ceiling = -10;
const clamp = (value: number) => Math.max(0, Math.min(1, value));

function AnalysisCanvas({ mode, fieldMode, fieldGain, analysersRef, playing, active, note, fill = false, spectrogramView = "3d" }: {
  mode: Exclude<AnalysisMode, "original">; fieldMode: FieldMode; fieldGain: number; spectrogramView?: SpectrogramView; fill?: boolean; analysersRef: StereoAnalysers; playing: boolean; active: boolean; note?: string | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const historyRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const history = historyRef.current ?? document.createElement("canvas");
    historyRef.current = history;
    const hc = history.getContext("2d");
    const waterfall: number[][] = [];
    const surfaceColors = Array.from({ length: 128 }, (_, i) => "hsl(170 45% " + (8 + i * 54 / 127) + "%)");
    let frame = 0, lastAt = 0, width = 0, height = 0;
    let left = new Float32Array(2048), right = new Float32Array(2048);
    let freqL = new Float32Array(1024), freqR = new Float32Array(1024);
    const resize = () => {
      width = Math.max(1, canvas.clientWidth); height = Math.max(1, canvas.clientHeight);
      const ratio = Math.min(mode === "spectrogram" ? 1.5 : 2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      if (history.width !== Math.round(width) || history.height !== Math.round(height)) {
        history.width = Math.round(width); history.height = Math.round(height);
      }
    };
    const text = (value: string, x: number, y: number, color = "#94a3b8") => { ctx.fillStyle = color; ctx.font = "10px system-ui"; ctx.fillText(value, x, y); };
    const line = (x: number, y: number, x2: number, y2: number, color = "#ffffff14") => { ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x2, y2); ctx.stroke(); };
    const paint = (now: number) => {
      if (active && playing) frame = requestAnimationFrame(paint);
      if (active && playing && now - lastAt < 40) return;
      const delta = lastAt ? Math.min(0.1, (now - lastAt) / 1000) : 0.04;
      lastAt = now;
      ctx.fillStyle = "#151b24"; ctx.fillRect(0, 0, width, height);
      if (!active || note) { text(note || "分析已暂停", 12, height / 2); return; }
      const nodes = analysersRef.current;
      if (!nodes) { text("等待可分析的音频信号", 12, height / 2); return; }
      if (left.length !== nodes[0].fftSize) {
        left = new Float32Array(nodes[0].fftSize); right = new Float32Array(nodes[1].fftSize);
        freqL = new Float32Array(nodes[0].frequencyBinCount); freqR = new Float32Array(nodes[1].frequencyBinCount);
      }
      if (playing) {
        if (mode === "levels" || mode === "field") { nodes[0].getFloatTimeDomainData(left); nodes[1].getFloatTimeDomainData(right); }
        else { nodes[0].getFloatFrequencyData(freqL); nodes[1].getFloatFrequencyData(freqR); }
      } else { left.fill(0); right.fill(0); freqL.fill(-Infinity); freqR.fill(-Infinity); }
      if (mode === "levels") {
        const values = measureStereo(left, right);
        const top = 28, bottom = height - 20, span = bottom - top;
        for (let db = 0; db >= -60; db -= 12) {
          const y = top + (-db / 60) * span;
          line(28, y, width - 10, y); text(String(db), 3, y + 3);
        }
        const channels = [{ name: "L", peak: values.peakL, rms: values.rmsL }, { name: "R", peak: values.peakR, rms: values.rmsR }];
        channels.forEach((channel, index) => {
          const x = 45 + index * ((width - 55) / 2), barWidth = Math.max(12, (width - 100) / 4);
          const peakY = top + (1 - clamp((amplitudeDb(channel.peak) + 60) / 60)) * span;
          const rmsY = top + (1 - clamp((amplitudeDb(channel.rms) + 60) / 60)) * span;
          ctx.fillStyle = "#2dd4bf"; ctx.fillRect(x, rmsY, barWidth, bottom - rmsY);
          line(x, peakY, x + barWidth, peakY, channel.peak >= 1 ? "#fb7185" : "#e2e8f0");
          text(`${channel.name}  P ${dbText(channel.peak)} / RMS ${dbText(channel.rms)}`, x - 8, 15, channel.peak >= 1 ? "#fb7185" : "#cbd5e1");
          text(channel.name, x + barWidth / 2 - 3, height - 5);
        });
      } else if (mode === "spectrum" || mode === "spectrogram") {
        const x0 = 28, x1 = width - 8, y0 = 10, y1 = height - 18;
        const maxHz = 20000;
        const logSpan = Math.log(maxHz / 20);
        // Energy average avoids cancelling opposite-phase stereo signals.
        const dbAt = (position: number) => {
          const hz = 20 * Math.exp(position * logSpan);
          if (hz > nodes[0].context.sampleRate / 2) return floor;
          const fractionalBin = Math.max(0, Math.min(freqL.length - 1, hz / nodes[0].context.sampleRate * nodes[0].fftSize));
          const low = Math.floor(fractionalBin), high = Math.min(freqL.length - 1, low + 1);
          const mix = fractionalBin - low;
          const energyDb = (bin: number) => {
            const power = (Math.pow(10, freqL[bin] / 10) + Math.pow(10, freqR[bin] / 10)) / 2;
            return power > 0 ? Math.max(-120, 10 * Math.log10(power)) : -120;
          };
          // Interpolate between FFT bins on the log-frequency axis instead of
          // repeating the nearest bin across many low-frequency pixels.
          return energyDb(low) * (1 - mix) + energyDb(high) * mix;
        };
        if (mode === "spectrum") {
          [-10, -30, -50, -70, -90].forEach((db) => { const y = y0 + (ceiling - db) / (ceiling - floor) * (y1 - y0); line(x0, y, x1, y); text(String(db), 2, y + 3); });
          ctx.beginPath();
          for (let x = x0; x <= x1; x++) {
            const y = y1 - clamp((dbAt((x - x0) / (x1 - x0)) - floor) / (ceiling - floor)) * (y1 - y0);
            if (x === x0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          }
          ctx.strokeStyle = "#5eead4"; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
        } else if (spectrogramView === "2d" && hc) {
          const step = Math.max(1, Math.round(delta * 30));
          if (playing) {
            hc.drawImage(history, 0, -step);
            hc.fillStyle = "#151b24"; hc.fillRect(0, y1 - step, width, step);
            for (let x = x0; x < x1; x += 2) {
              const level = clamp((dbAt((x - x0) / (x1 - x0)) - floor) / (ceiling - floor));
              hc.fillStyle = surfaceColors[Math.round(level * 127)];
              hc.fillRect(x, y1 - step, 2, step);
            }
          }
          ctx.drawImage(history, 0, 0);
          text("旧", 4, 15); text("新", 4, y1);
          [20, 100, 1000, 10000, 20000].forEach((hz) => {
            const x = x0 + Math.log(hz / 20) / logSpan * (x1 - x0);
            text(hz >= 1000 ? hz / 1000 + "k" : String(hz), Math.min(x - 6, width - 25), height - 4);
          });
        } else {
          const bands = 80, rows = 40;
          if (playing) {
            const raw = Array.from({ length: bands }, (_, i) => clamp((dbAt(i / (bands - 1)) - floor) / (ceiling - floor)));
            const previous = waterfall[0];
            waterfall.unshift(raw.map((value, i) => {
              const smooth = (raw[Math.max(0, i - 1)] + value * 3 + raw[Math.min(bands - 1, i + 1)]) / 5;
              return previous ? smooth * 0.8 + previous[i] * 0.2 : smooth;
            }));
            if (waterfall.length > rows) waterfall.pop();
          }
          const project = (frequency: number, depth: number, level: number) => {
            const scale = 1 - depth * 0.42;
            return { x: width / 2 + (frequency - 0.5) * (width - 55) * scale, y: height - 28 - depth * (height * 0.45) - level * height * 0.3 * scale };
          };
          // Join adjacent time slices into an opaque, shaded surface.
          for (let row = waterfall.length - 2; row >= 0; row--) {
            const near = row / (rows - 1), far = (row + 1) / (rows - 1);
            for (let i = 0; i < bands - 1; i++) {
              const a = waterfall[row][i], b = waterfall[row][i + 1];
              const c = waterfall[row + 1][i + 1], d = waterfall[row + 1][i];
              const points = [project(i / (bands - 1), near, a), project((i + 1) / (bands - 1), near, b), project((i + 1) / (bands - 1), far, c), project(i / (bands - 1), far, d)];
              const energy = (a + b + c + d) / 4;
              const shade = Math.max(-4, Math.min(4, (a + b - c - d) * 12));
              ctx.beginPath(); points.forEach((point, index) => { if (index === 0) ctx.moveTo(point.x, point.y); else ctx.lineTo(point.x, point.y); }); ctx.closePath();
              ctx.fillStyle = surfaceColors[Math.max(0, Math.min(127, Math.round((4 + energy * 46 + shade) / 54 * 127)))];
              // Same-color edge prevents hairline gaps between neighbouring cells.
              ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 0.65; ctx.fill(); ctx.stroke();
            }
          }
          ctx.lineWidth = 1;
          [20, 100, 1000, 10000, 20000].forEach((hz) => {
            const point = project(Math.log(hz / 20) / logSpan, 0, 0);
            text(hz >= 1000 ? hz / 1000 + "k" : String(hz), Math.min(width - 24, point.x - 6), height - 10);
          });
          text("旧", width - 22, height * 0.4); text("新", width - 22, height - 30);
          text("高度 / 能量", 6, 12);
        }
        if (mode === "spectrum") [20, 100, 1000, 10000, 20000].forEach((hz) => {
          const x = x0 + Math.log(hz / 20) / logSpan * (x1 - x0);
          line(x, y0, x, y1); text(hz >= 1000 ? `${hz / 1000}k` : String(hz), Math.min(x - 6, width - 25), height - 4);
        });
      } else {
        const cx = width / 2, base = height - 22;
        const radius = Math.max(1, Math.min(width / 2 - 24, height - 45));
        const stats = measureStereo(left, right);
        const cy = fieldMode === "lissajous" ? (height - 18) / 2 : base;
        const size = fieldMode === "lissajous" ? Math.min(width / 2 - 24, height / 2 - 20) : radius;
        ctx.strokeStyle = "#ffffff24";
        if (fieldMode === "lissajous") {
          line(cx - size, cy, cx + size, cy); line(cx, cy - size, cx, cy + size);
          ctx.strokeRect(cx - size, cy - size, size * 2, size * 2);
        } else {
          [0.5, 1].forEach((scale) => { ctx.beginPath(); ctx.arc(cx, base, radius * scale, Math.PI, Math.PI * 2); ctx.stroke(); });
          line(cx - radius, base, cx + radius, base); line(cx, base, cx, base - radius);
          text("L", cx - radius - 12, base); text("M", cx - 3, base - radius - 5); text("R", cx + radius + 5, base);
        }
        ctx.save();
        ctx.beginPath(); ctx.rect(cx - size, cy - size, size * 2, fieldMode === "lissajous" ? size * 2 : size); ctx.clip();
        if (fieldMode === "polar-level") {
          const levels = polarLevels(left, right, 90);
          levels.forEach((level, i) => {
            const angle = (i + 0.5) / levels.length * Math.PI;
            const length = Math.min(1, level * fieldGain / Math.SQRT2) * radius;
            line(cx, base, cx + Math.cos(angle) * length, base - Math.sin(angle) * length, "#5eead4bb");
          });
        } else {
          ctx.fillStyle = "#5eead485";
          for (let i = 0; i < left.length; i += 4) {
            const point = fieldMode === "lissajous" ? { x: (right[i] - left[i]) / 2, y: (right[i] + left[i]) / 2 } : polarSample(left[i], right[i]);
            const gain = fieldGain * (fieldMode === "lissajous" ? 1 : 1 / Math.SQRT2);
            ctx.fillRect(cx + point.x * size * gain, cy - point.y * size * gain, 1.3, 1.3);
          }
        }
        ctx.restore();
        text(`相关度  ${stats.correlation === null ? "—" : stats.correlation.toFixed(2)}`, 8, height - 5);
        if (fieldMode === "lissajous") text("同相 ↕ / 反相 ↔", Math.max(130, width - 115), height - 5);
      }
      if (!playing) text("已暂停", width - 45, 12);
    };
    resize();
    const observer = new ResizeObserver(() => { resize(); if (!active || !playing) paint(performance.now()); }); observer.observe(canvas);
    paint(performance.now());
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [mode, fieldMode, fieldGain, spectrogramView, analysersRef, playing, active, note]);
  return <canvas ref={canvasRef} className={fill ? "block h-full min-h-0 w-full rounded-xl" : "block h-36 w-full rounded-xl 2xl:h-48"} role="img" aria-label={`${analysisOptions.find((item) => item.id === mode)?.label}${mode === "field" ? ` ${fieldMode}` : ""}实时分析`} />;
}


export function ImmersiveAnalysisGrid({ analysersRef, playing, active, nativeCopy, note, trackId }: {
  analysersRef: StereoAnalysers; playing: boolean; active: boolean; nativeCopy: boolean; note?: string | null; trackId: string;
}) {
  const [spectrogramView, setSpectrogramView] = useSpectrogramView();
  const [gain, setGain] = useState(() => {
    try { const value = Number(localStorage.getItem("aria-field-gain")); return value >= 1 && value <= 3 && Number.isInteger(value * 2) ? value : 2.5; } catch { return 2.5; }
  });
  const panels = [{ mode: "levels", title: "电平", detail: "采样峰值 / RMS · dBFS" }, { mode: "spectrum", title: "频谱", detail: "20–20000 Hz" }, { mode: "field", title: "声场", detail: "Polar Sample" }, { mode: "spectrogram", title: "声谱图", detail: "3D · 20–20000 Hz" }] as const;
  return <div className="immersive-analysis-grid" aria-label="四宫格音频分析">
    <p className="col-span-2 text-[11px] text-white/45">{nativeCopy ? "mpv 分析副本 · 非设备输出测量" : "均衡器后 · 标准化与音量前"}</p>
    {panels.map((panel) => <section key={panel.mode} className="flex min-h-0 min-w-0 flex-col rounded-2xl border border-white/10 bg-[#151b24]/80 p-2.5">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-1 text-xs">
        <h2 className="font-medium text-white/85">{panel.title}</h2><span className="text-[10px] text-white/40">{panel.mode === "spectrogram" ? "20–20000 Hz" : panel.detail}</span>
        {panel.mode === "spectrogram" && <SpectrogramSwitch view={spectrogramView} onChange={setSpectrogramView} dark />}
        {panel.mode === "field" && <label className="flex items-center gap-1 text-[10px] text-white/60">增益<input aria-label="沉浸声场显示增益" type="range" min={1} max={3} step={0.5} value={gain} onChange={(event) => { const value = Number(event.target.value); setGain(value); try { localStorage.setItem("aria-field-gain", String(value)); } catch { /* Optional persistence. */ } }} className="h-1 w-16 accent-teal-300" /><output>×{gain}</output></label>}
      </div>
      <div className="min-h-0 flex-1"><AnalysisCanvas spectrogramView={spectrogramView} key={trackId + panel.mode + (panel.mode === "spectrogram" ? spectrogramView : "")} mode={panel.mode} fieldMode="polar-sample" fieldGain={gain} analysersRef={analysersRef} playing={playing} active={active} note={note} fill /></div>
    </section>)}
  </div>;
}
