import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decideTier, type TierDecision } from "./core/detect.js";
import { TIER_PROFILES, parseTier, type Tier } from "./tiers.js";
import { readSavedTier, resolveStore, type LocalStore } from "./store/local.js";

export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

export interface CorpusRoot {
  label: string;
  path: string;
  glob: string;
}

export interface CorpusConfig {
  roots: CorpusRoot[];
  exclude: string[];
  chunk: { maxChars: number; overlap: number };
}

export interface EngineConfig {
  baseUrl: string;
  apiKey: string;
}

export interface ModelConfig {
  reasoner: string;
  agent: string;
  fast: string;
  coder: string;
  embed: string;
  /** Always-on fast security gate (prompt-injection / policy screen). */
  securityGate: string;
  /** Deep security reviewer for flagged actions. */
  securityDeep: string;
  /** Judge model that scores agent output against a rubric. */
  judge: string;
}

export interface Config {
  engine: EngineConfig;
  models: ModelConfig;
  mcpConfigPath: string;
  personaPath: string;
  corpus: CorpusConfig;
  repoRoot: string;
  indexDir: string;
  /** The resolved hardware tier (me / mega / giga). */
  tier: Tier;
  /** Full tier decision (hardware probe + source), for boot reporting. */
  tierInfo: TierDecision;
  /** The per-install local store (~/.me.md) where the evolving self lives. */
  store: LocalStore;
  /** Bundled persona template, used to seed the store on first run. */
  bundledPersonaPath: string;
  /** Bundled corpus config, used to seed the store on first run. */
  bundledCorpusConfigPath: string;
}

export interface ConfigOptions {
  /** Pin a tier, bypassing auto-detect (CLI --tier wins over ME_TIER). */
  tier?: Tier;
}

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : fallback;
}

/** Minimal dependency-free .env loader. Does not override already-set vars. */
export function loadEnv(repoRoot: string): void {
  const p = join(repoRoot, ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/**
 * Resolve the active tier. Precedence:
 *   1. explicit override  (--tier flag, then ME_TIER env):  transient, wins always
 *   2. saved choice        (~/.me.md/tier.json):            the first-boot pick
 *   3. hardware auto-detect (RAM + VRAM probe):             the default recommendation
 */
export function resolveTier(opts: ConfigOptions = {}): TierDecision {
  const explicit = opts.tier ?? parseTier(process.env.ME_TIER);
  if (explicit) return decideTier(explicit);

  const saved = readSavedTier();
  if (saved) {
    const d = decideTier(saved);
    return {
      ...d,
      source: "saved",
      detail: `tier ${TIER_PROFILES[saved].label} (saved) · ${d.ramGb}GB RAM · ${d.vramGb}GB VRAM (${d.gpu})`,
    };
  }

  return decideTier(undefined);
}

export function loadConfig(repoRoot: string, opts: ConfigOptions = {}): Config {
  // The package ships these as seed templates; the live, evolving copies live in
  // the per-install store (~/.me.md), so a globally-installed package is never
  // written to and every user gets their own neural net.
  const bundledPersonaPath = join(repoRoot, "src", "persona", "me.md");
  const bundledCorpusConfigPath = join(repoRoot, "corpus.config.json");
  const store = resolveStore();

  // Corpus config: the user's store copy wins, then the bundled seed, then empty.
  const corpusPath = existsSync(store.corpusConfigPath)
    ? store.corpusConfigPath
    : bundledCorpusConfigPath;
  const corpus: CorpusConfig = existsSync(corpusPath)
    ? (JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusConfig)
    : { roots: [], exclude: [], chunk: { maxChars: 1200, overlap: 150 } };

  // Persona + index default to the store, but stay env-overridable.
  const personaPath = expandHome(env("ME_PERSONA_PATH", store.personaPath));
  const indexDir = expandHome(env("ME_INDEX_DIR", store.indexDir));

  // Tier picks the default model lineup; every model stays env-overridable so a
  // host can pin the exact tag it has pulled.
  const tierInfo = resolveTier(opts);
  const lineup = TIER_PROFILES[tierInfo.tier].models;

  return {
    engine: {
      baseUrl: env("ME_ENGINE_BASE_URL", "http://localhost:11434/v1"),
      apiKey: env("ME_ENGINE_API_KEY", "ollama"),
    },
    models: {
      reasoner: env("ME_MODEL_REASONER", lineup.reasoner),
      agent: env("ME_MODEL_AGENT", lineup.agent),
      fast: env("ME_MODEL_FAST", lineup.fast),
      coder: env("ME_MODEL_CODER", lineup.coder),
      embed: env("ME_MODEL_EMBED", lineup.embed),
      securityGate: env("ME_MODEL_SECURITY_GATE", lineup.securityGate),
      securityDeep: env("ME_MODEL_SECURITY_DEEP", lineup.securityDeep),
      judge: env("ME_MODEL_JUDGE", lineup.judge),
    },
    mcpConfigPath: expandHome(env("ME_MCP_CONFIG", join(homedir(), ".claude.json"))),
    personaPath,
    corpus,
    repoRoot,
    indexDir,
    tier: tierInfo.tier,
    tierInfo,
    store,
    bundledPersonaPath,
    bundledCorpusConfigPath,
  };
}
