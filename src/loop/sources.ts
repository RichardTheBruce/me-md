/**
 * Source / citation checker. Part of the loop gate: when an agent hands back
 * research, did it cite real, reachable, reproducible sources — or dead links
 * and things we can't verify? Extraction + classification are deterministic;
 * liveness is an optional network pass (skip it offline).
 */

export type SourceStatus = "live" | "dead" | "unverifiable" | "unchecked";

export interface SourceFinding {
  url: string;
  status: SourceStatus;
  reason?: string;
}

export interface SourceReport {
  total: number;
  live: number;
  dead: number;
  unverifiable: number;
  unchecked: number;
  findings: SourceFinding[];
  /** Reads like research but cites nothing → ungrounded. */
  grounded: boolean;
  /** No dead and no unverifiable sources. */
  ok: boolean;
  summary: string;
}

export interface SourceCheckOptions {
  /** Actually HTTP-check each URL for dead links. Off by default (no network). */
  checkLiveness?: boolean;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Max concurrent liveness checks. */
  concurrency?: number;
}

const URL_RE = /\bhttps?:\/\/[^\s<>()\[\]"'`]+/gi;

// Domains/hosts that exist as placeholders, not real evidence.
const UNVERIFIABLE_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(?:com|org|net)|test\.com|foo\.(?:com|bar)|placeholder\.|your-?site|domain\.com)/i;

// Claim markers that imply the text should be carrying citations.
const CLAIM_MARKERS =
  /\b(according to|reportedly|studies show|research (?:shows|suggests)|the data|benchmark|\d{1,3}(?:\.\d+)?\s*%|±|p\s*<\s*0|sources?\b|cited|reference)\b/i;

/** Strip trailing punctuation that commonly clings to a pasted URL. */
function trimUrl(u: string): string {
  return u.replace(/[.,;:!?)\]]+$/g, "");
}

export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    out.add(trimUrl(m[0]));
  }
  return [...out];
}

/** Classify a URL without touching the network. */
function staticClassify(url: string): SourceFinding {
  let host = "";
  try {
    host = new URL(url).host;
  } catch {
    return { url, status: "unverifiable", reason: "malformed URL" };
  }
  if (UNVERIFIABLE_HOST.test(host)) {
    return { url, status: "unverifiable", reason: `placeholder host (${host})` };
  }
  return { url, status: "unchecked" };
}

async function isLive(url: string, timeoutMs: number): Promise<SourceFinding> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res = await fetch(url, { method: "HEAD", redirect: "follow", signal: ctrl.signal });
    // Many servers reject HEAD; retry with GET before giving up.
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, { method: "GET", redirect: "follow", signal: ctrl.signal });
    }
    if (res.status >= 400) {
      return { url, status: "dead", reason: `HTTP ${res.status}` };
    }
    return { url, status: "live" };
  } catch (e) {
    return { url, status: "dead", reason: e instanceof Error ? e.message : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function checkSources(
  text: string,
  opts: SourceCheckOptions = {},
): Promise<SourceReport> {
  const urls = extractUrls(text);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const concurrency = opts.concurrency ?? 6;

  // Static pass first: catches placeholders, flags the rest as unchecked.
  let findings = urls.map(staticClassify);

  // Live pass only over the still-unchecked ones, if requested.
  if (opts.checkLiveness) {
    const toCheck = findings.filter((f) => f.status === "unchecked");
    const checked = await mapLimit(toCheck, concurrency, (f) => isLive(f.url, timeoutMs));
    const byUrl = new Map(checked.map((c) => [c.url, c]));
    findings = findings.map((f) => byUrl.get(f.url) ?? f);
  }

  const count = (s: SourceStatus): number => findings.filter((f) => f.status === s).length;
  const dead = count("dead");
  const unverifiable = count("unverifiable");
  const live = count("live");
  const unchecked = count("unchecked");

  const looksLikeResearch = CLAIM_MARKERS.test(text);
  const grounded = !looksLikeResearch || urls.length > 0;
  const ok = dead === 0 && unverifiable === 0;

  const parts: string[] = [`${urls.length} source(s)`];
  if (dead) parts.push(`${dead} dead`);
  if (unverifiable) parts.push(`${unverifiable} unverifiable`);
  if (live) parts.push(`${live} live`);
  if (unchecked) parts.push(`${unchecked} unchecked`);
  if (!grounded) parts.push("ungrounded (claims without sources)");

  return {
    total: urls.length,
    live,
    dead,
    unverifiable,
    unchecked,
    findings,
    grounded,
    ok: ok && grounded,
    summary: parts.join(", "),
  };
}
