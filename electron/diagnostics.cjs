const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function normalizeMetrics(metrics) {
  return metrics.map(metric => ({
    type: metric.type, pid: metric.pid,
    cpuPercent: Math.round((metric.cpu?.percentCPUUsage ?? 0) * 10) / 10,
    // Electron reports workingSetSize in KB.
    memoryMb: Math.round((metric.memory?.workingSetSize ?? 0) / 1024),
  }));
}

function setupDiagnostics({ app, ipcMain, shell, logger, getBackendPid }) {
  const preferencePath = path.join(app.getPath("userData"), "gpu-mode.json");
  let optimize = true;
  let gpuVendorId = null;
  try { const value = JSON.parse(fs.readFileSync(preferencePath, "utf8")); if (typeof value.optimize === "boolean") optimize = value.optimize; } catch { /* Default on. */ }

  function snapshot(runtime = null) {
    return {
      generatedAt: new Date().toISOString(), appVersion: app.getVersion(),
      electronVersion: process.versions.electron, platform: process.platform,
      cpuModel: os.cpus()[0]?.model ?? null, cpuCores: os.cpus().length,
      uptimeSeconds: Math.round(process.uptime()),
      processes: normalizeMetrics(app.getAppMetrics()), backendPid: getBackendPid(),
      gpuVendorId, gpuOptimizeEnabled: optimize, gpuFeatures: app.getGPUFeatureStatus(), runtime,
    };
  }
  ipcMain.handle("aria:diagnostics:stats", () => snapshot());
  ipcMain.handle("aria:set-gpu-optimize", (_event, enabled) => {
    optimize = Boolean(enabled);
    fs.mkdirSync(path.dirname(preferencePath), { recursive: true });
    fs.writeFileSync(preferencePath, JSON.stringify({ optimize }));
    return optimize;
  });
  ipcMain.handle("aria:diagnostics:export-logs", async (_event, runtime) => {
    try {
      const folder = path.join(app.getPath("userData"), "exports", `aria-diagnostics-${Date.now()}`);
      fs.mkdirSync(folder, { recursive: true });
      const logs = logger.logDir();
      let copiedLogs = 0;
      for (const name of fs.existsSync(logs) ? fs.readdirSync(logs) : []) {
        const source = path.join(logs, name);
        const info = fs.lstatSync(source);
        if (info.isFile() && !info.isSymbolicLink() && info.size <= 5 * 1024 * 1024) {
          fs.copyFileSync(source, path.join(folder, name)); copiedLogs++;
        }
      }
      fs.writeFileSync(path.join(folder, "diagnostics.json"), JSON.stringify(snapshot(runtime), null, 2));
      await shell.openPath(folder);
      return { ok: true, path: folder, copiedLogs };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  return {
    async configureGpu() {
      try {
        if (process.platform === "win32") {
          // Detect through Windows before Chromium starts its GPU process.
          const output = await new Promise(resolve => require("node:child_process").execFile("powershell.exe", ["-NoProfile", "-Command", "(Get-CimInstance Win32_VideoController | Select-Object -First 1 -ExpandProperty PNPDeviceID)"], { windowsHide: true, timeout: 5000 }, (_error, stdout) => resolve(String(stdout ?? ""))));
          const match = output.match(/VEN_([0-9A-Fa-f]{4})/);
          gpuVendorId = match ? parseInt(match[1], 16) : null;
        } else {
          const info = await app.getGPUInfo("basic");
          gpuVendorId = info.gpuDevice?.[0]?.vendorId ?? null;
        }
        if (gpuVendorId === 0x1002 && optimize) {
          app.commandLine.appendSwitch("ignore-gpu-blocklist");
          app.commandLine.appendSwitch("enable-gpu-rasterization");
          app.commandLine.appendSwitch("enable-zero-copy");
        }
      } catch { /* GPU information is optional. */ }
    },
  };
}
module.exports = { setupDiagnostics, normalizeMetrics };
