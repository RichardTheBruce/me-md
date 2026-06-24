import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { LocalStore } from "../store/local.js";
import { addJournalEntry } from "./journal.js";

/**
 * Session lifecycle: the growth loop. Every conversation a user has with their
 * twin is encoded to a markdown node under <store>/memories/sessions/, which the
 * brain graph already walks (collectFromDisk). So the neural net literally grows
 * a star every time the human uses it, and chains sessions with wikilinks so the
 * history shows up as a thread. Decisions get distilled into the persona core's
 * Self-State Log: the user's accumulating "thumbprint" of how they choose.
 *
 * No engine required: encoding is pure file I/O, so a brand-new install with no
 * Ollama still grows its net from raw usage.
 */

export interface Turn {
  /** ISO timestamp of when the exchange happened. */
  at: string;
  /** What the human said. */
  prompt: string;
  /** What the twin answered (may be a graceful "no engine" note). */
  answer: string;
  /** Model that produced the answer, if any. */
  model?: string;
  /** Route kind (reason/agent/…), if any. */
  kind?: string;
}

export interface EncodeResult {
  /** Absolute path of the session node written. */
  path: string;
  /** Short label (basename without extension): the node's name in the graph. */
  label: string;
  /** How many turns were captured. */
  turns: number;
  /** Decisions appended to the persona thumbprint this session. */
  decisions: string[];
}

export interface Recap {
  /** Short label of the most recent session node. */
  label: string;
  /** One-line reconstruction of where the last session left off. */
  line: string;
  /** ISO timestamp parsed from the file, for display. */
  at: string;
}

const SESSIONS_SUBDIR = "sessions";
const MAX_DECISION_CHARS = 240;
const MAX_DECISIONS_PER_SESSION = 12;

