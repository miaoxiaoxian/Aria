import { useEffect, useState } from "react";
import { ChevronDown, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DiagnosticsSnapshot } from "@/lib/diagnosticsTypes";

const card = "rounded-[1.25rem] border border-white/70 bg-white/62 p-4 shadow-sm lg:col-span-2";
function Toggle({ enabled, label, onChange }: { enabled: boolean; label: string; onChange: (next: boolean) => void }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={enabled} onClick={() => onChange(!enabled)} className={`relative h-7 w-12 shrink-0 rounded-full ${enabled ? "bg-neutral-950" : "bg-neutral-200"}`}><span className={`absolute left-1 top-1 size-5 rounded-full bg-white transition ${enabled ? "translate-x-5" : ""}`} /></button>;
}

export function DiagnosticsSettings() {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<DiagnosticsSnapshot | null>(null);
  const [fps, setFps] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [perf, setPerf] = useState(() => { try { return localStorage.getItem("aria-perf-mode") === "true"; } catch { return document.documentElement.classList.contains("perf-lite"); } });
  const bridge = window.ariaDesktop?.diagnostics;

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try { const value = await bridge?.getStats(); if (alive && value) setStats(value); }
      catch { if (alive) setMessage("无法读取诊断信息"); }
      if (alive && open) timer = setTimeout(() => void refresh(), 2500);
    }
    void refresh();
    return () => { alive = false; clearTimeout(timer); };
  }, [bridge, open]);

  useEffect(() => {
    if (!open) return;
    let frame = 0, frames = 0, start = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - start >= 1000) { setFps(Math.round(frames * 1000 / (now - start))); frames = 0; start = now; }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [open]);

  function changePerf(next: boolean) {
    setPerf(next);
    document.documentElement.classList.toggle("perf-lite", next);
    try { localStorage.setItem("aria-perf-mode", String(next)); } catch { /* Optional persistence. */ }
  }

  async function exportLogs() {
    if (!bridge) return;
    setExporting(true);
    try {
      const result = await bridge.exportLogs({ fps, performanceMode: perf });
      setMessage(result.ok ? `已导出至 ${result.path}` : result.error ?? "导出失败");
    } catch { setMessage("导出失败，请重试"); }
    finally { setExporting(false); }
  }

  return <>
    <section className={card}>
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-neutral-400">Performance</p><h3 className="mt-1 text-base font-semibold">性能与渲染优化</h3>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex items-center justify-between gap-3 rounded-xl bg-neutral-950/5 p-3"><div><p className="text-sm font-semibold">性能模式</p><p className="mt-1 text-xs leading-5 text-neutral-500">减少毛玻璃和模糊效果，立即生效。</p></div><Toggle enabled={perf} label="性能模式" onChange={changePerf} /></div>
        {bridge && <div className="flex items-center justify-between gap-3 rounded-xl bg-neutral-950/5 p-3"><div><p className="text-sm font-semibold">AMD GPU 优化</p><p className="mt-1 text-xs leading-5 text-neutral-500">恢复旧版 GPU 渲染选项，修改后重启生效。</p></div><Toggle enabled={stats?.gpuOptimizeEnabled ?? true} label="AMD GPU 优化" onChange={next => { void bridge.setGpuOptimize(next).then(value => setStats(current => current ? { ...current, gpuOptimizeEnabled: value } : current)).catch(() => setMessage("无法保存 GPU 设置")); }} /></div>}
      </div>
    </section>
    <details className={card} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.22em] text-neutral-400">Diagnostics</p><h3 className="mt-1 text-base font-semibold">诊断与日志</h3></div><span className="flex items-center gap-2 text-xs text-neutral-500">{open ? "展开中" : "点击展开"}<ChevronDown className="size-4" /></span></summary>
      <p className="mt-2 text-xs leading-5 text-neutral-500">展开后实时查看进程 CPU、内存和界面帧率，也可一键导出日志。</p>
      {open && <div className="mt-4 space-y-3">
        {stats ? <><div className="grid gap-2 sm:grid-cols-2">{stats.processes.map(item => <div key={item.pid} className="flex justify-between gap-2 rounded-xl bg-neutral-950/5 p-3 text-xs"><span>{({ Browser: "主程序", Tab: "界面", GPU: "GPU", Utility: "辅助进程" } as Record<string, string>)[item.type] ?? item.type} · {item.pid}</span><span>CPU {item.cpuPercent.toFixed(1)}% · {item.memoryMb} MB</span></div>)}</div><p className="text-xs text-neutral-500">{fps} FPS · {stats.cpuModel}（{stats.cpuCores} 核）· 已运行 {Math.round(stats.uptimeSeconds / 60)} 分钟 · v{stats.appVersion}</p><p className="text-xs text-neutral-500">GPU 合成 {stats.gpuFeatures.gpu_compositing ?? "未知"} · WebGL {stats.gpuFeatures.webgl ?? "未知"}{stats.backendPid ? ` · 后端 PID ${stats.backendPid}` : ""}</p></> : <p className="text-xs text-neutral-500">{bridge ? "正在读取诊断数据…" : "进程诊断和日志导出需要桌面版。"}</p>}
        <div className="flex gap-2"><Button size="sm" variant="glass" disabled={!bridge || exporting} onClick={() => void exportLogs()}><Download />{exporting ? "导出中…" : "导出日志"}</Button><Button size="sm" variant="glass" disabled={!bridge} onClick={() => { void bridge?.getStats().then(setStats).catch(() => setMessage("读取失败")); }}><RefreshCw />刷新</Button></div>
        {message && <p role="status" className="break-all text-xs text-neutral-500">{message}</p>}
      </div>}
    </details>
  </>;
}
