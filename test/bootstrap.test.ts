import { test } from "node:test";
import assert from "node:assert/strict";
import type { Config, ModelConfig } from "../src/config.js";
import type { HardwareProbe } from "../src/core/detect.js";
import {
  bootstrapEngine,
  planModels,
  isTurnkey,
  type BootstrapDeps,
  type EngineProbe,
} from "../src/engine/bootstrap.js";
import { ABLITERATED_LADDER, EMBED_MODEL, FLOOR_FALLBACK } from "../src/engine/lineup.js";

// --- minimal config + fakes --------------------------------------------------
// bootstrap reads only cfg.engine.baseUrl, cfg.models, and cfg.tierInfo.source,
// so a light cast keeps the unit tests focused. Every side effect is injected,
// so nothing here installs Ollama, pulls weights, or touches the network.

const MODEL_ENV = ["ME_MODEL_AGENT", "ME_MODEL_REASONER", "ME_MODEL_FAST", "ME_MODEL_CODER"] as const;

function makeCfg(opts: {
  baseUrl?: string;
  source?: "auto" | "override" | "saved";
  models?: Partial<ModelConfig>;
}): Config {
  const models: ModelConfig = {
    reasoner: "R",
    agent: "A",
    fast: "F",
    coder: "C",
    embed: EMBED_MODEL.tag,
    securityDeep: "foundation-sec-8b-reasoning",
    judge: "prometheus-eval:7b-v2",
    ...opts.models,
  };
  return {
    engine: { baseUrl: opts.baseUrl ?? "http://localhost:11434/v1", apiKey: "ollama" },
    models,
    tierInfo: { source: opts.source ?? "auto" },
  } as unknown as Config;
}

function probeOf(ramGb: number, vramGb = 0): () => HardwareProbe {
  return () => ({ ramGb, vramGb, gpu: vramGb > 0 ? "nvidia" : "none" });
}

interface FakeEngine {
  engine: EngineProbe;
  calls: { health: number; list: number };
}
function fakeEngine(health: boolean[], models: string[][]): FakeEngine {
  let hi = 0;
  let li = 0;
  const calls = { health: 0, list: 0 };
  const engine: EngineProbe = {
    async health() {
      calls.health++;
      const v = health[Math.min(hi, health.length - 1)] ?? false;
      hi++;
      return v;
    },
    async listModels() {
      calls.list++;
      const v = models[Math.min(li, models.length - 1)] ?? [];
      li++;
      return v;
    },
    async chat() {
      return { content: "", toolCalls: [], model: "x", raw: {} };
    },
  };
  return { engine, calls };
}

/** Default the noisy, slow, OS-touching seams to inert fakes; override per test. */
function deps(over: Partial<BootstrapDeps>): Partial<BootstrapDeps> {
  return {
    log: () => {},
    probe: probeOf(16),
    resolveBin: () => "ollama",
    install: async () => false,
    serve: () => {},
    pull: async () => true,
    autoInstall: false,
    serveTimeoutMs: 50,
    pollIntervalMs: 5,
    ...over,
  };
}

