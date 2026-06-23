import { existsSync, readFileSync } from "node:fs";
import type { Chunk } from "../rag/store.js";

export function loadPersona(personaPath: string): string {
  if (!existsSync(personaPath)) return "";
  return readFileSync(personaPath, "utf8");
}

export function composeSystemPrompt(persona: string, context: Chunk[]): string {
  const parts: string[] = [persona.trim()];
  if (context.length > 0) {
    parts.push("\n\n# Retrieved from my neural net (most relevant first)");
    for (const c of context) {
      parts.push(`\n## ${c.label}: ${c.id}\n${c.text}`);
    }
  }
  parts.push(
    "\n\n# Operating instruction\n" +
      "Answer as the user's twin, grounded in the persona core and the retrieved notes above. " +
      "Act on my principles when you use a tool. If the notes do not cover something, say so plainly rather than inventing.",
  );
  return parts.join("\n");
}
