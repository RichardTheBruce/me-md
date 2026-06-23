import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Chunk {
  id: string;
  source: string;
  label: string;
  text: string;
  embedding: number[];
}

export interface QueryHit {
  chunk: Chunk;
  score: number;
}

/**
 * Flat JSON-backed vector store with cosine search. Right-sized for a personal
 * corpus (a few thousand chunks). Scale-up path: sqlite-vec or lancedb, swapped
 * behind this same interface.
 */
export class VectorStore {
  private chunks: Chunk[] = [];
  private file: string;

  constructor(private dir: string) {
    this.file = join(dir, "index.json");
  }

  load(): void {
    if (!existsSync(this.file)) return;
    const data = JSON.parse(readFileSync(this.file, "utf8")) as { chunks?: Chunk[] };
    this.chunks = data.chunks ?? [];
  }

  save(): void {
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, JSON.stringify({ chunks: this.chunks }), "utf8");
  }

  set(chunks: Chunk[]): void {
    this.chunks = chunks;
  }

  get size(): number {
    return this.chunks.length;
  }

  query(embedding: number[], k: number): QueryHit[] {
    const hits = this.chunks.map((chunk) => ({ chunk, score: cosine(embedding, chunk.embedding) }));
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
