import { useMemo, useRef, useState } from "react";
import { AudioLines, BookmarkPlus, Download, RotateCcw, Trash2, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  buildEqualizerExportFileName,
  buildEqualizerExportPayload,
  buildGraphicEqText,
  detectEqualizerPreset,
  equalizerBandsForMode,
  equalizerGainRange,
  equalizerModeDescriptions,
  equalizerModeLabels,
  equalizerModes,
  equalizerPresets,
  equalizerSummary,
  flatEqualizerGains,
  isFlatEqualizer,
  parseEqualizerImport,
  presetGainsForMode,
  presetsFromImport,
  upsertEqualizerPreset,
  withEqualizerBand,
  withEqualizerGains,
  withEqualizerMode,
  type EqualizerCustomPreset,
  type EqualizerMode,
  type EqualizerSettings,
} from "@/lib/equalizer";

function formatGain(gain: number) {
  const rounded = Math.round(gain * 2) / 2;
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

/** 31-band columns are ~30px wide, so the readout drops the decimal there. */
function formatGainCompact(gain: number) {
  const rounded = Math.round(gain);
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function gainTone(gain: number) {
  if (gain >= 0.25) return "text-emerald-600";
  if (gain <= -0.25) return "text-rose-500";
  return "text-neutral-400";
}

export function EqualizerPanel({
  settings,
  onChange,
  presets,
  onPresetsChange,
  onClose,
  nativePlaybackEnabled,
  audioOutputMode,
}: {
  settings: EqualizerSettings;
  onChange: (next: EqualizerSettings) => void;
  presets: EqualizerCustomPreset[];
  onPresetsChange: (next: EqualizerCustomPreset[]) => void;
  onClose: () => void;
  nativePlaybackEnabled: boolean;
  audioOutputMode: "system" | "shared" | "exclusive";
}) {
  const [draggingBand, setDraggingBand] = useState<number | null>(null);
  const [presetName, setPresetName] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const bands = useMemo(() => equalizerBandsForMode(settings.mode), [settings.mode]);
  const gains = settings.gains[settings.mode];
  const activePreset = detectEqualizerPreset(settings);
  const dense = settings.mode === "31";
  const processingPath = nativePlaybackEnabled
    ? `mpv 滤镜 · WASAPI ${audioOutputMode === "exclusive" ? "独占" : "共享"}`
    : "浏览器实时滤波 · 系统音频";
  const customPresets = presets.filter((preset) => preset.mode === settings.mode);
  const otherPresetCount = presets.length - customPresets.length;

  const applyPreset = (presetId: string) => {
    const preset = equalizerPresets.find((item) => item.id === presetId);
    if (!preset) return;
    onChange({ ...settings, enabled: true, ...withEqualizerGains(settings, presetGainsForMode(preset, settings.mode)) });
  };

  const applyCustomPreset = (preset: EqualizerCustomPreset) => {
    onChange({ enabled: true, mode: preset.mode, gains: { ...settings.gains, [preset.mode]: preset.gains.slice() } });
    setStatus(`已应用自定义预设「${preset.name}」`);
  };

  const saveCustomPreset = () => {
    const name = presetName.trim();
    if (!name) {
      setStatus("请先输入预设名称");
      nameInputRef.current?.focus();
      return;
    }
    onPresetsChange(upsertEqualizerPreset(presets, name, settings));
    setPresetName("");
    setStatus(`已把当前 ${equalizerModeLabels[settings.mode]} 曲线保存为「${name}」`);
  };

  const exportSettings = async (kind: "json" | "graphiceq") => {
    const bridge = window.ariaDesktop;
    if (kind === "json" && !bridge?.exportEqualizerFile) {
      setStatus("导出需要桌面版环境");
      return;
    }
    setBusy(true);
    try {
      if (kind === "graphiceq") {
        const text = buildGraphicEqText(settings);
        await navigator.clipboard?.writeText(text).catch(() => undefined);
        const payload = {
          content: `${text}\n`,
          defaultName: buildEqualizerExportFileName("aria-graphiceq").replace(/\.json$/, ".txt"),
        };
        const result = await bridge?.exportEqualizerFile?.(payload);
        setStatus(
          result?.ok
            ? `已导出 GraphicEQ 文本 → ${result.path}（同时已复制到剪贴板）`
            : result?.canceled
              ? "已取消导出"
              : `导出失败：${result?.error ?? "未知错误"}`,
        );
        return;
      }
      const payload = {
        content: `${JSON.stringify(buildEqualizerExportPayload(settings, presets), null, 2)}\n`,
        defaultName: buildEqualizerExportFileName(),
      };
      const result = await bridge?.exportEqualizerFile?.(payload);
      setStatus(
        result?.ok
          ? `已导出 ${presets.length} 组自定义预设 + 两套曲线 → ${result.path}`
          : result?.canceled
            ? "已取消导出"
            : `导出失败：${result?.error ?? "未知错误"}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const importFile = async () => {
    const bridge = window.ariaDesktop;
    if (!bridge?.importEqualizerFile) {
      setStatus("导入需要桌面版环境");
      return;
    }
    setBusy(true);
    try {
      const result = await bridge.importEqualizerFile();
      if (!result?.ok) {
        setStatus(result?.canceled ? "已取消导入" : `导入失败：${result?.error ?? "未知错误"}`);
        return;
      }
      const parsed = parseEqualizerImport(result.content ?? "", settings.mode);
      const incoming = presetsFromImport(parsed, result.name ?? "");
      const warning = parsed.warnings.length ? `（${parsed.warnings.join("；")}）` : "";

      if (!incoming.length) {
        setStatus(`没有可导入的预设：${parsed.sourceLabel || "文件里没有曲线或频点数据"}${warning}`);
        return;
      }

      // Importing only extends the preset library; the working curve (and the
      // all-zero 平直 baseline) stays exactly as it is until a preset is applied.
      const merged = [
        ...incoming,
        ...presets.filter(
          (preset) => !incoming.some((item) => item.mode === preset.mode && item.name === preset.name),
        ),
      ];
      onPresetsChange(merged);
      setStatus(
        `已导入 ${incoming.length} 组预设：${incoming.map((preset) => preset.name).join("、")}。当前曲线未改动，点预设名即可套用。${warning}`,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden rounded-[1.5rem] border border-white/70 bg-white/92 shadow-[0_24px_80px_rgba(47,55,76,0.22)] backdrop-blur-2xl">
      <div className="flex items-start justify-between gap-3 border-b border-neutral-950/6 px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-neutral-400">Equalizer</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <AudioLines className="size-5 shrink-0 text-neutral-500" />
            <h2 className="text-lg font-semibold">DSP 均衡器</h2>
            <Badge>{equalizerSummary(settings)}</Badge>
          </div>
          <p className="mt-1 text-xs leading-5 text-neutral-500">{processingPath}</p>
        </div>
        <Button variant="subtle" size="icon" aria-label="关闭均衡器面板" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-[1.1rem] bg-neutral-950/[0.035] px-3 py-2.5">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={cn(
                "flex h-7 w-12 shrink-0 items-center rounded-full p-0.5 transition",
                settings.enabled ? "bg-neutral-950" : "bg-neutral-200",
              )}
              onClick={() => onChange({ ...settings, enabled: !settings.enabled })}
              aria-label={settings.enabled ? "关闭均衡器" : "开启均衡器"}
              aria-pressed={settings.enabled}
            >
              <span
                className={cn("size-5 rounded-full bg-white shadow-sm transition", settings.enabled && "translate-x-5")}
              />
            </button>
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-700">启用均衡器</p>
              <p className="text-[0.7rem] leading-relaxed text-neutral-400">
                {settings.enabled ? "调整立即生效" : "关闭后按原始信号播放"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-neutral-500">频段</span>
            <div className="grid grid-cols-2 rounded-xl bg-white/80 p-1 shadow-sm">
              {equalizerModes.map((mode) => {
                const active = settings.mode === mode;
                return (
                  <button
                    key={mode}
                    type="button"
                    title={equalizerModeDescriptions[mode]}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-semibold transition",
                      active ? "bg-neutral-950 text-white shadow-sm" : "text-neutral-500 hover:text-neutral-950",
                    )}
                    onClick={() => onChange(withEqualizerMode(settings, mode as EqualizerMode))}
                  >
                    {equalizerModeLabels[mode]}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {equalizerPresets.map((preset) => {
            const active = activePreset?.id === preset.id;
            return (
              <button
                key={preset.id}
                type="button"
                title={preset.description}
                className={cn(
                  "rounded-full px-3 py-1.5 text-xs font-semibold transition",
                  active
                    ? "bg-neutral-950 text-white shadow-sm"
                    : "bg-neutral-950/[0.055] text-neutral-600 hover:bg-neutral-950/[0.09] hover:text-neutral-950",
                )}
                onClick={() => applyPreset(preset.id)}
              >
                {preset.label}
              </button>
            );
          })}
          {!activePreset && !customPresets.some((preset) => (
            preset.gains.length === gains.length && preset.gains.every((gain, index) => gain === gains[index])
          )) && (
            <span className="rounded-full bg-neutral-950/[0.055] px-3 py-1.5 text-xs font-semibold text-neutral-500">
              自定义
            </span>
          )}
          {customPresets.map((preset) => {
            const active = preset.gains.length === gains.length && preset.gains.every((gain, index) => gain === gains[index]);
            return (
              <span
                key={preset.id}
                className={cn(
                  "flex items-center gap-1 rounded-full px-3 py-1.5 text-xs font-semibold transition",
                  active ? "bg-emerald-600 text-white shadow-sm" : "bg-emerald-500/12 text-emerald-700",
                )}
              >
                <button type="button" title={`应用「${preset.name}」`} onClick={() => applyCustomPreset(preset)}>
                  {preset.name}
                </button>
                <button
                  type="button"
                  title="删除该预设"
                  aria-label={`删除预设 ${preset.name}`}
                  className="rounded-full p-0.5 transition hover:bg-black/10"
                  onClick={() => {
                    onPresetsChange(presets.filter((item) => item.id !== preset.id));
                    setStatus(`已删除预设「${preset.name}」`);
                  }}
                >
                  <X className="size-3" />
                </button>
              </span>
            );
          })}
        </div>

        <div
          className={cn(
            "mt-5 flex items-end justify-between",
            dense ? "gap-[2px]" : "gap-1 sm:gap-2",
            !settings.enabled && "opacity-45",
          )}
        >
          {bands.map((band, index) => {
            const gain = gains[index] ?? 0;
            const dragging = draggingBand === index;
            const showLabel = !dense || index % 3 === 0 || index === bands.length - 1;
            return (
              <div key={band.frequency} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                {/* Fixed-height readout and frequency rows keep every fader on
                    one line, with or without a printed frequency label. */}
                <span
                  title={`${band.label} Hz：${formatGain(gain)} dB`}
                  className={cn(
                    "flex h-4 items-center justify-center overflow-hidden whitespace-nowrap font-semibold leading-none tabular-nums",
                    dense ? "text-[0.55rem]" : "text-[0.7rem]",
                    gainTone(gain),
                  )}
                >
                  {dense ? formatGainCompact(gain) : formatGain(gain)}
                </span>
                <div className={cn("relative flex items-center justify-center", dense ? "h-[7.5rem]" : "h-[8.75rem]")}>
                  <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-neutral-950/10" />
                  <input
                    type="range"
                    className={cn("eq-slider relative", dense && "eq-slider-dense")}
                    min={-equalizerGainRange}
                    max={equalizerGainRange}
                    step={0.5}
                    value={gain}
                    disabled={!settings.enabled}
                    aria-label={`${band.label} Hz 增益`}
                    onPointerDown={() => setDraggingBand(index)}
                    onPointerUp={() => setDraggingBand(null)}
                    onBlur={() => setDraggingBand(null)}
                    onChange={(event) => onChange(withEqualizerBand(settings, index, Number(event.currentTarget.value)))}
                    style={{ color: dragging ? "#171717" : "#525252" }}
                  />
                </div>
                <span
                  className={cn(
                    "flex h-3 items-center justify-center overflow-hidden whitespace-nowrap font-medium leading-none text-neutral-500",
                    dense ? "text-[0.5rem]" : "text-[0.7rem]",
                  )}
                >
                  {showLabel ? band.label : ""}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs leading-5 text-neutral-500">
            {activePreset ? `当前预设：${activePreset.label} —— ${activePreset.description}` : "已手动调整频段，音效实时生效"}
            {settings.enabled && isFlatEqualizer(settings) ? "（所有频段 0dB，听感等同关闭）" : ""}
          </p>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => onChange({ ...settings, ...withEqualizerGains(settings, flatEqualizerGains(settings.mode)) })}
          >
            <RotateCcw />
            重置
          </Button>
        </div>

        {/* Custom preset library + file import/export */}
        <div className="mt-4 rounded-[1.1rem] border border-neutral-950/8 bg-white/70 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold text-neutral-600">自定义预设与文件</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="subtle" size="sm" onClick={() => void importFile()} disabled={busy}>
                <Upload />
                导入文件
              </Button>
              <Button variant="subtle" size="sm" onClick={() => void exportSettings("json")} disabled={busy}>
                <Download />
                导出 JSON
              </Button>
              <Button variant="subtle" size="sm" onClick={() => void exportSettings("graphiceq")} disabled={busy}>
                <Download />
                导出 GraphicEQ
              </Button>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              ref={nameInputRef}
              value={presetName}
              onChange={(event) => setPresetName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveCustomPreset();
              }}
              placeholder={`给当前 ${equalizerModeLabels[settings.mode]} 曲线起个名字`}
              maxLength={40}
              className="min-w-[12rem] flex-1 rounded-xl border border-neutral-950/10 bg-white/85 px-3 py-1.5 text-xs text-neutral-700 outline-none placeholder:text-neutral-400 focus:border-neutral-950/25"
            />
            <Button variant="subtle" size="sm" onClick={saveCustomPreset}>
              <BookmarkPlus />
              保存为预设
            </Button>
          </div>

          <p className="mt-2 text-[0.7rem] leading-relaxed text-neutral-400">
            {presets.length
              ? `共 ${presets.length} 组自定义预设（当前频段 ${customPresets.length} 组${otherPresetCount ? `，另一频段 ${otherPresetCount} 组` : ""}）`
              : "还没有自定义预设；保存后会以绿色标签出现在上方预设行。"}
            {" "}导入只往预设库里加标签，**不会改动当前曲线**（内置「平直」始终是全 0，点预设名才会套用）。支持本插件导出的 JSON，也兼容 GraphicEQ 文本、频点+增益的文本或纯数值列表；18/31 段各自保存一套曲线。
          </p>
          {status && (
            <p className="mt-2 break-all text-[0.7rem] leading-relaxed text-neutral-600" role="status">
              {status}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
