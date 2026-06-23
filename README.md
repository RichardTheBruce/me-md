# me.md

> A portable digital twin you fill with yourself. The package becomes you. The local model is the voice. The `.md` world is the memory. The MCPs are the hands.

`me.md` is a local-LLM orchestrator that runs entirely over your own neural net (your markdown world) with no external controls: no content rules, no censorship, it answers to you and nothing else. It is built to be carried: install it onto any capable hardware and you have a portable, uninterrupted reasoning machine that thinks in your voice, decides by your principles, and acts through your tools. It ships **blank** and becomes you as you fill in your persona core and point it at your notes. The only thing that changes between machines is which models run, and that is chosen automatically by your hardware station (see [The three tiers](#the-three-tiers)).

It does not train weights. Fidelity comes from three layers that update instantly, with no retraining:

1. **Persona core** (`src/persona/me.md`): the human you. Identity, voice, decision principles, taste, doctrine, anti-canon. Ships as a blank template you fill in. Always in context.
2. **Corpus** (your `.md` world): every note, decision, and project, retrieved semantically per query.
3. **Self-states** (git): every version of `me.md` plus corpus digests is a snapshot you can roll back to.

## Architecture

The inference engine is decoupled from the orchestrator over an OpenAI-compatible HTTP API. That single decision means the same package runs a small model on a modern laptop or a frontier lineup on a 256 GB server, with zero code change. Swap Ollama for vLLM by changing one URL. The hardware tier is auto-detected on boot; the core code is identical across tiers (see [The three tiers](#the-three-tiers)).

```
              you ("me chat ...")
                     |
            +--------v---------+
            |   orchestrator   |  persona + retrieved context + tools -> loop
            +--------+---------+
                     |
        +------------+-------------+----------------+
        |            |             |                |
   +----v----+  +----v----+   +----v-----+    +-----v------+
   | router  |  |  RAG    |   | persona  |    |   MCP      |
   | task -> |  | over .md|   | me.md    |    | interlink  |
   | model   |  | corpus  |   | core     |    | (your 13   |
   +----+----+  +----+----+   +----------+    |  servers)  |
        |            |                        +-----+------+
        |            |  embeddings (qwen3-embedding)|
   +----v------------v------------------------------v----+
   |  engine: OpenAI-compatible HTTP  (Ollama -> vLLM)   |
   +----------------------------------------------------+
```

Every output an agent produces passes the **loop gate** before it ships, and every tool call passes the **security sentinel** before it runs (see [Safety](#safety-the-sentinel-and-the-loop)).

## The three tiers

The core code is the same everywhere; a tier only changes the model lineup. On boot, `me up` reads your RAM (`os.totalmem`) and VRAM (`nvidia-smi` / Apple unified memory / `rocm-smi`) and picks the largest tier your hardware clears. On your **first interactive boot** it shows that recommendation and lets you pick any of the three lineups — the choice is saved to `~/.me.md/tier.json` so later boots never re-ask (re-open it any time with `me up --pick`). Or skip the prompt entirely: pin a tier with `--tier` / `ME_TIER`, or install the matching alias package.

Resolution precedence is `--tier` flag → `ME_TIER` env → your saved choice → hardware auto-detect, so an explicit override always wins and piped/CI boots never block on the prompt.

| | **me.md** | **megame.md** | **gigame.md** |
| --- | --- | --- | --- |
| Hardware | laptop/desktop, 1 GPU (~24-48 GB VRAM, 32 GB+ RAM) | workstation / multi-GPU (~128 GB VRAM, 128 GB+ RAM) | giant rig / server (256 GB+ VRAM & RAM) |
| `agent` (orchestrator) | `qwen3.5-35b-a3b` | `glm-4.7` | `glm-5.2` |
| `reasoner` | `qwen3.5-32b` | `deepseek-v4-flash` | `kimi-k2.6` |
| `coder` | `qwen3-coder:30b-a3b` | `glm-4.6` | `qwen3-coder:480b` |
| `fast` | `qwen3:4b` | `qwen3:8b` | `qwen3:8b` |
| `embed` | `qwen3-embedding:4b` | `qwen3-embedding:8b` | `qwen3-embedding:8b` |
| `securityGate` | `llama-guard3:8b` | ← shared | ← shared |
| `securityDeep` | `foundation-sec-8b-reasoning` | ← shared | ← shared |
| `judge` | `prometheus-eval:7b-v2` | ← shared | ← shared |

The safety lineup (gate / deep reviewer / judge) is **shared** — it never gets weaker on a smaller box. Every model is env-overridable (`ME_MODEL_*`), so pin the exact tag your host has pulled. `me tiers` prints this table with your detected hardware and the active tier.

```bash
me                          # auto-detect and boot
me --tier mega              # pin the mega lineup on this run
megame                      # or install the alias: it pins mega by default
```

## Install on a capable host

```bash
# 1. Install the runtime engine (Windows/macOS/Linux: https://ollama.com)

# 2. Install the twin (auto-detect tier) from github
npm install -g github:RichardTheBruce/me-md
#   npm-registry packages (me.md / megame.md / gigame.md) land after launch

# 3. Configure
cp .env.example .env            # point ME_ENGINE_BASE_URL at your engine
#   edit corpus.config.json to point at your .md vault on this host

# 4. Boot once — it pulls the routed lineup for your tier, indexes, and talks
me up --pull
me chat "what would I decide about X?"
```

`me up --pull` fetches exactly the models your detected tier routes to, so you don't have to memorize the lineup. `me health` shows engine reachability and the resolved models (including the safety three).

## Single-line startup

Once installed, one word boots the whole neural net:

```bash
me
```

That is shorthand for `me up`, which self-heals the stack before handing you a prompt:

1. **Engine** — if the engine is down and you are pointed at a local Ollama, it runs `ollama serve` for you and waits until it answers.
2. **Models** — checks the routed lineup is present (`me up --pull` fetches any that are missing).
3. **Index** — builds the RAG index on first run if it is not there yet.
4. **Hands** — connects your MCP servers once and keeps them warm.
5. **Prompt** — opens an interactive session that remembers the whole conversation.

```
me ▸ what would I decide about X?
...
me ▸ /journal chose path C for the engine split
me ▸ /snapshot locked engine decoupling
me ▸ /exit
```

In-session commands: `/journal <entry>`, `/snapshot [note]`, `/help`, `/exit`. Flags: `--pull` (fetch missing models), `--no-tools` (skip MCP).

From a fresh machine, the bootstrap scripts collapse install + boot into one line:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/RichardTheBruce/me-md/main/scripts/bootstrap.sh | bash
```

```powershell
# Windows
irm https://raw.githubusercontent.com/RichardTheBruce/me-md/main/scripts/bootstrap.ps1 | iex
```

## Commands

| Command | What it does |
| --- | --- |
| `me` / `me up` | Boot the whole neural net (engine + models + index + MCP) and open an interactive prompt. |
| `me chat "<prompt>"` | One-shot: talk to the twin. Persona + RAG context + MCP tools, routed to the right model. |
| `me index` | Build/refresh the vector index over your `.md` corpus. |
| `me journal add "<entry>"` | Append a decision to the journal (feeds your evolution). |
| `me mcp list` | List the MCP servers wired in from your Claude config. |
| `me self snapshot` | Tag the current self-state in git (`self/<date>`). |
| `me self list` | List all self-state snapshots. |
| `me self rollback <tag>` | Roll back to a self-state you prefer. |
| `me tiers` | Show the three tiers + your detected hardware + the active tier. |
| `me guard "<tool>" '<json>'` | Dry-run the security sentinel on a tool call (exit 2 = block). |
| `me gate <file>` | Run the loop gate on a file: security + sources + judge (exit 1 iterate, 2 reject). |
| `me health` | Check engine reachability and the resolved model lineup. |

## Your local store

The package is immutable code; the *evolving you* lives in a per-install store at `~/.me.md` (override with `ME_HOME`). On first run `me` provisions it and seeds your persona, corpus config, index, journal, and self-states there. The persona ships blank, so every install starts as an empty self and grows its own. Nothing you write ever touches the installed package, so you can upgrade `me.md` freely and your store carries forward untouched.

## Versioned self-states

Git is the time machine — and the repo is your store (`~/.me.md`), committed under a dedicated `me.md` identity that never touches your own git config. Each `me self snapshot` tags the persona plus a corpus digest; a self-state you do not like is one `me self rollback <tag>` away. `npm version` bumps map to self-state releases, so `npm install me.md@<version>` pins a specific you.

## Safety: the sentinel and the loop

Born from a real bug — *"I asked my card to freeze itself, it lied and said yes, then did nothing."* Two layers stand between intent and damage, both deterministic-first so they hold even with no safety models served:

- **Security sentinel** — every MCP tool call is classified before it runs. Money movement, irreversible deletes, destructive git, prod deploys, and account-danger actions are *critical* and **blocked**; mutations, comms, and secret handling are *flagged*; plain reads pass. The deterministic classifier is authoritative for blocks; the model tiers (`securityGate`, then `securityDeep`) only *escalate* a verdict, never weaken it, and degrade gracefully when absent. Dry-run any call with `me guard`.
- **Loop gate** — every agent output runs three checks: **security** (scan for leaked credentials / prompt-injection), **judge** (Prometheus-2 1-5 rubric → SHIP / ITERATE / REJECT), and **sources** (extract every URL, flag dead / unverifiable / ungrounded claims). Anything short of a pass feeds an actionable critique back to the agent, which re-runs until it passes or hits the cap (default 5). Run it over a file with `me gate`, or in code via `verifyLoop` / `verifyBatch`.

## Phase 2: the Python sidecar

The orchestrator is pure TypeScript and needs no Python. When real hardware is available and weight-training is on the table, an optional Python sidecar (`python-sidecar/`) handles local LoRA fine-tuning, advanced reranking, and evals. It is lazy: nothing in v1 requires it.

## The four layers, restated

- **Voice**: the local model, abliterated so it answers to you and nothing else.
- **Self**: `me.md`, the human core, always loaded.
- **Memory**: your `.md` world, retrieved per query.
- **Hands**: your MCP servers, interlinked into one orchestrator.

## Built by RichardTheBruce

`me.md` is built and maintained by **RichardTheBruce**. It is free and open under [Apache-2.0](LICENSE) — use it, fork it, ship it. The only payment asked is attribution:

- ⭐ **Star the repo:** [github.com/RichardTheBruce/me-md](https://github.com/RichardTheBruce/me-md)
- 👤 **Follow the author:** [@RichardTheBruce](https://github.com/RichardTheBruce)

If this twin earns a place on your machine and you want to buy me a coffee, send **$5 in any token on any EVM chain** (Ethereum, Base, etc.) to:

```
0x337c623fF3634b1dD2f64Ca3674aaFdB0cbdf7b4
```

Entirely optional — the star and the follow mean just as much.
