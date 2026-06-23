import type { ModelEntry } from "./engine/registry.js";
import type { TaskKind } from "./types.js";

const CODE_HINTS: RegExp[] = [
  /```/,
  /\b(function|const|class|import|async|=>|def)\b/,
  /\b(typescript|python|rust|sql|javascript|tsx?|golang)\b/i,
  /\b(refactor|stack trace|compile|stacktrace|error:|exception)\b/i,
];

const DEEP_HINTS = /\b(why|how|should|design|plan|tradeoff|trade-off|decide|strategy|architect)\b/i;

// Action / execution verbs that imply driving the MCP hands through real steps.
const AGENT_HINTS =
  /\b(run|execute|do (this|it|that)|freeze|unfreeze|send|transfer|pay|refund|create|open|deploy|schedule|commit|push|merge|file (an? )?(issue|pr|ticket)|query|fetch|look up|search (my|the)|pull up|update|delete|cancel|book|email|message|notify|trigger|provision|attach)\b/i;

/** Heuristic task classifier. Deterministic and explainable on purpose. */
export function classify(prompt: string): TaskKind {
  if (CODE_HINTS.some((re) => re.test(prompt))) return "code";
  if (AGENT_HINTS.test(prompt)) return "agent";
  const words = prompt.trim().split(/\s+/).length;
  if (words <= 12 && !DEEP_HINTS.test(prompt)) return "fast";
  return "reason";
}

export interface RouteDecision {
  kind: TaskKind;
  model: string;
  reason: string;
}

export function route(
  prompt: string,
  registry: Record<TaskKind, ModelEntry>,
  override?: TaskKind,
): RouteDecision {
  const kind = override ?? classify(prompt);
  const entry = registry[kind];
  return { kind, model: entry.name, reason: entry.description };
}
