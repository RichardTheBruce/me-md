import { existsSync, readFileSync } from "node:fs";

export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface RawServer {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  type?: unknown;
  url?: unknown;
}

/**
 * Read the same MCP servers Claude uses from ~/.claude.json (mcpServers).
 * v1 supports stdio (command-based) servers. HTTP/SSE servers (with a `url`)
 * are skipped for now and reported by the caller.
 */
export function loadMcpServers(configPath: string): McpServerSpec[] {
  if (!existsSync(configPath)) return [];
  let raw: { mcpServers?: Record<string, RawServer> };
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, RawServer> };
  } catch {
    return [];
  }
  const servers = raw.mcpServers ?? {};
  const out: McpServerSpec[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    if (!spec || typeof spec !== "object") continue;
    if (typeof spec.command !== "string") continue; // skip http/sse for v1
    out.push({
      name,
      command: spec.command,
      args: Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [],
      env:
        spec.env && typeof spec.env === "object"
          ? (spec.env as Record<string, string>)
          : undefined,
    });
  }
  return out;
}

/** Names of servers skipped because they are not stdio (have a url/type). */
export function skippedHttpServers(configPath: string): string[] {
  if (!existsSync(configPath)) return [];
  let raw: { mcpServers?: Record<string, RawServer> };
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, RawServer> };
  } catch {
    return [];
  }
  const servers = raw.mcpServers ?? {};
  return Object.entries(servers)
    .filter(([, spec]) => spec && typeof spec === "object" && typeof spec.command !== "string")
    .map(([name]) => name);
}
