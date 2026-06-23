import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickTier } from "../src/tiers.js";
import { readSavedTier, saveTier } from "../src/store/local.js";
import { resolveTier } from "../src/config.js";

/** Run fn with ME_HOME pointed at a throwaway store dir, then restore + clean. */
function withTempHome(fn: () => void): void {
  const prevHome = process.env.ME_HOME;
  const prevTier = process.env.ME_TIER;
  const dir = mkdtempSync(join(tmpdir(), "memd-test-"));
  process.env.ME_HOME = dir;
  delete process.env.ME_TIER;
  try {
    fn();
  } finally {
    if (prevHome === undefined) delete process.env.ME_HOME;
    else process.env.ME_HOME = prevHome;
    if (prevTier === undefined) delete process.env.ME_TIER;
    else process.env.ME_TIER = prevTier;
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- the interactive menu mapping ---

test("pickTier maps menu numbers, aliases, and empty = the offered default", () => {
  assert.equal(pickTier("", "me"), "me");
  assert.equal(pickTier("", "giga"), "giga");
  assert.equal(pickTier("1", "giga"), "me");
  assert.equal(pickTier("2", "me"), "mega");
  assert.equal(pickTier("3", "me"), "giga");
  assert.equal(pickTier("mega", "me"), "mega");
  assert.equal(pickTier("gigame.md", "me"), "giga");
  assert.equal(pickTier("  MeGa  ", "me"), "mega");
  // a stray keystroke must never derail boot: fall back to the default
  assert.equal(pickTier("nonsense", "me"), "me");
});

// --- persistence round-trip ---

test("saveTier / readSavedTier round-trip in the store", () => {
  withTempHome(() => {
    assert.equal(readSavedTier(), undefined);
    saveTier("mega");
    assert.equal(readSavedTier(), "mega");
    saveTier("giga");
    assert.equal(readSavedTier(), "giga");
  });
});

// --- resolution precedence: explicit override > saved choice > hardware auto ---

test("resolveTier precedence: override > saved > auto", () => {
  withTempHome(() => {
    // nothing pinned, nothing saved -> hardware auto-detect
    assert.equal(resolveTier().source, "auto");

    // a saved choice beats auto-detect
    saveTier("giga");
    const saved = resolveTier();
    assert.equal(saved.tier, "giga");
    assert.equal(saved.source, "saved");

    // an explicit --tier override beats the saved choice
    const overridden = resolveTier({ tier: "mega" });
    assert.equal(overridden.tier, "mega");
    assert.equal(overridden.source, "override");

    // ME_TIER env also beats the saved choice
    process.env.ME_TIER = "me";
    const envTier = resolveTier();
    assert.equal(envTier.tier, "me");
    assert.equal(envTier.source, "override");
  });
});
