import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Config } from "../config.js";
import { expandHome } from "../config.js";
import type { EngineClient } from "../engine/client.js";
import { embedTexts } from "./embed.js";
import { VectorStore, type Chunk } from "./store.js";

function walkMarkdown(root: string, exclude: string[]): string[] {
  if (!existsSync(root)) return [];
  let entries: string[] = [];
  try {
    entries = (readdirSync(root, { recursive: true }) as string[]).map((e) => e.toString());
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rel of entries) {
    const full = join(root, rel);
    if (!full.toLowerCase().endsWith(".md")) continue;
    const norm = full.split(sep).join("/");
    if (exclude.some((ex) => norm.includes(ex.replace(/\*/g, "")))) continue;
    try {
      if (statSync(full).isFile()) out.push(full);
    } catch {
      // skip unreadable
    }
  }
  return out;
}

function chunkText(text: string, maxChars: number, overlap: number): string[] {
  const clean = text.replace(/\r\n/g, "\n");
  if (clean.length <= maxChars) {
    const t = clean.trim();
    return t ? [t] : [];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < clean.length) {
    const end = Math.min(start + maxChars, clean.length);
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

export interface IndexResult {
  files: number;
  chunks: number;
}

export async function buildIndex(cfg: Config, engine: EngineClient): Promise<IndexResult> {
  const allChunks: Chunk[] = [];
  let fileCount = 0;

  for (const rootCfg of cfg.corpus.roots) {
    const root = expandHome(rootCfg.path);
    const files = walkMarkdown(root, cfg.corpus.exclude);
    for (const file of files) {
      let content = "";
      try {
        content = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      fileCount++;
      const pieces = chunkText(content, cfg.corpus.chunk.maxChars, cfg.corpus.chunk.overlap);
      pieces.forEach((text, i) => {
        allChunks.push({
          id: `${rootCfg.label}:${relative(root, file).split(sep).join("/")}#${i}`,
          source: file,
          label: rootCfg.label,
          text,
          embedding: [],
        });
      });
    }
  }

  if (allChunks.length > 0) {
    const vectors = await embedTexts(
      engine,
      cfg.models.embed,
      allChunks.map((c) => c.text),
    );
    allChunks.forEach((c, i) => {
      c.embedding = vectors[i] ?? [];
    });
  }

  const store = new VectorStore(cfg.indexDir);
  store.set(allChunks);
  store.save();
  return { files: fileCount, chunks: allChunks.length };
}

export async function retrieve(
  cfg: Config,
  engine: EngineClient,
  query: string,
  k = 6,
): Promise<Chunk[]> {
  const store = new VectorStore(cfg.indexDir);
  store.load();
  if (store.size === 0) return [];
  const vecs = await embedTexts(engine, cfg.models.embed, [query]);
  const qVec = vecs[0];
  if (!qVec) return [];
  return store.query(qVec, k).map((h) => h.chunk);
}
