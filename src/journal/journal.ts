import { appendFileSync, existsSync, writeFileSync } from "node:fs";

/**
 * Append a decision to the persona core's Self-State Log. This is how the twin
 * evolves with the human: every logged decision becomes part of "me" the next
 * time the persona core is loaded.
 */
export function addJournalEntry(personaPath: string, entry: string, tag = "decision"): void {
  const date = new Date().toISOString().slice(0, 10);
  const line = `- ${date} | ${tag} | ${entry.trim()}\n`;
  if (!existsSync(personaPath)) {
    writeFileSync(personaPath, `## Self-State Log (append-only)\n\n${line}`, "utf8");
    return;
  }
  appendFileSync(personaPath, line, "utf8");
}
