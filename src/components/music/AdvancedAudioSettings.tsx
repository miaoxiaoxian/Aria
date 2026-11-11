import { useEffect, useState } from "react";
import { ChevronDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { asioBufferSizes, asioDsdModeLabels, dsdPcmRateLabels, readCachedAudioSettings, writeCachedAudioSettings, type AsioDriverChannels, type AsioDsdMode, type DsdPcmRate } from "@/lib/playerPresentation";
import type { NativeAudioState } from "@/lib/audioTypes";

const card = "rounded-[1.25rem] border border-white/70 bg-white/62 p-4 shadow-sm";
const select = "mt-2 w-full rounded-xl border border-neutral-950/5 bg-white/80 px-3 py-2 text-sm shadow-sm";

export function AdvancedAudioSettings({ rate, onRateChange, exclusive, onExclusiveChange, supported, state }: {
  rate: DsdPcmRate;
  onRateChange: (rate: DsdPcmRate) => void;
  exclusive: boolean;
  onExclusiveChange: (enabled: boolean) => void;
  supported: boolean;
  state: NativeAudioState | null;
}) {
  const [drivers, setDrivers] = useState<Array<{ name: string; clsid: string | null; bits: number }>>([]);
  const [config, setConfig] = useState(() => {
    const saved = readCachedAudioSettings();
    return { driver: saved.asioDriver ?? "", mode: saved.asioDsdMode ?? "native", buffer: saved.asioBuffer ?? 512, channels: saved.asioChannels ?? { left: 0, right: 1 } };
  });
  const [channels, setChannels] = useState<AsioDriverChannels | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Registry enumeration only: never instantiate the driver on page load.
    window.ariaDesktop?.asio?.listDrivers?.().then(items => { if (alive) setDrivers(items); }).catch(() => { if (alive) setMessage("无法读取 ASIO 驱动列表"); });
    return () => { alive = false; };
  }, []);

  function update(next: Partial<typeof config>) {
    const value = { ...config, ...next };
    setConfig(value);
    const saved = readCachedAudioSettings();
    writeCachedAudioSettings({ sinkId: saved.sinkId ?? "default", hifiEnabled: saved.hifiEnabled ?? true, masterQualityEnabled: saved.masterQualityEnabled ?? false, gaplessEnabled: saved.gaplessEnabled ?? false, exclusiveMode: saved.exclusiveMode ?? false, outputMode: saved.outputMode ?? "system", ...saved, asioDriver: value.driver, asioDsdMode: value.mode, asioBuffer: value.buffer, asioChannels: value.channels });
  }

  async function run(action: "channels" | "panel") {
    const asio = window.ariaDesktop?.asio;
    if (!config.driver || !asio) return;
    setBusy(true);
    setMessage(null);
    try {
      if (action === "channels") {
        const result = await asio.listChannels?.({ clsid: config.driver });
        if (!result?.ok) throw new Error(result?.error ?? "读取通道失败");
        setChannels(result);
        setMessage(`已读取 ${result.outputChannels ?? result.channels?.length ?? 0} 个输出通道`);
      } else {
        const result = await asio.openPanel?.({ clsid: config.driver });
        if (!result?.ok) throw new Error(result?.error ?? "无法打开驱动面板");
        setMessage("已打开驱动设置面板");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "驱动操作失败"); }
    finally { setBusy(false); }
  }

  const selected = drivers.find(item => item.clsid === config.driver);
  const outputs = channels?.channels ?? Array.from({ length: Math.max(2, config.channels.left + 1, config.channels.right + 1) }, (_, index) => ({ index, name: `通道 ${index + 1}` }));

  return <>
    <details className={card}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <div><p className="text-xs font-semibold tracking-[0.22em] text-neutral-400">ASIO</p><h3 className="mt-1 text-base font-semibold">声道映射与驱动</h3></div>
        <span className="flex items-center gap-2 text-xs text-neutral-500">{selected ? `${selected.bits} 位` : "点击展开"}<ChevronDown className="size-4" /></span>
      </summary>
      <div className="mt-4 space-y-4">
        <label className="block text-xs text-neutral-500">驱动<select className={select} value={config.driver} onChange={event => { setChannels(null); setMessage(null); update({ driver: event.target.value }); }}>
          <option value="">选择 ASIO 驱动</option>
          {config.driver && !selected && <option value={config.driver}>已保存的驱动（当前未找到）</option>}
          {drivers.filter(item => item.clsid).map(item => <option key={`${item.clsid}-${item.bits}`} value={item.clsid!}>{item.name} ({item.bits} 位)</option>)}
        </select></label>
        <div className="grid grid-cols-2 gap-3">{(["left", "right"] as const).map(side => <label key={side} className="text-xs text-neutral-500">{side === "left" ? "左声道" : "右声道"}<select className={select} value={config.channels[side]} onChange={event => update({ channels: { ...config.channels, [side]: Number(event.target.value) } })}>{outputs.map(channel => <option key={channel.index} value={channel.index}>{channel.name || `通道 ${channel.index + 1}`}</option>)}</select></label>)}</div>
        <p className="rounded-xl bg-amber-50/80 p-3 text-xs leading-6 text-amber-800">注意：下面两个按钮会真正调用驱动。旧版或与系统不匹配的驱动可能因此让系统崩溃，请只在清楚风险时使用。</p>
        <div className="flex flex-wrap gap-2"><Button variant="glass" size="sm" disabled={busy || !selected || selected.bits !== 64} onClick={() => void run("channels")}><RefreshCw className={busy ? "animate-spin" : ""} />读取驱动通道信息</Button><Button variant="glass" size="sm" disabled={busy || !selected || selected.bits !== 64} onClick={() => void run("panel")}>打开驱动设置面板</Button></div>
        {message && <p role="status" className="text-xs text-neutral-500">{message}</p>}
        <label className="block text-xs text-neutral-500">DSD 输出配置<select className={select} value={config.mode} onChange={event => update({ mode: event.target.value as AsioDsdMode })}>{Object.entries(asioDsdModeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="block text-xs text-neutral-500">缓冲<select className={select} value={config.buffer} onChange={event => update({ buffer: Number(event.target.value) })}>{asioBufferSizes.map(value => <option key={value} value={value}>{value} 采样</option>)}</select></label>
        <p className="text-xs leading-6 text-neutral-500">保留旧版 ASIO 配置和驱动工具；这些配置不会将当前 WASAPI 播放切换为 ASIO。32 位驱动不能由内置的 64 位工具打开。</p>
      </div>
    </details>
    <details className={card}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3"><div><p className="text-xs font-semibold tracking-[0.22em] text-neutral-400">DSD</p><h3 className="mt-1 text-base font-semibold">DSD 播放</h3></div><span className="flex items-center gap-2 text-xs text-neutral-500">解码 PCM<ChevronDown className="size-4" /></span></summary>
      <div className="mt-4 space-y-4">
        <div className="rounded-xl bg-neutral-950 p-4 text-white"><p className="text-sm font-semibold">解码为 PCM（D2P）</p><p className="mt-2 text-xs leading-6 text-white/65">本地 DSD 由 mpv 解码，再送入所选设备，均衡器和音量可用。QQ、B站等在线音源使用原有播放设置。</p></div>
        <div className="rounded-xl bg-neutral-950/5 p-4"><p className="text-sm font-semibold">原生 DoP · 暂不可用</p><p className="mt-2 text-xs text-neutral-500">DoP 继续停用，当前使用 D2P。</p></div>
        <label className="block text-xs text-neutral-500">解码输出采样率<select className={select} value={rate} disabled={!supported} onChange={event => onRateChange(event.target.value as DsdPcmRate)}>{Object.entries(dsdPcmRateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-neutral-950/5 p-3"><div><p className="text-sm font-semibold">DSD 曲目强制独占输出</p><p className="mt-1 text-xs leading-5 text-neutral-500">避免共享混音器重采样；设备被占用时可能无法播放。</p></div><button type="button" role="switch" aria-label="DSD 曲目强制独占输出" aria-checked={exclusive} disabled={!supported} onClick={() => onExclusiveChange(!exclusive)} className={`relative h-7 w-12 shrink-0 rounded-full ${exclusive ? "bg-neutral-950" : "bg-neutral-200"}`}><span className={`absolute left-1 top-1 size-5 rounded-full bg-white transition ${exclusive ? "translate-x-5" : ""}`} /></button></div>
        <p className="text-xs leading-6 text-neutral-500">{!supported ? "未检测到 mpv，DSD 播放不可用。" : "自动跟随源时，DSD 解码可能需要 352.8 kHz 或更高采样率；设备不支持时可选择 176.4 kHz。"}</p>
        {state?.active && <p className="text-xs text-neutral-500">当前原生输出：{state.exclusive ? "独占" : "共享"}{state.samplerate ? ` · ${state.samplerate / 1000} kHz（请求值）` : " · 跟随源"}</p>}
      </div>
    </details>
  </>;
}
