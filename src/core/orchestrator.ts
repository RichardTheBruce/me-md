import type { Config } from "../config.js";
import { EngineClient } from "../engine/client.js";
import { buildRegistry } from "../engine/registry.js";
import { route } from "../router.js";
import { retrieve } from "../rag/index.js";
import { composeSystemPrompt, loadPersona } from "../persona/loader.js";
import { McpHub } from "../mcp/client.js";
import { loadMcpServers } from "../mcp/loadConfig.js";
import { toolsToOpenAI } from "../mcp/toolBridge.js";
import { reviewAction, summarizeFinding, type RiskLevel } from "../security/sentinel.js";
import type { ChatMessage, TaskKind, ToolDef } from "../types.js";

export interface AskOptions {
  prompt: string;
  override?: TaskKind;
  useTools?: boolean;
  maxToolRounds?: number;
  security?: boolean;
  blockAt?: RiskLevel;
  onStep?: (msg: string) => void;
}

export interface AskResult {
  answer: string;
  model: string;
  routeKind: TaskKind;
  contextCount: number;
  toolRounds: number;
  /** Tool calls the sentinel blocked this turn. */
  blocked: number;
  /** Tool calls the sentinel flagged (allowed, but noteworthy) this turn. */
  flagged: number;
}

export interface SessionOptions {
  useTools?: boolean;
  maxToolRounds?: number;
  /** Gate every tool call through the security sentinel (default true). */
  security?: boolean;
  /** Block at or above this risk level (default "critical"). */
  blockAt?: RiskLevel;
  onStep?: (msg: string) => void;
}

export interface SessionConnectInfo {
  servers: number;
  connected: number;
  tools: number;
}

/**
 * A live conversation with the twin. Connect MCP once, keep persona + history
 * across turns. The whole neural net stays warm between prompts.
 */
export class Session {
  private engine: EngineClient;
  private registry: ReturnType<typeof buildRegistry>;
  private messages: ChatMessage[];
  private hub: McpHub | null = null;
  private tools: ToolDef[] = [];
  private useTools: boolean;
  private maxToolRounds: number;
  private security: boolean;
  private blockAt: RiskLevel;
  // Security model tiers, set on connect() only if the host actually serves them.
  private gateModel: string | undefined;
  private deepModel: string | undefined;
  private log: (msg: string) => void;

  constructor(
    private cfg: Config,
    opts: SessionOptions = {},
  ) {
    this.log = opts.onStep ?? (() => {});
    this.useTools = opts.useTools ?? true;
    this.maxToolRounds = opts.maxToolRounds ?? 4;
    this.security = opts.security ?? true;
    this.blockAt = opts.blockAt ?? "critical";
    this.engine = new EngineClient(cfg.engine);
    this.registry = buildRegistry(cfg.models);
    const system = composeSystemPrompt(loadPersona(cfg.personaPath), []);
    this.messages = [{ role: "system", content: system }];
  }

  /** Connect the MCP hands once. Safe to call when tools are disabled (no-op). */
  async connect(): Promise<SessionConnectInfo> {
    if (!this.useTools) return { servers: 0, connected: 0, tools: 0 };
    this.hub = new McpHub();
    const specs = loadMcpServers(this.cfg.mcpConfigPath);
    this.log(`connecting ${specs.length} MCP servers...`);
    const conn = await this.hub.connectAll(specs);
    const connected = conn.filter((c) => c.ok).length;
    this.log(`MCP connected: ${connected}/${specs.length}`);
    const remoteTools = await this.hub.listTools();
    this.tools = toolsToOpenAI(remoteTools);
    this.log(`tools available: ${this.tools.length}`);

    // The deterministic sentinel is always on. The model tiers only engage if
    // the host actually serves them, so we never hammer a missing endpoint.
    if (this.security) {
      const have = new Set(await this.engine.listModels());
      const present = (m: string): boolean => have.has(m) || have.has(`${m}:latest`);
      this.gateModel = present(this.cfg.models.securityGate) ? this.cfg.models.securityGate : undefined;
      this.deepModel = present(this.cfg.models.securityDeep) ? this.cfg.models.securityDeep : undefined;
      const tiers = [
        "deterministic",
        this.gateModel ? "gate" : null,
        this.deepModel ? "deep" : null,
      ].filter(Boolean);
      this.log(`sentinel: block@${this.blockAt} · tiers: ${tiers.join("+")}`);
    }

    return { servers: specs.length, connected, tools: this.tools.length };
  }

