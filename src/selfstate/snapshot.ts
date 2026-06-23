import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// A self-state is versioned in the *store* (~/.me.md), not the package. We give
// git a committer identity via env so we never mutate the user's git config.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "me.md",
  GIT_AUTHOR_EMAIL: "self@me.md",
  GIT_COMMITTER_NAME: "me.md",
  GIT_COMMITTER_EMAIL: "self@me.md",
};

function git(dir: string, args: string[]): string {
  // Pipe stderr so probe failures (e.g. no HEAD yet) are captured on the thrown
  // error instead of leaking to the console.
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: GIT_ENV,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function tryGit(dir: string, args: string[]): void {
  try {
    git(dir, args);
  } catch {
    // best-effort (e.g. nothing to commit)
  }
}

/** Make the store a git repo with at least one commit, so tags have a target. */
function ensureRepo(dir: string): void {
  if (!existsSync(join(dir, ".git"))) {
    git(dir, ["init", "-q"]);
  }
  // Is there a HEAD commit yet?
  let hasHead = true;
  try {
    git(dir, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    hasHead = false;
  }
  if (!hasHead) {
    git(dir, ["add", "-A"]);
    tryGit(dir, ["commit", "-q", "-m", "genesis: first self-state"]);
  }
}

/**
 * Tag the current state of "me" so it can be returned to. Git is the time
 * machine: each tag is a self-state you can roll back to if you do not like
 * who you became. Operates on the per-install store (~/.me.md).
 */
export function snapshot(storeDir: string, note?: string): string {
  ensureRepo(storeDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const tag = `self/${stamp}`;
  git(storeDir, ["add", "-A"]);
  tryGit(storeDir, ["commit", "-q", "-m", `self-state snapshot ${stamp}${note ? `: ${note}` : ""}`]);
  git(storeDir, ["tag", "-a", tag, "-m", note ?? `self-state ${stamp}`]);
  return tag;
}

export function listSelfStates(storeDir: string): string[] {
  if (!existsSync(join(storeDir, ".git"))) return [];
  const out = git(storeDir, ["tag", "--list", "self/*", "--sort=-creatordate"]);
  return out ? out.split(/\r?\n/) : [];
}

export function rollback(storeDir: string, tag: string): void {
  git(storeDir, ["checkout", tag]);
}
