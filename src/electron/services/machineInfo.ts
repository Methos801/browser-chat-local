/**
 * machine_info skill: detect & store the host's specs so other skills can
 * auto-tune (context caps, quantization, protocol).
 *
 * Sources: Node `os`, probes for omlx / python / ollama CLIs, and oMLX's
 * /admin/api/device-info (chip / GPU cores / memory) as a second source.
 *
 * Platform gate: oMLX is Apple-Silicon / macOS-15+ only, so `omlxAvailable`
 * is only true on macOS on Apple Silicon.
 */

import { execFileSync } from "node:child_process";
import * as os from "node:os";
import type { MachineInfo } from "../ipc";
import { automaticContextTarget } from "./modelBudget";

export async function probeMachineInfo(port = 8000): Promise<MachineInfo> {
  const osName = process.platform === "win32" ? "win32" : process.platform;
  const isAppleSilicon = osName === "darwin" && /arm64/.test(os.arch());

  // Native chip / cores / memory from Node.
  const chip = detectChip();
  const ramGB = Math.round(os.totalmem() / (1024 ** 3));
  const gpuCores = detectGpuCores(isAppleSilicon);

  // Detect local servers + oMLX availability.
  const omlxAvailable = isAppleSilicon && which("omlx") !== undefined;
  const localServers: string[] = [];
  if (which("ollama") !== undefined) localServers.push("ollama");
  if (omlxAvailable) localServers.push("omlx");

  const pythonVersion = safeVersion("python3") ?? safeVersion("python") ?? "";

  // oMLX endpoint (only meaningful on macOS Apple Silicon).
  const omlxEndpoint = omlxAvailable ? `http://localhost:${port}/v1` : "";

  // Second source: oMLX's admin device-info (chip / GPU / memory).
  const device = omlxAvailable ? await adminDeviceInfo(port).catch(() => null) : null;
  const chipFinal = device?.chipName || chip;
  const gpuCoresFinal = device?.gpuCores ?? gpuCores;
  const ramGBFinal = device?.memoryGB ?? ramGB;

  // Suggest context window / quant from memory + model family.
  const suggestedContextWindow = automaticContextTarget(ramGBFinal);
  const suggestedQuant = "4bit";

  return {
    os: osName,
    ramGB: ramGBFinal,
    chip: chipFinal,
    gpuCores: gpuCoresFinal,
    accelerator: omlxAvailable ? "mlx" : "",
    omlxAvailable,
    omlxEndpoint,
    pythonVersion,
    localServers,
    suggestedContextWindow,
    suggestedQuant,
  };
}

/* ------------------------------ helpers ------------------------------- */

function detectChip(): string {
  try {
    if (process.platform === "darwin") {
      const raw = execFileSync("system_profiler", ["SPHardwareDataType"], { encoding: "utf8" });
      const match = raw.match(/Chip:\s*(.+)/);
      if (match) return match[1].trim();
    }
  } catch {
    /* ignore */
  }
  return `${os.cpus()[0]?.model ?? os.arch()}`;
}

function detectGpuCores(isAppleSilicon: boolean): number {
  // Apple Silicon reports "cores" in system_profiler; fall back to logical CPUs.
  if (isAppleSilicon) {
    try {
      const raw = execFileSync("system_profiler", ["SPHardwareDataType"], { encoding: "utf8" });
      const match = raw.match(/Core\s*(\d+)/);
      if (match) return parseInt(match[1], 10);
    } catch {
      /* ignore */
    }
  }
  return os.cpus()?.length ?? 0;
}

function which(bin: string): string | undefined {
  try {
    return execFileSync("which", [bin], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function safeVersion(bin: string): string | undefined {
  try {
    const v = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
    const m = v.match(/v?(\d+\.\d+\.\d+)/);
    return m ? m[1] : v;
  } catch {
    return undefined;
  }
}

async function adminDeviceInfo(port: number): Promise<{ chipName: string; gpuCores: number; memoryGB: number }> {
  const res = await fetch(`http://localhost:${port}/admin/api/device-info`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`device-info ${res.status}`);
  const data: any = await res.json();
  return {
    chipName: data.chipName ?? data.chip ?? "",
    gpuCores: data.gpuCores ?? data.gpu_cores ?? 0,
    memoryGB: data.memoryGB ?? data.memory_gb ?? Math.round(os.totalmem() / (1024 ** 3)),
  };
}
