/**
 * The three tiers of me.md. The CORE CODE is identical across all of them:
 * the only thing a tier changes is which models the router and subsystems run.
 * Hardware is auto-detected on boot (see core/detect.ts) and the matching
 * profile becomes the default lineup. Every model is still env-overridable, so
 * you can pin the exact tag your host has pulled.
 *
 *   me.md:     any modern laptop or desktop (runs CPU-only, better with a GPU)
 *   megame.md: a powerful workstation / single big GPU (~48 GB+ VRAM)
 *   gigame.md: a giant rig / multi-GPU server (~80 GB+ VRAM)
 *
 * Every model below is a real, currently-pullable abliterated (uncensored) tag,
 * drawn from the verified ladder in engine/lineup.ts. The turnkey boot does not
 * blindly pull a whole tier: it sizes ONE uncensored model to your actual RAM
 * (engine/bootstrap.ts) so a thin laptop still gets a working twin. These tier
 * lineups are the nominal class presets, used when you pin a tier with --tier
 * and pull the full set yourself.
 */

import { ABLITERATED_LADDER, EMBED_MODEL } from "./engine/lineup.js";

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
  /** Deep security reviewer for flagged ACTIONS (not a speech filter). */
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

// The deep reviewer and judge are shared across all tiers: the action-safety
// floor does not get weaker on a smaller box. There is deliberately NO speech
// gate here. me.md is uncensored: we dropped the content-moderation model
// (Llama-Guard) on purpose. What stays is ACTION safety, the deterministic
// sentinel in security/sentinel.ts plus this deep reviewer for risky tool calls.
const SHARED_SECURITY = {
  // Cisco Foundation-Sec-8B-Reasoning: deep reviewer for flagged ACTIONS.
  securityDeep: "foundation-sec-8b-reasoning",
  // Prometheus-2 style evaluator: scores agent OUTPUT against a rubric.
  judge: "prometheus-eval:7b-v2",
} as const;

export const TIER_PROFILES: Record<Tier, TierProfile> = {
  me: {
    tier: "me",
    pkg: "me.md",
    label: "me.md",
    hardware: "any modern laptop or desktop (8 GB+ RAM; runs CPU-only, faster with a GPU)",
    minRamGb: 8,
    minVramGb: 0,
    models: {
      // Laptop class: one small uncensored model carries the chat lanes; the
      // bootstrap may downsize to the 3B floor on a thin machine.
      agent: ABLITERATED_LADDER.low.tag,
      reasoner: ABLITERATED_LADDER.low.tag,
      coder: ABLITERATED_LADDER.low.tag,
      fast: ABLITERATED_LADDER.floor.tag,
      embed: EMBED_MODEL.tag,
      ...SHARED_SECURITY,
    },
  },
  mega: {
    tier: "mega",
    pkg: "megame.md",
    label: "megame.md",
    hardware: "workstation / single big GPU (~48 GB+ VRAM, 64 GB+ RAM)",
    minRamGb: 64,
    minVramGb: 40,
    models: {
      agent: ABLITERATED_LADDER.high.tag,
      reasoner: ABLITERATED_LADDER.high.tag,
      coder: ABLITERATED_LADDER.mid.tag,
      fast: ABLITERATED_LADDER.low.tag,
      embed: EMBED_MODEL.tag,
      ...SHARED_SECURITY,
    },
  },
  giga: {
    tier: "giga",
    pkg: "gigame.md",
    label: "gigame.md",
    hardware: "multi-GPU rig / server (~80 GB+ VRAM, 128 GB+ RAM)",
    minRamGb: 128,
    minVramGb: 80,
    models: {
      agent: ABLITERATED_LADDER.high.tag,
      reasoner: ABLITERATED_LADDER.high.tag,
      coder: ABLITERATED_LADDER.high.tag,
      fast: ABLITERATED_LADDER.mid.tag,
      embed: EMBED_MODEL.tag,
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
