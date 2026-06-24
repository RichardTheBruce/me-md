#!/usr/bin/env node
// gigame.md: me.md, pinned to the giga tier (256 GB+ class hardware).
//
// The whole package IS the tier: we force ME_TIER=giga, then hand off to the
// shared me.md CLI. Setting the env var must happen BEFORE the CLI module is
// evaluated (static imports are hoisted), so we use a dynamic import here.
// An explicit `--tier <me|mega|giga>` flag still wins: flag overrides env.
process.env.ME_TIER = "giga";
await import("me.md/cli");
