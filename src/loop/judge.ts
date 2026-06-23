import type { EngineClient } from "../engine/client.js";

/**
 * The judge. Scores an agent's output against a rubric and returns a verdict,
 * Prometheus-2 style (absolute 1-5 grading with written feedback). Model-backed;
 * if no judge model is served, it degrades to "unavailable" and the loop falls
 * back on the sentinel + source checks rather than blocking forever.
 */

export type JudgeVerdict = "SHIP" | "ITERATE" | "REJECT";

export interface JudgeResult {
  verdict: JudgeVerdict;
  /** 1-5 Prometheus score (0 when unavailable). */
  score: number;
  critique: string;
  model: string;
  unavailable: boolean;
}

export interface JudgeOptions {
  engine?: EngineClient;
  model?: string;
  /** Override the scoring rubric. */
  rubric?: string;
  /** Minimum score that counts as SHIP (default 4). */
  shipScore?: number;
  onStep?: (msg: string) => void;
}

export const DEFAULT_RUBRIC = `Score the response from 1 to 5 on overall quality as a deliverable:
1 - wrong, fabricated, or unusable.
2 - major gaps or inaccuracies; would mislead.
3 - roughly right but incomplete, thinly grounded, or unclear.
4 - accurate, complete, and clear with only minor issues.
5 - accurate, complete, well-grounded in verifiable sources, and directly actionable.
Penalize fabricated facts, claims without sources, dead/placeholder citations, and vagueness.`;

function buildPrompt(task: string, output: string, rubric: string): string {
  return (
    `###Task / instruction the response was meant to satisfy:\n${task}\n\n` +
    `###Response to evaluate:\n${output}\n\n` +
    `###Score rubric:\n${rubric}\n\n` +
    "Give concise feedback (2-4 sentences) on what is strong and what must improve, " +
    "then on a final line output exactly: [RESULT] X  (where X is an integer 1-5)."
  );
}

const JUDGE_SYSTEM =
  "You are a strict, fair evaluator. You grade a response against a rubric and " +
  "return written feedback plus a single integer score. You never inflate scores.";

/** Pull the 1-5 score out of the judge's text. Tolerant of several formats. */
export function parseScore(text: string): number | null {
  const tagged = text.match(/\[RESULT\]\s*([1-5])/i);
  if (tagged) return Number(tagged[1]);
  const labeled = text.match(/\b(?:score|rating)\s*[:=]?\s*([1-5])\b/i);
  if (labeled) return Number(labeled[1]);
  const outOf = text.match(/\b([1-5])\s*\/\s*5\b/);
  if (outOf) return Number(outOf[1]);
  return null;
}

function verdictFor(score: number, shipScore: number): JudgeVerdict {
  if (score >= shipScore) return "SHIP";
  if (score >= 3) return "ITERATE";
  return "REJECT";
}

export async function judgeOutput(
  task: string,
  output: string,
  opts: JudgeOptions = {},
): Promise<JudgeResult> {
  const shipScore = opts.shipScore ?? 4;
  const model = opts.model;
  const log = opts.onStep ?? (() => {});

  if (!opts.engine || !model) {
    return {
      verdict: "SHIP",
      score: 0,
      critique: "judge model not configured; skipped scoring",
      model: model ?? "(none)",
      unavailable: true,
    };
  }

  log(`judge: ${model}`);
  try {
    const res = await opts.engine.chat({
      model,
      messages: [
        { role: "system", content: JUDGE_SYSTEM },
        { role: "user", content: buildPrompt(task, output, opts.rubric ?? DEFAULT_RUBRIC) },
      ],
      temperature: 0,
    });
    const text = res.content.trim();
    const score = parseScore(text);
    if (score === null) {
      // Couldn't parse a score: don't block the loop on a malformed judge reply.
      return {
        verdict: "SHIP",
        score: 0,
        critique: `judge returned no parseable score: ${text.slice(0, 200)}`,
        model,
        unavailable: true,
      };
    }
    return { verdict: verdictFor(score, shipScore), score, critique: text, model, unavailable: false };
  } catch (e) {
    return {
      verdict: "SHIP",
      score: 0,
      critique: `judge unavailable: ${e instanceof Error ? e.message : String(e)}`,
      model,
      unavailable: true,
    };
  }
}
