import { verifyLoop, type AgentTask, type LoopOptions, type LoopResult } from "./verify.js";

/**
 * Batch stage of the loop. The locked flow starts by *batch-executing*
 * a set of agents, then gating each output independently and re-running the
 * failures with their own critique. This runs that batch with a concurrency
 * cap so a wide fan-out doesn't open one connection per agent at once.
 */

export interface BatchOptions extends LoopOptions {
  /** Max agent loops running at once. Default 3. */
  concurrency?: number;
  /** Fired as each task settles, for progress reporting. */
  onResult?: (result: LoopResult) => void;
}

export interface BatchReport {
  results: LoopResult[];
  total: number;
  passed: number;
  failed: number;
  allPassed: boolean;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const idx = next++;
      out[idx] = await fn(items[idx] as T, idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Run every task through {@link verifyLoop}, capped at `concurrency` at a time.
 * Results come back in the same order as `tasks`, regardless of finish order.
 */
export async function verifyBatch(tasks: AgentTask[], opts: BatchOptions = {}): Promise<BatchReport> {
  const concurrency = opts.concurrency ?? 3;
  const log = opts.onStep ?? (() => {});
  log(`batch: ${tasks.length} task(s), concurrency ${concurrency}`);

  const results = await mapLimit(tasks, concurrency, async (task) => {
    const result = await verifyLoop(task, opts);
    opts.onResult?.(result);
    return result;
  });

  const passed = results.filter((r) => r.passed).length;
  return {
    results,
    total: results.length,
    passed,
    failed: results.length - passed,
    allPassed: passed === results.length,
  };
}
