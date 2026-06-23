#!/usr/bin/env node
// megame.md — me.md, pinned to the mega tier (~128 GB class hardware).
//
// The whole package IS the tier: we force ME_TIER=mega, then hand off to the
// shared me.md CLI. Setting the env var must happen BEFORE the CLI module is
// evaluated (static imports are hoisted), so we use a dynamic import here.
// An explicit `--tier <me|mega|giga>` flag still wins — flag overrides env.
process.env.ME_TIER = "mega";
await import("me.md/cli");
