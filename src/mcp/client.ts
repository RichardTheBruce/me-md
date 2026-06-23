import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { McpServerSpec } from "./loadConfig.js";

export interface RemoteTool {
  server: string;
  name: string; // namespaced: server__tool
  rawName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ConnectResult {
  server: string;
  ok: boolean;
  error?: string;
}

interface Connected {
  spec: McpServerSpec;
  client: Client;
}

/**
 * Connects to many MCP servers at once and aggregates their tools into one
 * namespaced surface. This is the "hands" of the twin: every MCP server the
 * human already uses, interlinked behind one orchestrator.
 */
export class McpHub {
  private connected: Connected[] = [];
  private toolIndex = new Map<string, { client: Client; rawName: string }>();

  async connectAll(specs: McpServerSpec[]): Promise<ConnectResult[]> {
    const results: ConnectResult[] = [];
    for (const spec of specs) {
      try {
        const transport = new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
        });
        const client = new Client({ name: "me.md", version: "0.1.0" }, { capabilities: {} });
        await client.connect(transport);
        this.connected.push({ spec, client });
        results.push({ server: spec.name, ok: true });
      } catch (err) {
        results.push({ server: spec.name, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  async listTools(): Promise<RemoteTool[]> {
    const tools: RemoteTool[] = [];
    for (const { spec, client } of this.connected) {
      try {
        const res = await client.listTools();
        for (const t of res.tools) {
          const namespaced = `${spec.name}__${t.name}`;
          this.toolIndex.set(namespaced, { client, rawName: t.name });
          tools.push({
            server: spec.name,
            name: namespaced,
            rawName: t.name,
            description: t.description ?? "",
            inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
          });
        }
      } catch {
        // a server that fails to list is skipped, not fatal
      }
    }
    return tools;
  }

  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolIndex.get(namespacedName);
    if (!entry) return `error: unknown tool ${namespacedName}`;
    try {
      const res = await entry.client.callTool({ name: entry.rawName, arguments: args });
      return stringifyToolResult(res);
    } catch (err) {
      return `error calling ${namespacedName}: ${(err as Error).message}`;
    }
  }

  async close(): Promise<void> {
    for (const { client } of this.connected) {
      try {
        await client.close();
      } catch {
        // ignore close failures
      }
    }
    this.connected = [];
    this.toolIndex.clear();
  }
}

function stringifyToolResult(res: unknown): string {
  const content = (res as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const item = c as { type?: string; text?: string };
        return item?.type === "text" && typeof item.text === "string"
          ? item.text
          : JSON.stringify(c);
      })
      .join("\n");
  }
  return JSON.stringify(res);
}
