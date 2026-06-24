import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ABLITERATED_LADDER,
  EMBED_MODEL,
  FLOOR_FALLBACK,
  pickAbliterated,
  type Rung,
} from "../src/engine/lineup.js";

// --- the ladder is the verified single source of truth -----------------------
// These tags are pinned on purpose: an accidental edit to a tag would 404 on
// pull and break the turnkey install, so the test guards the exact strings.

test("ladder tags are the verified abliterated set, smallest to largest", () => {
  assert.equal(ABLITERATED_LADDER.floor.tag, "huihui_ai/qwen2.5-abliterate:3b");
  assert.equal(ABLITERATED_LADDER.low.tag, "mannix/llama3.1-8b-abliterated:tools-q4_k_m");
  assert.equal(ABLITERATED_LADDER.mid.tag, "huihui_ai/qwen2.5-abliterate:32b");
  assert.equal(ABLITERATED_LADDER.high.tag, "huihui_ai/llama3.3-abliterated:70b-instruct-q4_K_M");
  assert.equal(FLOOR_FALLBACK.tag, "huihui_ai/qwen2.5-abliterate:1.5b");
  assert.equal(EMBED_MODEL.tag, "nomic-embed-text");
});

test("every chat rung supports tools and declares positive sizes", () => {
  const rungs: Rung[] = ["floor", "low", "mid", "high"];
  for (const r of rungs) {
    const m = ABLITERATED_LADDER[r];
    assert.equal(m.tools, true, `${r} must support tool calling`);
    assert.ok(m.sizeGb > 0, `${r} sizeGb must be positive`);
    assert.ok(m.minMemGb > 0, `${r} minMemGb must be positive`);
    assert.ok(m.tag.length > 0 && m.label.length > 0);
  }
});

test("ladder is monotonic in memory footprint", () => {
  const { floor, low, mid, high } = ABLITERATED_LADDER;
  assert.ok(FLOOR_FALLBACK.minMemGb < floor.minMemGb);
  assert.ok(floor.minMemGb < low.minMemGb);
  assert.ok(low.minMemGb < mid.minMemGb);
  assert.ok(mid.minMemGb < high.minMemGb);
});

// --- pickAbliterated: largest rung the host can hold (1.2x headroom) ----------

test("pickAbliterated climbs the ladder with available memory", () => {
  // workstation / server class -> the 70B
  assert.equal(pickAbliterated(128, 0).rung, "high");
  assert.equal(pickAbliterated(64, 0).rung, "high"); // 64 >= 52*1.2 = 62.4
  // single big GPU box -> the 32B
  assert.equal(pickAbliterated(48, 0).rung, "mid"); // 48 in [33.6, 62.4)
  // typical desktop -> the 8B
  assert.equal(pickAbliterated(16, 0).rung, "low"); // 16 in [12, 33.6)
  // thin laptop that still clears the floor -> the 3B
  assert.equal(pickAbliterated(8, 0).rung, "floor"); // 8 in [6, 12)
});

test("pickAbliterated uses the larger of RAM and VRAM (the GPU counts)", () => {
  // 8 GB RAM but a 48 GB GPU should run the mid rung off VRAM.
  const pick = pickAbliterated(8, 48);
  assert.equal(pick.rung, "mid");
  assert.equal(pick.belowFloor, false);
  assert.equal(pick.model.tag, ABLITERATED_LADDER.mid.tag);
});

test("pickAbliterated flags belowFloor on a host too thin for even the floor", () => {
  const pick = pickAbliterated(4, 0); // 4 < 5*1.2 = 6
  assert.equal(pick.belowFloor, true);
  // it still returns a model (the floor rung); the caller drops to the tiny
  // last-resort tag before giving up.
  assert.equal(pick.rung, "floor");
});

test("a host that exactly clears a rung boundary takes that rung", () => {
  assert.equal(pickAbliterated(6, 0).rung, "floor"); // 6 == 5*1.2
  assert.equal(pickAbliterated(12, 0).rung, "low"); // 12 == 10*1.2
  assert.equal(pickAbliterated(33.6, 0).rung, "mid"); // 33.6 == 28*1.2
  assert.equal(pickAbliterated(62.4, 0).rung, "high"); // 62.4 == 52*1.2
});
