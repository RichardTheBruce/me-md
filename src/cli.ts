#!/usr/bin/env node
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadEnv, type Config } from "./config.js";
import { parseTier, TIER_PROFILES, type Tier } from "./tiers.js";
import { ask, Session } from "./core/orchestrator.js";
import { ensureEngine, ensureIndex, ensureModels } from "./core/boot.js";
import { EngineClient } from "./engine/client.js";
import { buildIndex } from "./rag/index.js";
import { addJournalEntry } from "./journal/journal.js";
import { loadMcpServers, skippedHttpServers } from "./mcp/loadConfig.js";
import { McpHub } from "./mcp/client.js";
import { listSelfStates, rollback, snapshot } from "./selfstate/snapshot.js";
import { provisionStore } from "./store/local.js";
import { reviewAction, summarizeFinding } from "./security/sentinel.js";
import { runGate } from "./loop/verify.js";

/** Ensure the per-install store exists + is seeded. Cheap + idempotent. */
function ensureStore(cfg: Config, log: (m: string) => void = () => {}): void {
  provisionStore(cfg.bundledPersonaPath, cfg.bundledCorpusConfigPath, log);
}

function repoRootFromHere(): string {
  // dist/cli.js (built) or src/cli.ts (tsx) -> repo root is one level up.
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Pull a tier override out of argv: `--tier mega` or `--tier=giga`. */
function parseTierFlag(args: string[]): Tier | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--tier=")) return parseTier(a.slice("--tier=".length));
    if (a === "--tier") return parseTier(args[i + 1]);
  }
  return undefined;
}

/** Pull a string flag value: `--name value` or `--name=value`. */
function parseStringFlag(args: string[], name: string): string | undefined {
  const eq = `--${name}=`;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith(eq)) return a.slice(eq.length);
    if (a === `--${name}`) return args[i + 1];
  }
  return undefined;
}

/** Mask credentials before printing MCP server args (they come from ~/.claude.json). */
function redactSecrets(s: string): string {
  return s
    .replace(/(\/\/[^:/@\s]+:)[^@/\s]+@/g, "$1***@")
    .replace(/((?:api[-_]?key|apikey|key|token|password|secret|pat)=)\S+/gi, "$1***")
    .replace(/sk_(?:test|live)_[A-Za-z0-9]+/g, "sk_***")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-***")
    .replace(/gh[pousr]_[A-Za-z0-9]{8,}/g, "gh***");
}

const HELP = `me.md - your portable digital twin

usage:
  me                        boot the whole neural net + open an interactive prompt
  me up [--pull]            same as bare 'me' (--pull fetches missing models)
  me chat "<prompt>"        one-shot: talk to the twin (persona + RAG + MCP tools)
  me index                  build/refresh the index over your .md world
  me journal add "<entry>"  append a decision to your persona core
  me mcp list               list interlinked MCP servers
  me mcp probe              connect to MCP servers and count tools
  me self snapshot [note]   tag the current self-state
  me self list              list self-states
  me self rollback <tag>    roll back to a self-state
  me tiers                  show the three tiers + detected hardware
  me guard "<tool>" '<json>'  dry-run the security sentinel on a tool call
  me gate <file>            run the loop gate on a file (security + sources + judge)
  me health                 check engine reachability + model lineup

flags:
  --pull                    (with up) pull any missing models via ollama
  --no-tools                start the session without MCP tools
  --tier <me|mega|giga>     pin a tier instead of auto-detecting hardware
  --for "<instruction>"     (with gate) what the output was meant to satisfy
  --check-links             (with gate) HTTP-check every cited URL for dead links
  --judge                   (with gate) score with the judge model (needs engine)

env:
  ME_NO_TOOLS=1             disable MCP tools for a single chat
  ME_TIER=me|mega|giga      pin the tier (overridden by --tier)
`;

const REPL_HELP = `interactive commands:
  /exit                  leave the session
  /journal <entry>       append a decision to your persona core
  /snapshot [note]       tag the current self-state
  /help                  show this help
anything else is sent to your twin.`;

/**
 * Single-line startup. Heal the engine, models, and index, connect the MCP
 * hands, then open a stateful prompt that remembers the whole conversation.
 */