/** Local-time stamp safe for filenames: YYYY-MM-DD-HHmmss. */
function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Human-readable local time: YYYY-MM-DD HH:mm. */
function human(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Where session nodes live. Created on demand. */
function sessionsDir(store: LocalStore): string {
  return join(store.memoriesDir, SESSIONS_SUBDIR);
}

/** The persona's display label, for the [[wikilink]] back to "me". */
function personaLabel(store: LocalStore): string {
  return basename(store.personaPath).replace(/\.md$/i, "");
}

/** Most recent existing session node's label, so a new node can chain to it. */
function previousSessionLabel(store: LocalStore): string | undefined {
  const files = listSessionFiles(store);
  const last = files[files.length - 1];
  return last ? last.replace(/\.md$/i, "") : undefined;
}

/** Session node filenames (sorted oldest→newest by name, which is time-ordered). */
function listSessionFiles(store: LocalStore): string[] {
  const dir = sessionsDir(store);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}

/** Squash to a single trimmed line; the graph and recaps want compact text. */
function oneLine(s: string, max = 160): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/**
 * Conservative decision detector. We only surface a turn as a "decision" when the
 * human's own words carry a clear choice/preference signal. Better to miss a few
 * than to pollute the thumbprint with every passing question. The full transcript
 * still captures everything regardless.
 */
export function extractDecisions(turns: Turn[]): string[] {
  const cue =
    /\b(?:let'?s|we(?:'ll| will| want| need)?|i(?:'ll| will)?)\s+(?:go with|use|pick|choose|build|make|lock|ship|keep)\b|\bi (?:want|prefer|like|choose|decided|insist)\b|\bmy (?:preference|choice|call)\b|\bdecision\s*:|\block(?:ed)? (?:in|it)\b/i;
  const out: string[] = [];
  for (const t of turns) {
    const text = (t.prompt || "").trim();
    if (!text) continue;
    if (cue.test(text)) {
      out.push(oneLine(text, MAX_DECISION_CHARS));
      if (out.length >= MAX_DECISIONS_PER_SESSION) break;
    }
  }
  return out;
}

/** Render one exchange as readable markdown. */
function renderTurn(t: Turn): string {
  return `**you:** ${t.prompt.trim()}\n\n**me:** ${t.answer.trim()}\n`;
}

/**
 * Write a single conversation as a session node and fold its decisions into the
 * persona thumbprint. Returns null when there is nothing to encode (no turns).
 */
export function encodeSession(
  store: LocalStore,
  personaPath: string,
  turns: Turn[],
  now: Date = new Date(),
): EncodeResult | null {
  if (turns.length === 0) return null;
  const dir = sessionsDir(store);
  mkdirSync(dir, { recursive: true });

  const label = stamp(now);
  const prev = previousSessionLabel(store);
  const decisions = extractDecisions(turns);

  const header = [
    `# session · ${human(now)}`,
    "",
    `> from [[${personaLabel(store)}]]${prev ? ` · continues [[${prev}]]` : ""}`,
    "",
    "## Conversation",
    "",
  ].join("\n");

  const body = turns.map(renderTurn).join("\n---\n\n");

  const decisionBlock =
    decisions.length > 0 ? "\n## Decisions\n\n" + decisions.map((d) => `- ${d}`).join("\n") + "\n" : "";

  const path = join(dir, `${label}.md`);
  writeFileSync(path, header + body + decisionBlock, "utf8");

  // The thumbprint: each decision becomes part of "me" on the next persona load.
  for (const d of decisions) addJournalEntry(personaPath, d, "decision");

  return { path, label, turns: turns.length, decisions };
}

/**
 * Append a single exchange as its own node, used by the in-brain chat panel so
 * the net grows a fresh star with every message. Chains to the previous node so
 * the conversation forms a visible thread. Returns the node label.
 */
export function appendExchange(
  store: LocalStore,
  personaPath: string,
  turn: Turn,
  now: Date = new Date(),
): EncodeResult {
  const dir = sessionsDir(store);
  mkdirSync(dir, { recursive: true });

  // A short suffix keeps multiple exchanges within the same second distinct.
  const suffix = Math.random().toString(36).slice(2, 6);
  const label = `${stamp(now)}-${suffix}`;
  const prev = previousSessionLabel(store);

  const md =
    [
      `# you asked · ${human(now)}`,
      "",
      `> from [[${personaLabel(store)}]]${prev ? ` · after [[${prev}]]` : ""}`,
      "",
      renderTurn(turn),
    ].join("\n") + "\n";

  const path = join(dir, `${label}.md`);
  writeFileSync(path, md, "utf8");

  const decisions = extractDecisions([turn]);
  for (const d of decisions) addJournalEntry(personaPath, d, "decision");

  return { path, label, turns: 1, decisions };
}

/**
 * Read the most recent session node and reconstruct a one-line recap, so boot
 * can say "picking up from…". Null when there is no prior session.
 */
export function latestSessionRecap(store: LocalStore): Recap | null {
  const files = listSessionFiles(store);
  const last = files[files.length - 1];
  if (!last) return null;
  const path = join(sessionsDir(store), last);
  let text = "";
  let at = "";
  try {
    text = readFileSync(path, "utf8");
    at = statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
  // Prefer the last thing the human said; fall back to the first.
  const prompts = [...text.matchAll(/^\*\*you:\*\*\s*(.+)$/gim)].map((m) => (m[1] ?? "").trim());
  const last_prompt = prompts[prompts.length - 1] ?? prompts[0] ?? "";
  return {
    label: last.replace(/\.md$/i, ""),
    line: last_prompt ? oneLine(last_prompt) : "an earlier conversation",
    at,
  };
}

/** Compose a short continuity note to prepend to the system prompt on decode. */
export function recapForPrompt(recap: Recap | null): string {
  if (!recap) return "";
  return (
    `# Continuity\nYou are resuming. Last session (${recap.label}) ended on: ` +
    `"${recap.line}". Carry that thread forward naturally if it is relevant.`
  );
}
