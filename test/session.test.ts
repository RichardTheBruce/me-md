import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { buildBrainGraph } from "../src/brain/graph.js";
import { serveBrain } from "../src/brain/server.js";
import {
  extractDecisions,
  encodeSession,
  appendExchange,
  latestSessionRecap,
  recapForPrompt,
  type Turn,
} from "../src/journal/session.js";

/**
 * Run fn against a throwaway store with a guaranteed-dead engine, so the whole
 * growth loop is exercised as pure file I/O: no Ollama, deterministic, and
 * exactly the experience a brand-new install (Richard's friend) actually has.
 */
function withStore(fn: (cfg: Config) => void | Promise<void>): void | Promise<void> {
  const prev = {
    home: process.env.ME_HOME,
    tier: process.env.ME_TIER,
    engine: process.env.ME_ENGINE_BASE_URL,
  };
  const home = mkdtempSync(join(tmpdir(), "memd-session-"));
  process.env.ME_HOME = home;
  process.env.ME_TIER = "me";
  process.env.ME_ENGINE_BASE_URL = "http://127.0.0.1:1/v1"; // nothing answers here

  mkdirSync(join(home, "persona"), { recursive: true });
  mkdirSync(join(home, "memories"), { recursive: true });
  writeFileSync(join(home, "persona", "me.md"), "# me\n\nthe core.\n");

  const restore = (): void => {
    const set = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    set("ME_HOME", prev.home);
    set("ME_TIER", prev.tier);
    set("ME_ENGINE_BASE_URL", prev.engine);
    rmSync(home, { recursive: true, force: true });
  };

  let out: void | Promise<void>;
  try {
    out = fn(loadConfig(process.cwd()));
  } catch (e) {
    restore();
    throw e;
  }
  if (out instanceof Promise) return out.finally(restore);
  restore();
}

const turn = (prompt: string, answer = "ok.", at = "2026-01-01T10:00:00.000Z"): Turn => ({ at, prompt, answer });

// --- decision extraction: the thumbprint must stay conservative -------------

test("extractDecisions captures choice/preference cues and skips idle chatter", () => {
  const decisions = extractDecisions([
    turn("let's go with Postgres for the store"),
    turn("what time does the morph animation run?"),
    turn("i prefer the violet palette"),
    turn("decision: ship the chat panel friday"),
    turn("how does the bloom pass work?"),
    turn("we locked it in — gold stays the default"),
    turn("   "),
  ]);
  assert.deepEqual(decisions, [
    "let's go with Postgres for the store",
    "i prefer the violet palette",
    "decision: ship the chat panel friday",
    "we locked it in — gold stays the default",
  ]);
});

test("extractDecisions caps how many decisions one session can imprint", () => {
  const many = Array.from({ length: 20 }, (_, i) => turn(`i want feature ${i}`));
  assert.equal(extractDecisions(many).length, 12); // MAX_DECISIONS_PER_SESSION
});

// --- encode: a conversation becomes a threaded node + persona thumbprint -----

