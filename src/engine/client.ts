import type { EngineConfig } from "../config.js";
import type { ChatMessage, ChatResult, ToolCall, ToolDef } from "../types.js";

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
}

/**
 * OpenAI-compatible HTTP client. The whole point of this file: the engine is
 * decoupled. Ollama today, vLLM on real hardware, by changing one base URL.
 */
export class EngineClient {
  constructor(private cfg: EngineConfig) {}

  private url(path: string): string {
    return this.cfg.baseUrl.replace(/\/$/, "") + path;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.7,
    };
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools;
      body.tool_choice = "auto";
    }
    const res = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`engine chat failed ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      model?: string;
      choices?: { message?: { content?: unknown; tool_calls?: ToolCall[] } }[];
    };
    const message = data.choices?.[0]?.message ?? {};
    const toolCalls: ToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return {
      content: typeof message.content === "string" ? message.content : "",
      toolCalls,
      model: data.model ?? opts.model,
      raw: data,
    };
  }

  async embed(model: string, input: string[]): Promise<number[][]> {
    const res = await fetch(this.url("/embeddings"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) {
      throw new Error(`engine embed failed ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as { data?: { embedding: number[] }[] };
    return (data.data ?? []).map((d) => d.embedding);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(this.url("/models"), { headers: this.headers() });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** List model ids the engine currently serves (OpenAI /models shape). */
  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(this.url("/models"), { headers: this.headers() });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: { id?: unknown }[] };
      return (data.data ?? [])
        .map((m) => (typeof m.id === "string" ? m.id : ""))
        .filter((id) => id.length > 0);
    } catch {
      return [];
    }
  }
}
