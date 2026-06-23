# gigame.md

**me.md, pinned to the giga tier.** Same portable digital-twin core — this alias
defaults the model lineup to the **256 GB+ class** ("giga"), the largest tier,
instead of auto-detecting your hardware.

Use this on a serious box (256 GB+ RAM, big multi-GPU, or a large Apple unified
memory machine) when you want the frontier lineup by default and don't want
`me up`'s auto-detect to talk you down.

```bash
pnpm add -g gigame.md     # or npm i -g gigame.md
gigame up                 # boots straight into the giga tier
gigame tiers              # show all three tiers + your detected hardware
```

`gigame` is exactly `me` with `ME_TIER=giga` forced. Everything else — the
orchestrator, security sentinel, loop verifier, RAG, MCP hands, self-states —
is the shared [`me.md`](https://github.com/RichardTheBruce/me-md) core.

**Override:** an explicit `--tier <me|mega|giga>` flag still wins over the pin,
so `gigame up --tier mega` runs the mega lineup.

Giga tier default models: `agent=glm-5.2 · reason=kimi-k2.6 · code=qwen3-coder:480b`.
Point `ME_ENGINE_BASE_URL` at your engine (Ollama or any OpenAI-compatible
server) and override any individual model with the `ME_MODEL_*` env vars.
