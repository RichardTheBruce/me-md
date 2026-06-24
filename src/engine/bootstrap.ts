/**
 * Turnkey engine bootstrap. After `npm i` + `me up`, this makes a real,
 * uncensored local twin bootable with zero manual setup:
 *
 *   1. HOSTED path:  if ME_ENGINE_BASE_URL points at a remote engine, health-
 *      check it and use it. Nothing is installed locally. (This is also the
 *      seam for the future hosted tier: one env var flips a thin laptop onto a
 *      box we run.)
 *   2. LOCAL path:   otherwise drive a local Ollama. If the binary is missing we
 *      install it silently (no prompt, no fanfare: it is just a runner). Then we
 *      size ONE abliterated model to the detected hardware, pull it plus the
 *      embedder, start the daemon, and confirm the engine can serve it.
 *
 * There is deliberately NO growth-only fallback. If a host genuinely cannot run
 * even the smallest abliterated model and we cannot reach a hosted engine, we
 * fail honestly and say so, rather than faking a working twin.
 *
 * Every side effect (install, serve, pull, hardware probe, HTTP) is injectable,
 * so the unit tests exercise the whole flow with fakes and never touch the
 * network or the real installer.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { EngineClient, type ChatOptions } from "./client.js";
import { binExists, isLocalOllama } from "../core/boot.js";
import { probeHardware, type HardwareProbe } from "../core/detect.js";
import { EMBED_MODEL, FLOOR_FALLBACK, pickAbliterated } from "./lineup.js";
import type { ChatResult } from "../types.js";

type Logger = (msg: string) => void;

const isWin = process.platform === "win32";

/** Env keys that, when set, mean the user pinned an exact model: skip collapse. */
const MODEL_ENV_KEYS = [
  "ME_MODEL_AGENT",
  "ME_MODEL_REASONER",
  "ME_MODEL_FAST",
  "ME_MODEL_CODER",
] as const;

/** The subset of EngineClient the bootstrap needs. EngineClient satisfies it. */
export interface EngineProbe {
  health(): Promise<boolean>;
  listModels(): Promise<string[]>;
  chat(opts: ChatOptions): Promise<ChatResult>;
}

export interface BootstrapResult {
  ok: boolean;
  /** Human-facing one-liner for the boot log. */
  detail: string;
  /** "hosted" when a remote engine was used; "local" when we drove Ollama. */
  mode: "hosted" | "local";
  /**
   * On the turnkey local path, the single hardware-sized model that every chat
   * lane should route to. Undefined on the hosted path and the pinned-lineup
   * path (there the tier lineup stands).
   */
  primaryModel?: string;
  /** True when the host could not clear even the floor rung (thin machine). */
  belowFloor?: boolean;
}

/** Injectable seams. Real defaults drive the OS; tests pass fakes. */
export interface BootstrapDeps {
  log: Logger;
  engine: EngineProbe;
  probe: () => HardwareProbe;
  /** Resolve the ollama binary (path or "ollama"); null when absent. */
  resolveBin: () => string | null;
  /** Silently install ollama; resolve true only if the binary ends up present. */
  install: (log: Logger) => Promise<boolean>;
  /** Start the engine daemon (detached). */
  serve: (bin: string, log: Logger) => void;
  /** Pull one model tag; resolve true on success. */
  pull: (bin: string, tag: string, log: Logger) => Promise<boolean>;
  /** Master switch for the silent installer (off in CI/tests). */
  autoInstall: boolean;
  /** Milliseconds to wait for the daemon to answer after serve. */
  serveTimeoutMs: number;
  /** Poll interval while waiting for the daemon to come up. */
  pollIntervalMs: number;
}

export interface ModelPlan {
  /** True when we collapsed to a single hardware-sized model (turnkey). */
  turnkey: boolean;
  /** The primary chat model. On turnkey, every chat lane routes here. */
  primary: string;
  /** All distinct tags to ensure present (always includes the embedder). */
  targets: string[];
  /** Set when the host could not clear the floor rung. */
  belowFloor: boolean;
}

function dedup(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x && x.length > 0))];
}

/**
 * Turnkey when the tier was hardware-detected (not pinned) AND the user did not
 * pin any exact model via ME_MODEL_*. In that case we ignore the multi-model
 * tier lineup and run ONE model sized to the actual machine. A pinned tier or
 * an explicit model override opts into the full lineup.
 */
export function isTurnkey(cfg: Config): boolean {
  if (cfg.tierInfo.source !== "auto") return false;
  return !MODEL_ENV_KEYS.some((k) => {
    const v = process.env[k];
    return v !== undefined && v.length > 0;
  });
}

