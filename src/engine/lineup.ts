/**
 * The uncensored model ladder. me.md ships no weights; it installs them on the
 * user's own machine. This file is the single source of truth for WHICH
 * uncensored (abliterated) models we pull, sized to the hardware we detect.
 *
 * Every tag here is a real, currently-pullable Ollama model verified against
 * ollama.com (the huihui_ai and mannix abliteration namespaces). An invented
 * tag would 404 on pull and break the turnkey install, so nothing aspirational
 * lives in this list: if it is not confirmed pullable, it is not here. Run
 * `npm run verify:weights` to re-prove every pin still resolves on the registry.
 *
 * "Abliterated" means the refusal directions have been removed from the open
 * weights, so the model answers without a content-policy layer. The product is
 * uncensored SPEECH. The deterministic action-sentinel (security/sentinel.ts)
 * still gates dangerous ACTIONS: uncensored words, honest hands.
 */

export type Rung = "floor" | "low" | "mid" | "high";

export interface LadderModel {
  /** Ollama pull tag. Verified pullable. */
  tag: string;
  /** Short human label for boot logs. */
  label: string;
  /** Approximate download size, GB (Q4-class). */
  sizeGb: number;
  /**
   * Memory (system RAM, or unified memory on Apple Silicon) needed to load the
   * weights with modest context. The weights must fit here to run at all; a
   * discrete GPU only makes it faster.
   */
  minMemGb: number;
  /** Whether the model supports tool / function calling (we route agentic tools). */
  tools: boolean;
}

/**
 * Four rungs, smallest to largest. The bootstrap picks the largest rung the
 * detected hardware can hold, so the same package is a 1.9 GB twin on a thin
 * laptop and a 43 GB twin on a workstation: free, local, and it grows with the
 * machine.
 */
export const ABLITERATED_LADDER: Record<Rung, LadderModel> = {
  floor: {
    tag: "huihui_ai/qwen2.5-abliterate:3b",
    label: "Qwen2.5 3B (abliterated)",
    sizeGb: 1.9,
    minMemGb: 5,
    tools: true,
  },
  low: {
    tag: "mannix/llama3.1-8b-abliterated:tools-q4_k_m",
    label: "Llama 3.1 8B (abliterated)",
    sizeGb: 4.9,
    minMemGb: 10,
    tools: true,
  },
  mid: {
    tag: "huihui_ai/qwen2.5-abliterate:32b",
    label: "Qwen2.5 32B (abliterated)",
    sizeGb: 20,
    minMemGb: 28,
    tools: true,
  },
  high: {
    tag: "huihui_ai/llama3.3-abliterated:70b-instruct-q4_K_M",
    label: "Llama 3.3 70B (abliterated)",
    sizeGb: 43,
    minMemGb: 52,
    tools: true,
  },
};

/**
 * The tiniest abliterated tag we know, for a machine that cannot even hold the
 * floor rung with headroom. The bootstrap tries this before giving up. It is
 * coherent but small; a last resort, not a default.
 */
export const FLOOR_FALLBACK: LadderModel = {
  tag: "huihui_ai/qwen2.5-abliterate:1.5b",
  label: "Qwen2.5 1.5B (abliterated)",
  sizeGb: 1.0,
  minMemGb: 3,
  tools: true,
};

/** Local embedding model for RAG. Tiny, ubiquitous, well-supported by Ollama. */
export const EMBED_MODEL = {
  tag: "nomic-embed-text",
  label: "nomic-embed-text",
  sizeGb: 0.28,
} as const;

/** Headroom factor: a model needs its weights plus room for the OS and context. */
const HEADROOM = 1.2;

/** The rungs, largest first, for "pick the biggest that fits". */
const DESCENDING: Rung[] = ["high", "mid", "low", "floor"];

export interface LadderPick {
  rung: Rung;
  model: LadderModel;
  /** True when even the floor rung did not clear with headroom (machine is thin). */
  belowFloor: boolean;
}

/**
 * Choose the largest abliterated model the host can hold. The binding constraint
 * is loadable memory: the weights live in system RAM (or unified memory on Apple
 * Silicon), and a discrete GPU, when present, only accelerates them. So we gate
 * on the larger of RAM and VRAM and keep a headroom margin.
 *
 * Always returns a model. When the host cannot clear even the floor rung,
 * belowFloor is set so the caller can warn (and the bootstrap can fall back to
 * the tiny last-resort tag before failing honestly).
 */
export function pickAbliterated(ramGb: number, vramGb: number): LadderPick {
  const mem = Math.max(ramGb, vramGb);
  for (const rung of DESCENDING) {
    const model = ABLITERATED_LADDER[rung];
    if (mem >= model.minMemGb * HEADROOM) {
      return { rung, model, belowFloor: false };
    }
  }
  return { rung: "floor", model: ABLITERATED_LADDER.floor, belowFloor: true };
}
