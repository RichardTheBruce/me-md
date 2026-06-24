import type { EngineClient } from "../engine/client.js";
import { scanContent, type ContentScan } from "../security/sentinel.js";
import { judgeOutput, type JudgeResult } from "./judge.js";
import { checkSources, type SourceReport } from "./sources.js";

/**
 * The loop gate. For every agent output it runs three checks:
 *   1. security:  scan the output for leaked secrets / injection (block-critical)
 *   2. judge:     score against a rubric (SHIP / ITERATE / REJECT)
 *   3. sources:   extract citations, flag dead / unverifiable / ungrounded
 * Then the loop controller re-runs the agent with the aggregated critique until
 * everything passes or it hits the pass cap (default 5).
 */

export type GateStatus = "pass" | "iterate" | "reject";

export interface GateConfig {
  engine?: EngineClient;
  judgeModel?: string;
  rubric?: string;
  shipScore?: number;
  /** HTTP-check every source for dead links (needs network). */
  checkLiveness?: boolean;
  /** Fail the gate when research-like output cites nothing. Default true. */
  requireSources?: boolean;
  onStep?: (msg: string) => void;
}

export interface GateReport {
  status: GateStatus;
  security: ContentScan;
  judge: JudgeResult;
  sources: SourceReport;
  reasons: string[];
  /** Aggregated, actionable feedback fed back to the agent on failure. */
  critique: string;
}

export async function runGate(
  instruction: string,
  output: string,
  cfg: GateConfig = {},
): Promise<GateReport> {
  const requireSources = cfg.requireSources ?? true;

  const security = scanContent(output);
  const sources = await checkSources(output, { checkLiveness: cfg.checkLiveness });
  const judge = await judgeOutput(instruction, output, {
    engine: cfg.engine,
    model: cfg.judgeModel,
    rubric: cfg.rubric,
    shipScore: cfg.shipScore,
    onStep: cfg.onStep,
  });

  const reasons: string[] = [];
  const critiqueParts: string[] = [];
  let status: GateStatus = "pass";

  // security: a leaked credential is an immediate reject.
  if (security.verdict === "block") {
    status = "reject";
    reasons.push(`security: ${security.reasons.join("; ")}`);
    critiqueParts.push(
      `SECURITY: the output contains ${security.reasons.join(" and ")}. Remove it entirely and never include live credentials.`,
    );
  } else if (security.verdict === "flag") {
    reasons.push(`security: ${security.reasons.join("; ")}`);
    critiqueParts.push(`SECURITY: ${security.reasons.join("; ")}. Remove or neutralize it.`);
    if (status === "pass") status = "iterate";
  }

  // judge
  if (!judge.unavailable) {
    if (judge.verdict === "REJECT") {
      status = "reject";
      reasons.push(`judge REJECT (score ${judge.score}/5)`);
      critiqueParts.push(`JUDGE (${judge.score}/5): ${judge.critique}`);
    } else if (judge.verdict === "ITERATE") {
      if (status !== "reject") status = "iterate";
      reasons.push(`judge ITERATE (score ${judge.score}/5)`);
      critiqueParts.push(`JUDGE (${judge.score}/5): ${judge.critique}`);
    } else {
      reasons.push(`judge SHIP (score ${judge.score}/5)`);
    }
  } else {
    reasons.push("judge skipped (no model)");
  }

  // sources
  const sourceProblems: string[] = [];
  if (sources.dead > 0) sourceProblems.push(`${sources.dead} dead link(s)`);
  if (sources.unverifiable > 0) sourceProblems.push(`${sources.unverifiable} unverifiable source(s)`);
  if (requireSources && !sources.grounded) sourceProblems.push("claims with no sources");
  if (sourceProblems.length > 0) {
    if (status !== "reject") status = "iterate";
    reasons.push(`sources: ${sourceProblems.join(", ")}`);
    const dead = sources.findings.filter((f) => f.status === "dead").map((f) => f.url);
    const bad = sources.findings.filter((f) => f.status === "unverifiable").map((f) => f.url);
    const detail: string[] = [];
    if (dead.length) detail.push(`replace dead links: ${dead.join(", ")}`);
    if (bad.length) detail.push(`replace unverifiable sources: ${bad.join(", ")}`);
    if (requireSources && !sources.grounded) detail.push("add real, verifiable citations for the claims");
    critiqueParts.push(`SOURCES: ${detail.join("; ")}.`);
  } else {
    reasons.push(`sources ok (${sources.summary})`);
  }

  return {
    status,
    security,
    judge,
    sources,
    reasons,
    critique: critiqueParts.join("\n"),
  };
}

// --- the loop --------------------------------------------------------------

export interface AgentTask {
  name: string;
  /** The instruction the output is graded against. */
  instruction: string;
  /** Produce output given the prior critique (null on the first pass). */
  run: (critique: string | null, pass: number) => Promise<string>;
}

export interface LoopOptions extends GateConfig {
  /** Maximum passes before giving up. Default 5. */
  maxPasses?: number;
}

export interface LoopPass {
  pass: number;
  output: string;
  report: GateReport;
}

export interface LoopResult {
  name: string;
  output: string;
  passed: boolean;
  status: GateStatus;
  passes: number;
  history: LoopPass[];
}

/**
 * Run one agent task through the gate, re-running with feedback until it passes
 * or the pass cap is hit. The output that ships is the last one produced.
 */
export async function verifyLoop(task: AgentTask, opts: LoopOptions = {}): Promise<LoopResult> {
  const maxPasses = Math.max(1, opts.maxPasses ?? 5);
  const log = opts.onStep ?? (() => {});
  const history: LoopPass[] = [];
  let critique: string | null = null;
  let lastOutput = "";
  let lastStatus: GateStatus = "reject";

  for (let pass = 1; pass <= maxPasses; pass++) {
    log(`[${task.name}] pass ${pass}/${maxPasses}${critique ? " (with critique)" : ""}`);
    const output = await task.run(critique, pass);
    lastOutput = output;
    const report = await runGate(task.instruction, output, opts);
    history.push({ pass, output, report });
    lastStatus = report.status;
    log(`[${task.name}] pass ${pass}: ${report.status}. ${report.reasons.join(" | ")}`);

    if (report.status === "pass") {
      return { name: task.name, output, passed: true, status: "pass", passes: pass, history };
    }
    critique = report.critique;
  }

  return {
    name: task.name,
    output: lastOutput,
    passed: false,
    status: lastStatus,
    passes: maxPasses,
    history,
  };
}
