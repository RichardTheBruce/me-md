import { spawnSync } from "node:child_process";
import { totalmem } from "node:os";
import { TIER_PROFILES, TIERS, type Tier } from "../tiers.js";

export interface HardwareProbe {
  ramGb: number;
  vramGb: number;
  /** Where the VRAM number came from. */
  gpu: "nvidia" | "apple" | "amd" | "none";
}

export interface TierDecision {
  tier: Tier;
  ramGb: number;
  vramGb: number;
  gpu: HardwareProbe["gpu"];
  /** True when the host is below the recommended floor for even the me tier. */
  belowFloor: boolean;
  source: "override" | "auto";
  detail: string;
}

const isWin = process.platform === "win32";

function run(cmd: string, args: string[]): string | null {
  try {
    const res = spawnSync(cmd, args, { encoding: "utf8", shell: isWin, timeout: 4000 });
    if (res.status !== 0 || typeof res.stdout !== "string") return null;
    return res.stdout;
  } catch {
    return null;
  }
}

/** Sum NVIDIA VRAM (MB) across GPUs via nvidia-smi. */
function nvidiaVramGb(): number | null {
  const out = run("nvidia-smi", ["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
  if (!out) return null;
  let mb = 0;
  let found = false;
  for (const line of out.split(/\r?\n/)) {
    const n = Number.parseInt(line.trim(), 10);
    if (Number.isFinite(n) && n > 0) {
      mb += n;
      found = true;
    }
  }
  return found ? mb / 1024 : null;
}

/** AMD VRAM (bytes) via rocm-smi. Best-effort. */
function amdVramGb(): number | null {
  const out = run("rocm-smi", ["--showmeminfo", "vram", "--json"]);
  if (!out) return null;
  let bytes = 0;
  let found = false;
  for (const m of out.matchAll(/"VRAM Total Memory \(B\)"\s*:\s*"?(\d+)"?/g)) {
    const n = Number.parseInt(m[1] ?? "", 10);
    if (Number.isFinite(n) && n > 0) {
      bytes += n;
      found = true;
    }
  }
  return found ? bytes / 1024 ** 3 : null;
}

/** Probe system RAM + GPU VRAM. Pure host inspection, no network. */
export function probeHardware(): HardwareProbe {
  const ramGb = totalmem() / 1024 ** 3;

  const nv = nvidiaVramGb();
  if (nv !== null) return { ramGb, vramGb: nv, gpu: "nvidia" };

  // Apple Silicon: unified memory, the GPU can address most of system RAM.
  if (process.platform === "darwin" && process.arch === "arm64") {
    return { ramGb, vramGb: ramGb, gpu: "apple" };
  }

  const amd = amdVramGb();
  if (amd !== null) return { ramGb, vramGb: amd, gpu: "amd" };

  return { ramGb, vramGb: 0, gpu: "none" };
}

/** Highest tier whose RAM+VRAM floors the host clears. */
function pickTier(ramGb: number, vramGb: number): { tier: Tier; belowFloor: boolean } {
  let chosen: Tier = "me";
  let cleared = false;
  for (const tier of TIERS) {
    const p = TIER_PROFILES[tier];
    if (vramGb >= p.minVramGb && ramGb >= p.minRamGb) {
      chosen = tier;
      cleared = true;
    }
  }
  // belowFloor: didn't even clear the me tier (e.g. integrated graphics).
  return { tier: chosen, belowFloor: !cleared };
}

/**
 * Decide the tier. An explicit override (CLI --tier / ME_TIER) always wins;
 * otherwise probe the hardware and pick the largest tier it can run.
 */
export function decideTier(override?: Tier): TierDecision {
  const probe = probeHardware();
  const ramGb = Math.round(probe.ramGb * 10) / 10;
  const vramGb = Math.round(probe.vramGb * 10) / 10;

  if (override) {
    return {
      tier: override,
      ramGb,
      vramGb,
      gpu: probe.gpu,
      belowFloor: false,
      source: "override",
      detail: `tier ${TIER_PROFILES[override].label} (pinned) · ${ramGb}GB RAM · ${vramGb}GB VRAM (${probe.gpu})`,
    };
  }

  const { tier, belowFloor } = pickTier(probe.ramGb, probe.vramGb);
  const detail = belowFloor
    ? `tier me.md (host below recommended floor) · ${ramGb}GB RAM · ${vramGb}GB VRAM (${probe.gpu})`
    : `tier ${TIER_PROFILES[tier].label} (auto) · ${ramGb}GB RAM · ${vramGb}GB VRAM (${probe.gpu})`;

  return { tier, ramGb, vramGb, gpu: probe.gpu, belowFloor, source: "auto", detail };
}
