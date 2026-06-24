import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface UpdateInfo {
  /** Package name as published (me.md / megame.md / gigame.md). */
  name: string;
  /** Currently installed version. */
  current: string;
  /** Latest version on the registry, or null if unreachable. */
  latest: string | null;
  /** True when latest > current. */
  newer: boolean;
}

interface Pkg {
  name: string;
  version: string;
}

function readPkg(repoRoot: string): Pkg {
  try {
    const p = join(repoRoot, "package.json");
    if (existsSync(p)) {
      const pkg = JSON.parse(readFileSync(p, "utf8")) as { name?: string; version?: string };
      return { name: pkg.name ?? "me.md", version: pkg.version ?? "0.0.0" };
    }
  } catch {
    // fall through
  }
  return { name: "me.md", version: "0.0.0" };
}

/** Compare two dotted versions numerically (prerelease tags ignored). -1/0/1. */
export function cmpSemver(a: string, b: string): number {
  const pa = a.split("-")[0]?.split(".").map(Number) ?? [];
  const pb = b.split("-")[0]?.split(".").map(Number) ?? [];
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Ask the npm registry whether a newer release of this package exists. Pure
 * fetch (no npm needed), short timeout, and fully swallowed on failure so an
 * offline machine never pays for the check.
 */
export async function checkForUpdate(repoRoot: string, timeoutMs = 2500): Promise<UpdateInfo> {
  const { name, version } = readPkg(repoRoot);
  let latest: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    clearTimeout(timer);
    if (res.ok) {
      const body = (await res.json()) as { version?: string };
      if (typeof body.version === "string") latest = body.version;
    }
  } catch {
    // offline / registry down / aborted: leave latest null
  }
  return { name, current: version, latest, newer: latest ? cmpSemver(latest, version) > 0 : false };
}

/** Install the latest release globally (npm i -g <name>@latest). */
export async function applyUpdate(name: string): Promise<string> {
  const { stdout, stderr } = await exec("npm", ["install", "-g", `${name}@latest`], {
    timeout: 120_000,
  });
  return (stdout + stderr).trim();
}
