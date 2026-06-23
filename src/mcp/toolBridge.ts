import type { ToolDef } from "../types.js";
import type { RemoteTool } from "./client.js";

/** Convert MCP tool definitions into the OpenAI tool-calling schema. */
export function toolsToOpenAI(tools: RemoteTool[]): ToolDef[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: normalizeSchema(t.inputSchema),
    },
  }));
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  if (!("type" in schema)) return { type: "object", ...schema };
  return schema;
}