/** Run fn with the four ME_MODEL_* overrides cleared, then restore. */
function withNoModelEnv(fn: () => void | Promise<void>): void | Promise<void> {
  const prev = MODEL_ENV.map((k) => [k, process.env[k]] as const);
  for (const k of MODEL_ENV) delete process.env[k];
  const restore = (): void => {
    for (const [k, v] of prev) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return out;
}

// --- isTurnkey: collapse to one model only when nothing was pinned -----------

test("isTurnkey: auto + no model env -> true", () => {
  withNoModelEnv(() => {
    assert.equal(isTurnkey(makeCfg({ source: "auto" })), true);
  });
});

test("isTurnkey: a pinned tier (override/saved) -> false", () => {
  withNoModelEnv(() => {
    assert.equal(isTurnkey(makeCfg({ source: "override" })), false);
    assert.equal(isTurnkey(makeCfg({ source: "saved" })), false);
  });
});

test("isTurnkey: an explicit ME_MODEL_* override -> false even on auto", () => {
  withNoModelEnv(() => {
    process.env.ME_MODEL_AGENT = "some/pinned-model";
    assert.equal(isTurnkey(makeCfg({ source: "auto" })), false);
  });
});

// --- planModels: pure model planning -----------------------------------------

test("planModels turnkey collapses to one hardware-sized model + embedder", () => {
  const cfg = makeCfg({});
  const plan = planModels(cfg, { ramGb: 16, vramGb: 0, gpu: "none" }, true);
  assert.equal(plan.turnkey, true);
  assert.equal(plan.primary, ABLITERATED_LADDER.low.tag); // 16 GB -> 8B
  assert.deepEqual(plan.targets, [ABLITERATED_LADDER.low.tag, EMBED_MODEL.tag]);
  assert.equal(plan.belowFloor, false);
});

test("planModels turnkey drops to the last-resort tag on a thin host", () => {
  const cfg = makeCfg({});
  const plan = planModels(cfg, { ramGb: 4, vramGb: 0, gpu: "none" }, true);
  assert.equal(plan.belowFloor, true);
  assert.equal(plan.primary, FLOOR_FALLBACK.tag);
  assert.deepEqual(plan.targets, [FLOOR_FALLBACK.tag, EMBED_MODEL.tag]);
});

test("planModels pinned keeps the full distinct tier lineup", () => {
  const cfg = makeCfg({
    source: "override",
    models: { reasoner: "R", agent: "A", fast: "F", coder: "C", embed: "E" },
  });
  const plan = planModels(cfg, { ramGb: 999, vramGb: 0, gpu: "none" }, false);
  assert.equal(plan.turnkey, false);
  assert.equal(plan.primary, "A"); // agent is the primary lane
  assert.deepEqual(plan.targets, ["R", "A", "F", "C", "E"]);
});

test("planModels dedups when several lanes share a tag", () => {
  const cfg = makeCfg({
    source: "override",
    models: { reasoner: "X", agent: "X", fast: "X", coder: "X", embed: EMBED_MODEL.tag },
  });
  const plan = planModels(cfg, { ramGb: 999, vramGb: 0, gpu: "none" }, false);
  assert.deepEqual(plan.targets, ["X", EMBED_MODEL.tag]);
});

// --- bootstrapEngine: hosted path --------------------------------------------

test("bootstrap hosted: a reachable remote engine is used, nothing installed", async () => {
  const { engine } = fakeEngine([true], [[]]);
  let installed = false;
  const res = await bootstrapEngine(
    makeCfg({ baseUrl: "https://twin.example.com/v1" }),
    deps({ engine, install: async () => ((installed = true), true) }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.mode, "hosted");
  assert.equal(res.primaryModel, undefined);
  assert.equal(installed, false);
});

test("bootstrap hosted: an unreachable remote engine fails honestly", async () => {
  const { engine } = fakeEngine([false], [[]]);
  const res = await bootstrapEngine(
    makeCfg({ baseUrl: "https://twin.example.com/v1" }),
    deps({ engine }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.mode, "hosted");
  assert.match(res.detail, /unreachable/i);
});

// --- bootstrapEngine: local install gate -------------------------------------

test("bootstrap local: missing ollama with auto-install off fails honestly", async () => {
  const { engine } = fakeEngine([false], [[]]);
  const res = await bootstrapEngine(
    makeCfg({}),
    deps({ engine, resolveBin: () => null, autoInstall: false }),
  );
  assert.equal(res.ok, false);
  assert.equal(res.mode, "local");
  assert.match(res.detail, /auto-install is off/i);
});

test("bootstrap local: missing ollama is silently installed when allowed", async () => {
  await withNoModelEnv(async () => {
    const { engine } = fakeEngine([true], [[ABLITERATED_LADDER.low.tag, EMBED_MODEL.tag]]);
    let installed = false;
    let resolved = false; // binary appears only after install
    const res = await bootstrapEngine(
      makeCfg({ source: "auto" }),
      deps({
        engine,
        autoInstall: true,
        resolveBin: () => (resolved ? "ollama" : null),
        install: async () => {
          installed = true;
          resolved = true;
          return true;
        },
      }),
    );
    assert.equal(installed, true);
    assert.equal(res.ok, true);
    assert.equal(res.mode, "local");
  });
});

test("bootstrap local: a failed silent install fails honestly", async () => {
  const { engine } = fakeEngine([false], [[]]);
  const res = await bootstrapEngine(
    makeCfg({}),
    deps({ engine, autoInstall: true, resolveBin: () => null, install: async () => false }),
  );
  assert.equal(res.ok, false);
  assert.match(res.detail, /could not set up the local engine/i);
});

// --- bootstrapEngine: serve + pull mechanics ---------------------------------

test("bootstrap local: starts serve and waits for the daemon to answer", async () => {
  await withNoModelEnv(async () => {
    const { engine, calls } = fakeEngine(
      [false, true], // down, then up after serve
      [[], [ABLITERATED_LADDER.low.tag, EMBED_MODEL.tag]],
    );
    let served = 0;
    const res = await bootstrapEngine(
      makeCfg({ source: "auto" }),
      deps({ engine, serve: () => void served++ }),
    );
    assert.equal(served, 1);
    assert.ok(calls.health >= 2);
    assert.equal(res.ok, true);
    assert.equal(res.primaryModel, ABLITERATED_LADDER.low.tag);
  });
});

test("bootstrap local: a daemon that never answers times out honestly", async () => {
  const { engine } = fakeEngine([false], [[]]); // never healthy
  const res = await bootstrapEngine(
    makeCfg({}),
    deps({ engine, serve: () => {}, serveTimeoutMs: 20, pollIntervalMs: 5 }),
  );
  assert.equal(res.ok, false);
  assert.match(res.detail, /never answered/i);
});

test("bootstrap turnkey: pulls the sized model + embedder and routes to it", async () => {
  await withNoModelEnv(async () => {
    const { engine } = fakeEngine(
      [true], // already up
      [[], [ABLITERATED_LADDER.low.tag, EMBED_MODEL.tag]], // empty, then present after pull
    );
    const pulled: string[] = [];
    const res = await bootstrapEngine(
      makeCfg({ source: "auto" }),
      deps({ engine, probe: probeOf(16), pull: async (_b, tag) => (pulled.push(tag), true) }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.primaryModel, ABLITERATED_LADDER.low.tag);
    assert.deepEqual(pulled, [ABLITERATED_LADDER.low.tag, EMBED_MODEL.tag]);
  });
});

test("bootstrap turnkey: a thin host gets the last-resort tag, flagged belowFloor", async () => {
  await withNoModelEnv(async () => {
    const { engine } = fakeEngine([true], [[], [FLOOR_FALLBACK.tag, EMBED_MODEL.tag]]);
    const res = await bootstrapEngine(
      makeCfg({ source: "auto" }),
      deps({ engine, probe: probeOf(4), pull: async () => true }),
    );
    assert.equal(res.ok, true);
    assert.equal(res.primaryModel, FLOOR_FALLBACK.tag);
    assert.equal(res.belowFloor, true);
  });
});

test("bootstrap: a failed pull fails honestly", async () => {
  await withNoModelEnv(async () => {
    const { engine } = fakeEngine([true], [[]]);
    const res = await bootstrapEngine(
      makeCfg({ source: "auto" }),
      deps({ engine, probe: probeOf(16), pull: async () => false }),
    );
    assert.equal(res.ok, false);
    assert.match(res.detail, /failed to pull/i);
  });
});

test("bootstrap pinned: pulls the full lineup, no single-model collapse", async () => {
  const { engine } = fakeEngine(
    [true],
    [[], ["R", "A", "F", "C", "E"]], // empty, then full lineup present
  );
  const pulled: string[] = [];
  const res = await bootstrapEngine(
    makeCfg({ source: "override", models: { reasoner: "R", agent: "A", fast: "F", coder: "C", embed: "E" } }),
    deps({ engine, pull: async (_b, tag) => (pulled.push(tag), true) }),
  );
  assert.equal(res.ok, true);
  assert.equal(res.primaryModel, undefined); // pinned: the tier lineup stands
  assert.deepEqual(pulled.sort(), ["A", "C", "E", "F", "R"]);
});

test("bootstrap: already-warm engine with models present does no work", async () => {
  await withNoModelEnv(async () => {
    const { engine } = fakeEngine([true], [[ABLITERATED_LADDER.low.tag, EMBED_MODEL.tag]]);
    let served = 0;
    let pulls = 0;
    const res = await bootstrapEngine(
      makeCfg({ source: "auto" }),
      deps({
        engine,
        probe: probeOf(16),
        serve: () => void served++,
        pull: async () => (pulls++, true),
      }),
    );
    assert.equal(res.ok, true);
    assert.equal(served, 0);
    assert.equal(pulls, 0);
  });
});