async function up(cfg: Config, flags: Set<string>): Promise<number> {
  const step = (m: string): void => console.error(`  · ${m}`);

  console.error(cfg.tierInfo.detail);
  if (cfg.tierInfo.belowFloor) {
    console.error(
      "  (this host is below the recommended floor for the smallest tier; " +
        "the models may not fit. Point ME_ENGINE_BASE_URL at a real box, or override with --tier.)",
    );
  }

  ensureStore(cfg, step);
  console.error(`store: ${cfg.store.root}`);

  const eng = await ensureEngine(cfg, step);
  console.error(`engine: ${eng.detail}`);
  if (!eng.ok) {
    console.error(
      "\ncan't boot the neural net without an engine.\n" +
        "  - install Ollama:  https://ollama.com\n" +
        "  - or point ME_ENGINE_BASE_URL at a running engine in .env\n",
    );
    return 1;
  }

  const mod = await ensureModels(cfg, step, flags.has("--pull"));
  console.error(`models: ${mod.detail}`);
  if (!mod.ok) {
    console.error("\nrerun with --pull to fetch them, or pull manually with ollama.\n");
    return 1;
  }

  const idx = await ensureIndex(cfg, step);
  console.error(`index: ${idx.detail}`);

  const useTools = !flags.has("--no-tools") && process.env.ME_NO_TOOLS !== "1";
  const session = new Session(cfg, { useTools, onStep: step });
  const conn = await session.connect();
  if (useTools) console.error(`hands: ${conn.connected}/${conn.servers} MCP servers, ${conn.tools} tools`);

  console.error("\nme.md is up. you're talking to yourself. /help for commands, /exit to leave.\n");

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "me ▸ " });
  rl.prompt();

  for await (const line of rl) {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      continue;
    }
    if (text === "/exit" || text === "/quit") break;
    if (text === "/help") {
      console.log(REPL_HELP);
      rl.prompt();
      continue;
    }
    if (text.startsWith("/journal ")) {
      addJournalEntry(cfg.personaPath, text.slice("/journal ".length).trim());
      console.log("journal entry added to persona core.");
      rl.prompt();
      continue;
    }
    if (text === "/snapshot" || text.startsWith("/snapshot ")) {
      const note = text.slice("/snapshot".length).trim() || undefined;
      try {
        const tag = snapshot(cfg.store.root, note);
        console.log(`self-state tagged: ${tag}`);
      } catch (e) {
        console.error(`snapshot failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      rl.prompt();
      continue;
    }

    try {
      const result = await session.send(text);
      console.log("\n" + result.answer + "\n");
      console.error(
        `[${result.routeKind} via ${result.model} | ${result.contextCount} ctx | ${result.toolRounds} tool rounds` +
          (result.blocked > 0 ? ` | ${result.blocked} BLOCKED` : "") +
          (result.flagged > 0 ? ` | ${result.flagged} flagged` : "") +
          "]",
      );
    } catch (e) {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    }
    rl.prompt();
  }

  rl.close();
  await session.close();
  console.error("\nencoded. see you next boot.\n");
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] && !argv[0].startsWith("-") ? argv[0] : "up";
  const rest = cmd === argv[0] ? argv.slice(1) : argv;
  const flags = new Set(rest.filter((a) => a.startsWith("-")));
  const repoRoot = repoRootFromHere();
  loadEnv(repoRoot);
  const cfg = loadConfig(repoRoot, { tier: parseTierFlag(rest) });

  switch (cmd) {
    case "up": {
      process.exitCode = await up(cfg, flags);
      break;
    }

    case "chat": {
      const prompt = rest.join(" ").trim();
      if (!prompt) {
        console.error('usage: me chat "<prompt>"');
        process.exitCode = 1;
        return;
      }
      ensureStore(cfg);
      const result = await ask(cfg, {
        prompt,
        useTools: process.env.ME_NO_TOOLS !== "1",
        onStep: (m) => console.error(`  · ${m}`),
      });
      console.log("\n" + result.answer + "\n");
      console.error(
        `[${result.routeKind} via ${result.model} | ${result.contextCount} ctx | ${result.toolRounds} tool rounds` +
          (result.blocked > 0 ? ` | ${result.blocked} BLOCKED` : "") +
          (result.flagged > 0 ? ` | ${result.flagged} flagged` : "") +
          "]",
      );
      break;
    }

    case "index": {
      ensureStore(cfg);
      const engine = new EngineClient(cfg.engine);
      console.error("indexing corpus...");
      const res = await buildIndex(cfg, engine);
      console.log(`indexed ${res.chunks} chunks from ${res.files} files -> ${cfg.indexDir}`);
      break;
    }

    case "journal": {
      if (rest[0] === "add") {
        const entry = rest.slice(1).join(" ").trim();
        if (!entry) {
          console.error('usage: me journal add "<entry>"');
          process.exitCode = 1;
          return;
        }
        ensureStore(cfg);
        addJournalEntry(cfg.personaPath, entry);
        console.log("journal entry added to persona core.");
      } else {
        console.error('usage: me journal add "<entry>"');
      }
      break;
    }

    case "mcp": {
      const sub = rest[0] ?? "list";
      if (sub === "list") {
        const specs = loadMcpServers(cfg.mcpConfigPath);
        const skipped = skippedHttpServers(cfg.mcpConfigPath);
        console.log(`MCP config: ${cfg.mcpConfigPath}`);
        console.log(`${specs.length} stdio servers wired in:`);
        for (const s of specs) {
          console.log(`  - ${s.name}  (${redactSecrets(`${s.command} ${s.args.join(" ")}`)})`);
        }
        if (skipped.length > 0) {
          console.log(`skipped (http/sse, not yet supported): ${skipped.join(", ")}`);
        }
      } else if (sub === "probe") {
        const hub = new McpHub();
        const specs = loadMcpServers(cfg.mcpConfigPath);
        const conn = await hub.connectAll(specs);
        for (const c of conn) {
          console.log(`  ${c.ok ? "ok  " : "fail"}  ${c.server}${c.error ? "  " + c.error : ""}`);
        }
        const tools = await hub.listTools();
        console.log(`total tools: ${tools.length}`);
        await hub.close();
      } else {
        console.error("usage: me mcp <list|probe>");
      }
      break;
    }

    case "self": {
      const sub = rest[0];
      if (sub === "snapshot") {
        ensureStore(cfg);
        const tag = snapshot(cfg.store.root, rest.slice(1).join(" ") || undefined);
        console.log(`self-state tagged: ${tag}  (in ${cfg.store.root})`);
      } else if (sub === "list") {
        const tags = listSelfStates(cfg.store.root);
        if (tags.length === 0) console.log("no self-states yet.");
        for (const t of tags) console.log(`  ${t}`);
      } else if (sub === "rollback") {
        const tag = rest[1];
        if (!tag) {
          console.error("usage: me self rollback <tag>");
          process.exitCode = 1;
          return;
        }
        rollback(cfg.store.root, tag);
        console.log(`rolled back to ${tag} (detached HEAD; 'git checkout master' to return).`);
      } else {
        console.error("usage: me self <snapshot|list|rollback>");
      }
      break;
    }

    case "guard": {
      const tool = rest[0];
      if (!tool) {
        console.error("usage: me guard \"<tool>\" '<json args>'");
        process.exitCode = 1;
        return;
      }
      let args: Record<string, unknown> = {};
      const rawArgs = rest.slice(1).join(" ").trim();
      if (rawArgs) {
        try {
          args = JSON.parse(rawArgs) as Record<string, unknown>;
        } catch {
          console.error(`could not parse args as JSON: ${rawArgs}`);
          process.exitCode = 1;
          return;
        }
      }
      const finding = await reviewAction(tool, args, { blockAt: "critical" });
      console.log(summarizeFinding(finding));
      if (finding.verdict === "block") process.exitCode = 2;
      break;
    }

    case "gate": {
      const file = rest[0];
      if (!file || file.startsWith("-")) {
        console.error('usage: me gate <file> [--for "<instruction>"] [--check-links] [--judge]');
        process.exitCode = 1;
        return;
      }
      let content: string;
      try {
        content = readFileSync(file, "utf8");
      } catch (e) {
        console.error(`could not read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        process.exitCode = 1;
        return;
      }
      const instruction = parseStringFlag(rest, "for") ?? "Evaluate this output as a deliverable.";
      const useJudge = flags.has("--judge");
      const report = await runGate(instruction, content, {
        engine: useJudge ? new EngineClient(cfg.engine) : undefined,
        judgeModel: useJudge ? cfg.models.judge : undefined,
        checkLiveness: flags.has("--check-links"),
        onStep: (m) => console.error(`  · ${m}`),
      });
      console.log(`gate: ${report.status.toUpperCase()}`);
      for (const r of report.reasons) console.log(`  - ${r}`);
      if (report.critique) console.log("\ncritique:\n" + report.critique);
      process.exitCode = report.status === "reject" ? 2 : report.status === "iterate" ? 1 : 0;
      break;
    }

    case "tiers": {
      console.log(cfg.tierInfo.detail + "\n");
      for (const t of ["me", "mega", "giga"] as Tier[]) {
        const p = TIER_PROFILES[t];
        const active = t === cfg.tier ? "  <- active" : "";
        console.log(`${p.label}${active}`);
        console.log(`  hardware: ${p.hardware}`);
        console.log(
          `  models:   agent=${p.models.agent} reason=${p.models.reasoner} code=${p.models.coder}`,
        );
        console.log("");
      }
      break;
    }

    case "health": {
      const engine = new EngineClient(cfg.engine);
      const ok = await engine.health();
      console.log(cfg.tierInfo.detail);
      console.log(`engine ${cfg.engine.baseUrl}: ${ok ? "reachable" : "unreachable"}`);
      console.log(
        `models: reasoner=${cfg.models.reasoner} agent=${cfg.models.agent} fast=${cfg.models.fast} coder=${cfg.models.coder} embed=${cfg.models.embed}`,
      );
      console.log(
        `safety: gate=${cfg.models.securityGate} deep=${cfg.models.securityDeep} judge=${cfg.models.judge}`,
      );
      break;
    }

    default:
      console.log(HELP);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