test("encodeSession writes a threaded node and folds decisions into the persona", () => {
  withStore((cfg) => {
    const first = encodeSession(
      cfg.store,
      cfg.personaPath,
      [turn("let's use a gold accent"), turn("and keep the obsidian base")],
      new Date("2026-01-01T10:00:00"),
    );
    if (!first) throw new Error("expected an encode result");
    assert.equal(first.turns, 2);
    assert.ok(existsSync(first.path));

    const md = readFileSync(first.path, "utf8");
    assert.match(md, /# session ·/);
    assert.match(md, /> from \[\[me\]\]/); // wikilink back to the persona core
    assert.match(md, /## Conversation/);
    assert.match(md, /\*\*you:\*\* let's use a gold accent/);
    assert.match(md, /## Decisions/);
    assert.match(md, /- let's use a gold accent/);

    // the thumbprint grew: decisions land in the persona's Self-State Log
    const persona = readFileSync(cfg.personaPath, "utf8");
    assert.match(persona, /\| decision \| let's use a gold accent/);

    // a later session chains back to the first via wikilink
    const second = encodeSession(cfg.store, cfg.personaPath, [turn("ship it")], new Date("2026-01-01T10:05:00"));
    if (!second) throw new Error("expected a second encode result");
    const md2 = readFileSync(second.path, "utf8");
    assert.match(md2, new RegExp(`continues \\[\\[${first.label}\\]\\]`));
  });
});

test("encodeSession returns null when there is nothing to encode", () => {
  withStore((cfg) => {
    assert.equal(encodeSession(cfg.store, cfg.personaPath, []), null);
  });
});

// --- live grow: one message = one new star in the graph ----------------------

test("appendExchange grows the net by one node with a fresh digest", () => {
  withStore((cfg) => {
    const g0 = buildBrainGraph(cfg);
    const before = g0.meta.nodes;

    const node = appendExchange(cfg.store, cfg.personaPath, turn("first thing i ever told my brain"));
    assert.equal(node.turns, 1);
    assert.ok(existsSync(node.path));
    const md = readFileSync(node.path, "utf8");
    assert.match(md, /# you asked ·/);
    assert.match(md, /\*\*you:\*\* first thing i ever told my brain/);

    const g1 = buildBrainGraph(cfg);
    assert.equal(g1.meta.nodes, before + 1);
    assert.notEqual(g1.meta.digest, g0.meta.digest); // the view will visibly change
  });
});

// --- decode: pick up the thread on the next boot -----------------------------

test("latestSessionRecap reconstructs your last line; recapForPrompt frames it", () => {
  withStore((cfg) => {
    assert.equal(latestSessionRecap(cfg.store), null); // nothing to resume yet

    encodeSession(
      cfg.store,
      cfg.personaPath,
      [turn("opening line"), turn("the very last thing i said")],
      new Date("2026-01-01T09:00:00"),
    );

    const recap = latestSessionRecap(cfg.store);
    if (!recap) throw new Error("expected a recap");
    assert.equal(recap.line, "the very last thing i said");
    assert.match(recap.label, /^2026-01-01-090000/);

    assert.equal(recapForPrompt(null), "");
    const framed = recapForPrompt(recap);
    assert.match(framed, /# Continuity/);
    assert.match(framed, /the very last thing i said/);
  });
});

// --- server: with no engine, reply honestly and grow NOTHING -----------------
// The old fallback echoed the user back and planted a node to fake growth. That
// is gone: the net only grows from real thought, so a no-engine /chat must leave
// the graph untouched and say so plainly.

test("brain server: /chat replies honestly and does NOT grow the net with no engine", async () => {
  await withStore(async (cfg) => {
    const brain = await serveBrain(cfg, { open: false });
    const nodesAt = async (): Promise<number> => {
      const body = (await (await fetch(brain.url + "graph.json")).json()) as { graph: { meta: { nodes: number } } };
      return body.graph.meta.nodes;
    };
    try {
      const state = (await (await fetch(brain.url + "state")).json()) as { engine: boolean };
      assert.equal(state.engine, false); // dead engine URL → honest "off"

      const before = await nodesAt();
      const res = await fetch(brain.url + "chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hello brain, remember this" }),
      });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { answer: string; engine: boolean };
      assert.equal(out.engine, false);
      assert.match(out.answer, /me up/i); // honest: points at the bootstrap, no fake growth
      assert.doesNotMatch(out.answer, /saved what you said/i); // the old fake-work line is gone
      assert.equal(await nodesAt(), before); // nothing thought, nothing grew

      // empty message is rejected
      const bad = await fetch(brain.url + "chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      });
      assert.equal(bad.status, 400);

      // GET /chat is not allowed
      assert.equal((await fetch(brain.url + "chat")).status, 405);
    } finally {
      await brain.close();
    }
  });
});
