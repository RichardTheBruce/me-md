export type Role = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

export type TaskKind = "reason" | "agent" | "fast" | "code" | "embed";

export interface ChatResult {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  raw?: unknown;
}
