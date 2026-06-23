import type { ModelConfig } from "../config.js";
import type { TaskKind } from "../types.js";

export interface ModelEntry {
  name: string;
  kind: TaskKind;
  description: string;
}

export function buildRegistry(models: ModelConfig): Record<TaskKind, ModelEntry> {
  return {
    reason: {
      name: models.reasoner,
      kind: "reason",
      description: "Primary reasoner. Deep reasoning over the corpus and decisions.",
    },
    agent: {
      name: models.agent,
      kind: "agent",
      description: "Agentic orchestrator. Drives multi-step tool use across your MCP hands.",
    },
    fast: {
      name: models.fast,
      kind: "fast",
      description: "Fast recall and short exchanges.",
    },
    code: {
      name: models.coder,
      kind: "code",
      description: "Code generation and review.",
    },
    embed: {
      name: models.embed,
      kind: "embed",
      description: "Embeddings for retrieval.",
    },
  };
}
