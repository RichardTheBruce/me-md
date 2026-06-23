import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Config } from "../config.js";
import { EngineClient } from "../engine/client.js";
import { buildIndex } from "../rag/index.js";
import { expandHome } from "../config.js";

type Logger = (msg: string) => void;

export interface BootStatus {
  ok: boolean;
  detail: string;
}

const isWin = process.platform === "win32";

/** Is a binary on PATH? Uses `where` on Windows, `which` elsewhere. */
function binExists(bin: string): boolean {
  const probe = isWin ? "where" : "which";
  const res = spawnSync(probe, [bin], { stdio: "ignore", shell: isWin });
  return res.status === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isLocalOllama(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/v1\/?$/.test(baseUrl);
}

/**
 * Make the engine reachable. If it is down and we are pointed at a local
 * Ollama with the ollama binary present, start `ollama serve` and poll.
 */
export async function ensureEngine(cfg: Config, log: Logger): Promise<BootStatus> {
  const engine = new EngineClient(cfg.engine);
  if (await engine.health()) {
    return { ok: true, detail: "engine already up" };
  }

  if (!isLocalOllama(cfg.engine.baseUrl)) {
    return {
      ok: false,
      detail: `engine unreachable at ${cfg.engine.baseUrl} (remote engine; start it there)`,
    };
  }
  if (!binExists("ollama")) {
    return {
      ok: false,
      detail: "engine down and ollama not installed. Install from https://ollama.com then rerun.",
    };
  }

  log("engine down. starting ollama serve...");
  const child = spawn("ollama", ["serve"], {
    detached: true,
    stdio: "ignore",
    shell: isWin,
  });
  child.unref();

  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (await engine.health()) {
      return { ok: true, detail: "ollama started" };
    }
  }
  return { ok: false, detail: "started ollama but engine never became reachable (30s timeout)" };
}

/** Pull `ollama pull <model>` synchronously, streaming nothing (quiet). */
function pullModel(model: string): boolean {
  const res = spawnSync("ollama", ["pull", model], { stdio: "inherit", shell: isWin });
  return res.status === 0;
}

/**
 * Make sure the routed model lineup is present. With doPull, fetch any missing
 * ones via ollama; otherwise just report what is missing.
 */
export async function ensureModels(cfg: Config, log: Logger, doPull: boolean): Promise<BootStatus> {
  const engine = new EngineClient(cfg.engine);
  const wanted = [
    cfg.models.reasoner,
    cfg.models.agent,
    cfg.models.fast,
    cfg.models.coder,
    cfg.models.embed,
  ];
  const unique = [...new Set(wanted)];
  const have = await engine.listModels();
  const haveSet = new Set(have);
  // Ollama reports ids verbatim; tolerate the implicit :latest tag.
  const present = (m: string): boolean =>
    haveSet.has(m) || haveSet.has(`${m}:latest`) || (m.endsWith(":latest") && haveSet.has(m.slice(0, -7)));

  const missing = unique.filter((m) => !present(m));
  if (missing.length === 0) {
    return { ok: true, detail: `all ${unique.length} models present` };
  }

  if (!doPull) {
    return {
      ok: false,
      detail: `missing models: ${missing.join(", ")} (run 'me up --pull' to fetch)`,
    };
  }
  if (!binExists("ollama")) {
    return { ok: false, detail: `missing ${missing.join(", ")} and ollama not installed` };
  }

  for (const m of missing) {
    log(`pulling ${m} ...`);
    if (!pullModel(m)) {
      return { ok: false, detail: `failed to pull ${m}` };
    }
  }
  return { ok: true, detail: `pulled ${missing.length} model(s)` };
}

/** Build the RAG index on first run, if any corpus root actually exists. */
export async function ensureIndex(cfg: Config, log: Logger): Promise<BootStatus> {
  if (existsSync(cfg.indexDir)) {
    return { ok: true, detail: "index present" };
  }
  const liveRoots = cfg.corpus.roots.filter((r) => existsSync(expandHome(r.path)));
  if (liveRoots.length === 0) {
    return { ok: true, detail: "no corpus roots on this machine; skipping index" };
  }
  log(`building index over ${liveRoots.length} corpus root(s)...`);
  const engine = new EngineClient(cfg.engine);
  const res = await buildIndex(cfg, engine);
  return { ok: true, detail: `indexed ${res.chunks} chunks from ${res.files} files` };
}