  /** One turn. Routes, retrieves fresh context, runs the bounded tool loop. */
  async send(prompt: string, override?: TaskKind): Promise<AskResult> {
    const decision = route(prompt, this.registry, override);
    this.log(`route: ${decision.kind} -> ${decision.model}`);

    this.log("retrieving from neural net...");
    const context = await retrieve(this.cfg, this.engine, prompt, 6);
    this.log(`context: ${context.length} chunks`);

    const userContent =
      context.length > 0
        ? "Retrieved from my neural net (most relevant first):\n\n" +
          context.map((c) => `## ${c.label}: ${c.id}\n${c.text}`).join("\n\n---\n\n") +
          `\n\n---\n\nUser: ${prompt}`
        : prompt;
    this.messages.push({ role: "user", content: userContent });

    let toolRounds = 0;
    let blocked = 0;
    let flagged = 0;
    for (;;) {
      const result = await this.engine.chat({
        model: decision.model,
        messages: this.messages,
        tools: this.tools,
      });
      if (result.toolCalls.length === 0 || !this.hub || toolRounds >= this.maxToolRounds) {
        this.messages.push({ role: "assistant", content: result.content });
        return {
          answer: result.content,
          model: result.model,
          routeKind: decision.kind,
          contextCount: context.length,
          toolRounds,
          blocked,
          flagged,
        };
      }
      toolRounds++;
      this.messages.push({
        role: "assistant",
        content: result.content,
        tool_calls: result.toolCalls,
      });
      for (const call of result.toolCalls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }

        // Sentinel gate: nothing executes without clearing it.
        if (this.security && this.hub) {
          const finding = await reviewAction(call.function.name, args, {
            blockAt: this.blockAt,
            engine: this.engine,
            gateModel: this.gateModel,
            deepModel: this.deepModel,
            onStep: this.log,
          });
          if (finding.verdict === "block") {
            blocked++;
            this.log(`BLOCKED ${call.function.name} — ${summarizeFinding(finding)}`);
            this.messages.push({
              role: "tool",
              content:
                `[security sentinel BLOCKED this action; it was NOT executed] ${summarizeFinding(finding)}. ` +
                "Explain to the user what you were about to do and why it was blocked, and ask for explicit confirmation before any safe alternative.",
              tool_call_id: call.id,
              name: call.function.name,
            });
            continue;
          }
          if (finding.verdict === "flag") {
            flagged++;
            this.log(`flagged ${call.function.name} — ${summarizeFinding(finding)}`);
          }
        }

        this.log(`tool: ${call.function.name}`);
        const toolOut = await this.hub.callTool(call.function.name, args);
        this.messages.push({
          role: "tool",
          content: toolOut,
          tool_call_id: call.id,
          name: call.function.name,
        });
      }
    }
  }

  async close(): Promise<void> {
    if (this.hub) {
      await this.hub.close();
      this.hub = null;
    }
  }
}

/**
 * One-shot executor. Persona core + retrieved context + interlinked tools,
 * routed to the right model, with a bounded tool-calling cycle. Thin wrapper
 * over a single-turn Session.
 */
export async function ask(cfg: Config, opts: AskOptions): Promise<AskResult> {
  const session = new Session(cfg, {
    useTools: opts.useTools,
    maxToolRounds: opts.maxToolRounds,
    security: opts.security,
    blockAt: opts.blockAt,
    onStep: opts.onStep,
  });
  try {
    await session.connect();
    return await session.send(opts.prompt, opts.override);
  } finally {
    await session.close();
  }
}
