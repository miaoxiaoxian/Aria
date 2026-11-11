export type DiagnosticsSnapshot = {
  generatedAt: string;
  appVersion: string;
  electronVersion?: string;
  cpuModel: string | null;
  cpuCores: number;
  uptimeSeconds: number;
  backendPid: number | null;
  gpuVendorId: number | null;
  gpuOptimizeEnabled: boolean;
  gpuFeatures: Record<string, string>;
  processes: Array<{ type: string; pid: number; cpuPercent: number; memoryMb: number }>;
};
