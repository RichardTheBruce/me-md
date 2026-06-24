/**
 * The three tiers of me.md. The CORE CODE is identical across all of them:
 * the only thing a tier changes is which models the router and subsystems run.
 * Hardware is auto-detected on boot (see core/detect.ts) and the matching
 * profile becomes the default lineup. Every model is still env-overridable, so
 * you can pin the exact tag your host has pulled.
 *
 *   me.md:     a modern laptop/desktop with one capable GPU (24-48 GB VRAM)
 *   megame.md: a powerful workstation / multi-GPU rig (~128 GB VRAM)
 *   gigame.md: a giant rig / server (256 GB+ VRAM)
 *
 * Model names below are the recommended lineup. They are written as ollama-style
 * tags; set the exact tag your host serves via the ME_MODEL_* env vars.
 */

export type Tier = "me" | "mega" | "giga";

export const TIERS: Tier[] = ["me", "mega", "giga"];

/** The package name that pins each tier. */
export const TIER_PACKAGE: Record<Tier, string> = {
  me: "me.md",
  mega: "megame.md",
  giga: "gigame.md",
};

export interface TierModels {
  /** Deep reasoner over the corpus and decisions. */
  reasoner: string;
  /** Agentic orchestrator that drives the multi-step MCP tool loop. */
  agent: string;
  /** Fast recall / short exchanges. */
  fast: string;
  /** Code generation and review. */
  coder: string;
  /** Embeddings for retrieval. */
  embed: string;
  /** Always-on security gate (fast prompt-injection / policy screen). */
  securityGate: string;
  /** Deep security reviewer for flagged actions. */
  securityDeep: string;
  /** Judge model that scores agent output against a rubric (SHIP/ITERATE/REJECT). */
  judge: string;
}

export interface TierProfile {
  tier: Tier;
  pkg: string;
  label: string;
  /** Human-facing hardware guidance, shown in `me up` and the README. */
  hardware: string;
  /** Lower bound of total system RAM (GB) used by auto-detect. */
  minRamGb: number;
  /** Lower bound of total GPU VRAM (GB) used by auto-detect. */
  minVramGb: number;
  models: TierModels;
}

// The security gate, deep reviewer, and judge are shared across all tiers: the
// safety floor does not get weaker on a smaller box. Pulled out to keep one
// source of truth.
const SHARED_SECURITY = {
  // Meta LlamaFirewall family: fast always-on gate (prompt-injection / policy).
  securityGate: "llama-guard3:8b",
  // Cisco Foundation-Sec-8B-Reasoning: deep reviewer for flagged actions.
  securityDeep: "foundation-sec-8b-reasoning",
  // Prometheus-2 style evaluator: scores output against a rubric.
  judge: "prometheus-eval:7b-v2",
} as const;

export const TIER_PROFILES: Record<Tier, TierProfile> = {
  me: {
    tier: "me",
    pkg: "me.md",
    label: "me.md",
    hardware: "modern laptop/desktop, one capable GPU (~24-48 GB VRAM, 32 GB+ RAM)",
    minRamGb: 24,
    minVramGb: 20,
    models: {
      agent: "qwen3.5-35b-a3b",
      reasoner: "qwen3.5-32b",
      coder: "qwen3-coder:30b-a3b",
      fast: "qwen3:4b",
      embed: "qwen3-embedding:4b",
      ...SHARED_SECURITY,
    },
  },
  mega: {
    tier: "mega",
    pkg: "megame.md",
    label: "megame.md",
    hardware: "powerful workstation / multi-GPU rig (~128 GB VRAM, 128 GB+ RAM)",
    minRamGb: 96,
    minVramGb: 96,
    models: {
      agent: "glm-4.7",
      reasoner: "deepseek-v4-flash",
      coder: "glm-4.6",
      fast: "qwen3:8b",
      embed: "qwen3-embedding:8b",
      ...SHARED_SECURITY,
    },
  },
  giga: {
    tier: "giga",
    pkg: "gigame.md",
    label: "gigame.md",
    hardware: "giant rig / server (256 GB+ VRAM, 256 GB+ RAM)",
    minRamGb: 192,
    minVramGb: 192,
    models: {
      agent: "glm-5.2",
      reasoner: "kimi-k2.6",
      coder: "qwen3-coder:480b",
      fast: "qwen3:8b",
      embed: "qwen3-embedding:8b",
      ...SHARED_SECURITY,
    },
  },
};

export function isTier(s: string): s is Tier {
  return s === "me" || s === "mega" || s === "giga";
}

/** Normalize loose tier aliases (package names, "megame", etc.) to a Tier. */
export function parseTier(s: string | undefined): Tier | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase().replace(/\.md$/, "");
  if (t === "me" || t === "memd") return "me";
  if (t === "mega" || t === "megame") return "mega";
  if (t === "giga" || t === "gigame") return "giga";
  return undefined;
}

/**
 * Map an interactive menu pick to a tier. Accepts the menu numbers (1/2/3), any
 * tier alias ("mega", "gigame.md", ...), or an empty string to accept the
 * offered default. Anything unrecognized also falls back to the default, so a
 * stray keystroke never derails the boot.
 */
export function pickTier(input: string, fallback: Tier): Tier {
  const t = input.trim().toLowerCase();
  if (t === "") return fallback;
  if (t === "1") return "me";
  if (t === "2") return "mega";
  if (t === "3") return "giga";
  return parseTier(t) ?? fallback;
}