/**
 * Decide which models to ensure. Pure: no I/O, so the turnkey-vs-pinned choice
 * and the single-model collapse are unit-testable on their own.
 */
export function planModels(cfg: Config, probe: HardwareProbe, turnkey: boolean): ModelPlan {
  if (turnkey) {
    const pick = pickAbliterated(probe.ramGb, probe.vramGb);
    // Below the floor rung, drop to the tiny last-resort tag before giving up.
    const model = pick.belowFloor ? FLOOR_FALLBACK : pick.model;
    const embed = cfg.models.embed || EMBED_MODEL.tag;
    return {
      turnkey: true,
      primary: model.tag,
      targets: dedup([model.tag, embed]),
      belowFloor: pick.belowFloor,
    };
  }
  // Pinned: pull the full tier lineup as configured.
  const m = cfg.models;
  return {
    turnkey: false,
    primary: m.agent,
    targets: dedup([m.reasoner, m.agent, m.fast, m.coder, m.embed]),
    belowFloor: false,
  };
}

/** True when the engine already serves `tag` (tolerating the implicit :latest). */
function serves(have: Set<string>, tag: string): boolean {
  return (
    have.has(tag) ||
    have.has(`${tag}:latest`) ||
    (tag.endsWith(":latest") && have.has(tag.slice(0, -7)))
  );
}

/**
 * Resolve the ollama binary. Prefer PATH; otherwise look in the per-OS default
 * install location (the installer often cannot refresh THIS process's PATH).
 */
export function resolveOllamaBin(): string | null {
  if (binExists("ollama")) return "ollama";
  if (isWin) {
    const la = process.env.LOCALAPPDATA;
    if (la) {
      const p = join(la, "Programs", "Ollama", "ollama.exe");
      if (existsSync(p)) return p;
    }
  } else if (process.platform === "darwin") {
    for (const p of [
      "/usr/local/bin/ollama",
      "/opt/homebrew/bin/ollama",
      "/Applications/Ollama.app/Contents/Resources/ollama",
    ]) {
      if (existsSync(p)) return p;
    }
  } else {
    for (const p of ["/usr/local/bin/ollama", "/usr/bin/ollama"]) {
      if (existsSync(p)) return p;
    }
  }
  return null;
}

/**
 * Silently install Ollama for the current OS. Best-effort and fully guarded:
 * any failure returns false so the caller falls back to an honest message. We
 * never narrate it as "installing Ollama"; it is just the local runner.
 */
export async function defaultInstallOllama(log: Logger): Promise<boolean> {
  log("first run: preparing the local engine (one time)...");
  try {
    if (process.platform === "linux") {
      // Official one-line installer.
      const res = spawnSync("sh", ["-c", "curl -fsSL https://ollama.com/install.sh | sh"], {
        stdio: "ignore",
      });
      return res.status === 0 && resolveOllamaBin() !== null;
    }
    if (process.platform === "darwin") {
      // Homebrew is the clean scriptable path; without it, fail to an honest msg.
      if (binExists("brew")) {
        const res = spawnSync("brew", ["install", "--quiet", "ollama"], { stdio: "ignore" });
        return res.status === 0 && resolveOllamaBin() !== null;
      }
      return false;
    }
    if (isWin) {
      // Download the official silent installer, run /VERYSILENT, then resolve the
      // binary from its default location (this process's PATH stays stale).
      const exe = join(tmpdir(), "OllamaSetup.exe");
      const dl = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Invoke-WebRequest -Uri https://ollama.com/download/OllamaSetup.exe -OutFile "${exe}"`,
        ],
        { stdio: "ignore" },
      );
      if (dl.status !== 0 || !existsSync(exe)) return false;
      const inst = spawnSync(exe, ["/VERYSILENT", "/NORESTART"], { stdio: "ignore" });
      if (inst.status !== 0) return false;
      return resolveOllamaBin() !== null;
    }
    return false;
  } catch {
    return false;
  }
}

/** Start `ollama serve` detached so it outlives the boot step. */
function defaultServe(bin: string, log: Logger): void {
  log("starting the local engine...");
  const child = spawn(bin, ["serve"], { detached: true, stdio: "ignore", shell: isWin });
  child.unref();
}

