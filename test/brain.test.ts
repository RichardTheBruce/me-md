import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { buildBrainGraph } from "../src/brain/graph.js";
import { serveBrain } from "../src/brain/server.js";

/**
 * Run fn with ME_HOME pointed at a throwaway store seeded with a small linked
 * vault, so the brain builds from a real (tiny) world without any engine.
 */
function withWorld(fn: (home: string) => void | Promise<void>): void | Promise<void> {
  const prevHome = process.env.ME_HOME;
  const prevTier = process.env.ME_TIER;
  const home = mkdtempSync(join(tmpdir(), "memd-brain-"));
  process.env.ME_HOME = home;
  process.env.ME_TIER = "me";

  // store skeleton
  mkdirSync(join(home, "persona"), { recursive: true });
  mkdirSync(join(home, "memories"), { recursive: true });
  const vault = join(home, "vault");
  mkdirSync(vault, { recursive: true });

  // a small linked world: persona -> [[note-a]]; a.md -> (./b.md)
  writeFileSync(join(home, "persona", "me.md"), "# me\n\nSee [[note-a]] for context.\n");
  writeFileSync(join(home, "memories", "m1.md"), "a memory about ships and the sea\n");
  writeFileSync(join(vault, "a.md"), "alpha links to [b](./b.md) and [[note-a]]\n");
  writeFileSync(join(vault, "b.md"), "beta, the second note\n");
  writeFileSync(join(vault, "note-a.md"), "the note everyone points at\n");

  writeFileSync(
    join(home, "corpus.config.json"),
    JSON.stringify({
      roots: [{ label: "vault", path: vault, glob: "**/*.md" }],
      exclude: ["node_modules", ".git"],
      chunk: { maxChars: 1200, overlap: 150 },
    }),
  );

  const restore = (): void => {
    if (prevHome === undefined) delete process.env.ME_HOME;
    else process.env.ME_HOME = prevHome;
    if (prevTier === undefined) delete process.env.ME_TIER;
    else process.env.ME_TIER = prevTier;
    rmSync(home, { recursive: true, force: true });
  };

  let out: void | Promise<void>;
  try {
    out = fn(home);
  } catch (e) {
    restore();
    throw e;
  }
  if (out instanceof Promise) return out.finally(restore);
  restore();
}

test("buildBrainGraph maps the world's files to nodes, links to edges", () => {
  withWorld(() => {
    const cfg = loadConfig(process.cwd());
    const g = buildBrainGraph(cfg);

    // persona + memory + 3 vault files = 5 nodes
    assert.equal(g.meta.nodes, 5);
    assert.equal(g.nodes.length, 5);
    const labels = g.nodes.map((n) => n.label).sort();
    assert.deepEqual(labels, ["a", "b", "m1", "me", "note-a"]);

    // no embeddings without an index: falls back to link structure
    assert.equal(g.meta.embedded, false);

    // explicit links became edges: a->b and a->note-a and me->note-a
    assert.ok(g.meta.edges >= 3, `expected >=3 link edges, got ${g.meta.edges}`);
    assert.ok(g.edges.every((e) => e.kind === "link"));

    // note-a is pointed at twice -> highest degree
    const noteA = g.nodes.find((n) => n.label === "note-a");
    assert.ok(noteA && noteA.degree >= 2);

    // groups carry through
    assert.ok(g.meta.groups.includes("persona"));
    assert.ok(g.meta.groups.includes("vault"));

    // every node sits inside the world radius on the sphere shell
    for (const n of g.nodes) {
      const r = Math.hypot(n.sphere[0], n.sphere[1], n.sphere[2]);
      assert.ok(r <= 101, `sphere radius ${r} out of bounds`);
      assert.ok(Number.isFinite(n.semantic[0]));
    }

    // digest is a stable 8-char hex
    assert.match(g.meta.digest, /^[0-9a-f]{8}$/);
  });
});

test("buildBrainGraph digest is deterministic for an unchanged world", () => {
  withWorld(() => {
    const cfg = loadConfig(process.cwd());
    assert.equal(buildBrainGraph(cfg).meta.digest, buildBrainGraph(cfg).meta.digest);
  });
});

test("serveBrain serves the app shell and the graph payload", async () => {
  await withWorld(async () => {
    const cfg = loadConfig(process.cwd());
    const brain = await serveBrain(cfg, { open: false });
    try {
      const html = await fetch(brain.url);
      assert.equal(html.status, 200);
      assert.match(await html.text(), /neural net/);

      const app = await fetch(brain.url + "app.js");
      assert.equal(app.status, 200);

      const gj = await fetch(brain.url + "graph.json");
      assert.equal(gj.status, 200);
      const body = (await gj.json()) as { graph: { meta: { nodes: number } }; version: { tier: string } };
      assert.equal(body.graph.meta.nodes, 5);
      assert.equal(body.version.tier, "me");

      // path traversal is refused
      const bad = await fetch(brain.url + "../package.json");
      assert.ok(bad.status === 404 || bad.status === 400);
    } finally {
      await brain.close();
    }
  });
});
