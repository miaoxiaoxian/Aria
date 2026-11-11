import { expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
const { normalizeMetrics, setupDiagnostics } = createRequire(import.meta.url)("../../electron/diagnostics.cjs");

it("converts Electron memory from KB to MB", () => {
  expect(normalizeMetrics([{ type: "Tab", pid: 42, cpu: { percentCPUUsage: 3.14 }, memory: { workingSetSize: 204800 } }])).toEqual([{ type: "Tab", pid: 42, cpuPercent: 3.1, memoryMb: 200 }]);
});

it("exports local logs and a process snapshot and retains the GPU preference", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "aria-diagnostics-test-"));
  try {
    const logs = path.join(folder, "logs"); mkdirSync(logs); writeFileSync(path.join(logs, "desktop.log"), "test log");
    const handlers = new Map<string, (...args: any[]) => any>();
    const app = { getPath: () => folder, getVersion: () => "test", getAppMetrics: () => [], getGPUFeatureStatus: () => ({ webgl: "enabled" }) };
    setupDiagnostics({ app, ipcMain: { handle: (name: string, handler: (...args: any[]) => any) => handlers.set(name, handler) }, shell: { openPath: async () => "" }, logger: { logDir: () => logs }, getBackendPid: () => 123 });
    handlers.get("aria:set-gpu-optimize")!(null, false);
    expect(JSON.parse(readFileSync(path.join(folder, "gpu-mode.json"), "utf8"))).toEqual({ optimize: false });
    const result = await handlers.get("aria:diagnostics:export-logs")!(null, { fps: 60 });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(result.path, "desktop.log"), "utf8")).toBe("test log");
    expect(JSON.parse(readFileSync(path.join(result.path, "diagnostics.json"), "utf8"))).toMatchObject({ backendPid: 123, gpuOptimizeEnabled: false, runtime: { fps: 60 } });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
