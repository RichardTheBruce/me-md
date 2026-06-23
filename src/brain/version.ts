import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { listSelfStates } from "../selfstate/snapshot.js";

export interface BrainVersion {
  /** Package semver (the immutable code release). */
  pkg: string;
  /** Latest self-state tag, if any (the evolving you). */
  selfState: string | null;
  /** Active tier label (me / mega / giga). */
  tier: string;
}

/** Read the installed package version from its package.json. */
export function packageVersion(repoRoot: string): string {
  try {
    const p = join(repoRoot, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { version?: string };
      if (typeof pkg.version === "string") return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

/**
 * The version stamp shown in the brain header: which code release you're on,
 * which self-state you've evolved to, and which lineup is live. The corpus
 * digest (which actually changes as your world grows) rides on the graph meta.
 */
export function brainVersion(cfg: Config): BrainVersion {
  const states = listSelfStates(cfg.store.root);
  return {
    pkg: packageVersion(cfg.repoRoot),
    selfState: states[0] ?? null,
    tier: cfg.tier,
  };
}
