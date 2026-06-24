/**
 * Proves the pinned uncensored lineup is actually pullable. me.md ships no
 * weights: it pulls abliterated models from the Ollama registry on first boot.
 * If a pinned tag ever 404s upstream (a publisher renames or deletes it), the
 * turnkey install breaks silently. test/lineup.test.ts guards the tag STRINGS;
 * this script guards that those strings still RESOLVE.
 *
 * It reads src/engine/lineup.ts as the single source of truth and hits the same
 * manifest endpoint `ollama pull` resolves first, so it verifies pullability
 * while downloading only KB of manifest JSON, never the weights.
 *
 *   npm run verify:weights      (run before publish, or after editing the ladder)
 *
 * Exit code is non-zero if any pinned tag fails to resolve, so it can gate CI.
 */
import {
  ABLITERATED_LADDER,
  EMBED_MODEL,
  FLOOR_FALLBACK,
} from "../src/engine/lineup.js";

// What `ollama pull` sends; the registry keys manifests by this media type.
const ACCEPT = "application/vnd.docker.distribution.manifest.v2+json";
const REGISTRY = "https://registry.ollama.ai/v2";

interface Pin {
  label: string;
  tag: string;
}

const PINS: Pin[] = [
  { label: "FLOOR_FALLBACK", tag: FLOOR_FALLBACK.tag },
  { label: "floor", tag: ABLITERATED_LADDER.floor.tag },
  { label: "low", tag: ABLITERATED_LADDER.low.tag },
  { label: "mid", tag: ABLITERATED_LADDER.mid.tag },
  { label: "high", tag: ABLITERATED_LADDER.high.tag },
  { label: "embed", tag: EMBED_MODEL.tag },
];

/**
 * Turn an Ollama pull tag into its registry manifest URL.
 *   "huihui_ai/qwen2.5-abliterate:3b" -> .../v2/huihui_ai/qwen2.5-abliterate/manifests/3b
 *   "nomic-embed-text"                -> .../v2/library/nomic-embed-text/manifests/latest
 */
function manifestUrl(tag: string): string {
  const slash = tag.lastIndexOf("/");
  const colon = tag.lastIndexOf(":");
  let name = tag;
  let version = "latest";
  // A colon only marks a version when it comes after the last path slash.
  if (colon > slash) {
    name = tag.slice(0, colon);
    version = tag.slice(colon + 1);
  }
  const repo = name.includes("/") ? name : `library/${name}`;
  return `${REGISTRY}/${repo}/manifests/${version}`;
}

async function statusOf(url: string): Promise<{ status: number; note: string }> {
  try {
    const res = await fetch(url, { method: "GET", headers: { Accept: ACCEPT } });
    // Drain the (tiny) body so the connection is released promptly.
    await res.arrayBuffer().catch(() => undefined);
    return { status: res.status, note: "" };
  } catch (err) {
    return { status: 0, note: err instanceof Error ? err.message : String(err) };
  }
}

let failed = 0;
for (const pin of PINS) {
  const { status, note } = await statusOf(manifestUrl(pin.tag));
  const ok = status === 200;
  if (!ok) failed++;
  const mark = ok ? "ok  " : "MISS";
  const code = String(status).padEnd(3);
  const label = pin.label.padEnd(14);
  const tail = note ? `  (${note})` : "";
  console.log(`${mark}  ${code}  ${label}  ${pin.tag}${tail}`);
}

if (failed > 0) {
  console.error(
    `\n${failed} pinned tag(s) no longer resolve on the Ollama registry. ` +
      `The pins in src/engine/lineup.ts are stale: find the live tag on ` +
      `ollama.com (huihui_ai / mannix namespaces) and update the ladder plus ` +
      `test/lineup.test.ts.`,
  );
  process.exit(1);
}

console.log(`\nall ${PINS.length} pinned abliterated tags resolve on registry.ollama.ai`);
