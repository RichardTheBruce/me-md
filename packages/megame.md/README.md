# megame.md

**me.md, pinned to the mega tier.** Same portable digital-twin core; this alias
just defaults the model lineup to the **~128 GB class** ("mega") instead of
auto-detecting your hardware.

Use this when you already know you have the iron (e.g. a 96-128 GB box, an
Apple M-series with large unified memory, or a multi-GPU server) and you don't
want `me up`'s auto-detect to second-guess you.

```bash
pnpm add -g megame.md     # or npm i -g megame.md
megame up                 # boots straight into the mega tier
megame tiers              # show all three tiers + your detected hardware
```

`megame` is exactly `me` with `ME_TIER=mega` forced. Everything else (the
orchestrator, security sentinel, loop verifier, RAG, MCP hands, self-states)
is the shared [`me.md`](https://github.com/RichardTheBruce/me-md) core.

**Override:** an explicit `--tier <me|mega|giga>` flag still wins over the pin,
so `megame up --tier giga` runs the giga lineup.

Mega tier default models: `agent + reason = huihui_ai/llama3.3-abliterated:70b-instruct-q4_K_M · code = huihui_ai/qwen2.5-abliterate:32b`.
Point `ME_ENGINE_BASE_URL` at your engine (Ollama or any OpenAI-compatible
server) and override any individual model with the `ME_MODEL_*` env vars.
