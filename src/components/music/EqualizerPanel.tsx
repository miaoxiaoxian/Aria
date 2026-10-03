import { useMemo, useState } from "react";
import { AudioLines, RotateCcw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
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
  presetGainsForMode,
  withEqualizerBand,
  withEqualizerGains,
  withEqualizerMode,
  type EqualizerMode,
  type EqualizerSettings,
} from "@/lib/equalizer";

function formatGain(gain: number) {
  const rounded = Math.round(gain * 2) / 2;
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
  onClose,
  nativePlaybackEnabled,
  audioOutputMode,
}: {
  settings: EqualizerSettings;
  onChange: (next: EqualizerSettings) => void;
  onClose: () => void;
  nativePlaybackEnabled: boolean;
  audioOutputMode: "system" | "shared" | "exclusive";
}) {
  const [draggingBand, setDraggingBand] = useState<number | null>(null);
  const bands = useMemo(() => equalizerBandsForMode(settings.mode), [settings.mode]);
  const gains = settings.gains[settings.mode];
  const activePreset = detectEqualizerPreset(settings);
  const dense = settings.mode === "31";
  const processingPath = nativePlaybackEnabled
    ? `mpv 滤镜 · WASAPI ${audioOutputMode === "exclusive" ? "独占" : "共享"}`
    : "浏览器实时滤波 · 系统音频";

  const applyPreset = (presetId: string) => {
    const preset = equalizerPresets.find((item) => item.id === presetId);
    if (!preset) return;
    onChange({ ...settings, enabled: true, ...withEqualizerGains(settings, presetGainsForMode(preset, settings.mode)) });
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
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="subtle" size="icon" aria-label="关闭均衡器面板" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
        {/* Enable switch + band-layout switch */}
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

        {/* Presets for the active layout */}
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
          {!activePreset && (
            <span className="rounded-full bg-neutral-950/[0.055] px-3 py-1.5 text-xs font-semibold text-neutral-500">
              自定义
            </span>
          )}
        </div>

        {/* Faders */}
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
                <span
                  className={cn(
                    "font-semibold tabular-nums",
                    dense ? "text-[0.55rem]" : "text-[0.7rem]",
                    gainTone(gain),
                  )}
                >
                  {formatGain(gain)}
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
                <span className={cn("font-medium text-neutral-500", dense ? "text-[0.5rem]" : "text-[0.7rem]")}>
                  {showLabel ? band.label : ""}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs leading-5 text-neutral-500">
            {activePreset
              ? `当前预设：${activePreset.label} —— ${activePreset.description}`
              : "已手动调整频段，音效实时生效"}
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

        <p className="mt-3 text-[0.7rem] leading-relaxed text-neutral-400">
          18 段与 31 段各自保存一套曲线，切换频段不会丢失调整。系统音频模式由浏览器实时滤波，WASAPI 共享/独占模式通过 mpv 的 equalizer
          滤镜处理同一套曲线，切换输出模式时会自动重新应用。
        </p>
      </div>
    </div>
  );
}