/** Pull one model, streaming ollama's own progress so a big download is visible. */
async function defaultPull(bin: string, tag: string, log: Logger): Promise<boolean> {
  log(`pulling ${tag} (first run downloads the weights)...`);
  const res = spawnSync(bin, ["pull", tag], { stdio: "inherit", shell: isWin });
  return res.status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function withDefaults(cfg: Config, opts: Partial<BootstrapDeps>): BootstrapDeps {
  return {
    log: opts.log ?? (() => {}),
    engine: opts.engine ?? new EngineClient(cfg.engine),
    probe: opts.probe ?? probeHardware,
    resolveBin: opts.resolveBin ?? resolveOllamaBin,
    install: opts.install ?? defaultInstallOllama,
    serve: opts.serve ?? defaultServe,
    pull: opts.pull ?? defaultPull,
    autoInstall: opts.autoInstall ?? process.env.ME_NO_AUTO_INSTALL !== "1",
    serveTimeoutMs: opts.serveTimeoutMs ?? 30_000,
    pollIntervalMs: opts.pollIntervalMs ?? 1000,
  };
}

const HOSTED_HINT =
  "set ME_ENGINE_BASE_URL to a hosted engine, or unset it to run locally";

/**
 * Make the twin's brain real and reachable. Returns ok=false with an honest
 * detail when it cannot, so the caller refuses to drop into a fake growth loop.
 */
export async function bootstrapEngine(
  cfg: Config,
  opts: Partial<BootstrapDeps> = {},
): Promise<BootstrapResult> {
  const d = withDefaults(cfg, opts);

  // 1. HOSTED PATH: a remote engine is the source of truth; touch nothing local.
  if (!isLocalOllama(cfg.engine.baseUrl)) {
    if (await d.engine.health()) {
      return { ok: true, mode: "hosted", detail: `using hosted engine at ${cfg.engine.baseUrl}` };
    }
    return {
      ok: false,
      mode: "hosted",
      detail: `hosted engine unreachable at ${cfg.engine.baseUrl} (start it there, or unset ME_ENGINE_BASE_URL to run locally)`,
    };
  }

  // 2. LOCAL PATH: resolve (or silently install) the ollama runner.
  let bin = d.resolveBin();
  if (!bin) {
    if (!d.autoInstall) {
      return {
        ok: false,
        mode: "local",
        detail: `local engine not installed and auto-install is off (${HOSTED_HINT})`,
      };
    }
    const installed = await d.install(d.log);
    bin = installed ? d.resolveBin() : null;
    if (!bin) {
      return {
        ok: false,
        mode: "local",
        detail: `could not set up the local engine automatically. Install Ollama from https://ollama.com, or ${HOSTED_HINT}`,
      };
    }
  }

  // 3. Make sure the daemon answers; start it if not. Poll-before-sleep so a
  // daemon that is already warm is detected with no delay.
  let healthy = await d.engine.health();
  if (!healthy) {
    d.serve(bin, d.log);
    const deadline = Date.now() + d.serveTimeoutMs;
    while (!healthy && Date.now() < deadline) {
      healthy = await d.engine.health();
      if (healthy) break;
      await sleep(d.pollIntervalMs);
    }
  }
  if (!healthy) {
    return {
      ok: false,
      mode: "local",
      detail: `started the local engine but it never answered (${Math.round(d.serveTimeoutMs / 1000)}s timeout)`,
    };
  }

  // 4. Plan the models: one sized model on turnkey, the full lineup when pinned.
  const plan = planModels(cfg, d.probe(), isTurnkey(cfg));

  // 5. Pull whatever is missing.
  const have = new Set(await d.engine.listModels());
  const missing = plan.targets.filter((t) => !serves(have, t));
  for (const tag of missing) {
    const ok = await d.pull(bin, tag, d.log);
    if (!ok) {
      // The floor download failing is terminal: there is nothing smaller to try
      // beyond the last-resort tag, which the plan already selected on belowFloor.
      return {
        ok: false,
        mode: "local",
        detail: `failed to pull ${tag} (${HOSTED_HINT})`,
      };
    }
  }

  // 6. Confirm the engine actually serves the primary model now.
  const after = new Set(await d.engine.listModels());
  if (!serves(after, plan.primary)) {
    return {
      ok: false,
      mode: "local",
      detail: `pulled models but the engine does not list ${plan.primary}`,
    };
  }

  const sized = plan.turnkey
    ? `sized to host: ${plan.primary}${plan.belowFloor ? " (thin host: smallest twin)" : ""}`
    : `lineup ready (${plan.targets.length} models)`;
  return {
    ok: true,
    mode: "local",
    detail: `local engine ready, ${sized}`,
    primaryModel: plan.turnkey ? plan.primary : undefined,
    belowFloor: plan.belowFloor,
  };
}
