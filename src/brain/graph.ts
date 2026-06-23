import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { Config } from "../config.js";
import { expandHome } from "../config.js";
import { VectorStore, cosine, type Chunk } from "../rag/store.js";

/**
 * A node in the quantum neural net: one .md file in your world. Carries both a
 * semantic position (where it lands in embedding space, projected to 3D) and a
 * sphere position (the iconic shell). MORPH tweens between the two.
 */
export interface BrainNode {
  id: string;
  /** Short display name (file basename, no extension). */
  label: string;
  /** Corpus label this file belongs to (persona / memories / a vault). */
  group: string;
  /** Absolute source path, for the tooltip. */
  path: string;
  /** How many chunks / how much text — drives node size. */
  weight: number;
  /** Edge count, filled after edges are built — also drives node size + color. */
  degree: number;
  /** Semantic position from PCA over embeddings (meaningful clustering). */
  semantic: [number, number, number];
  /** Iconic shell position (fibonacci sphere), ordered by PC1. */
  sphere: [number, number, number];
  /** Flat galaxy spiral — the always-available alternate MORPH target. */
  galaxy: [number, number, number];
}

/** A faint thread between two files: semantic kinship or an explicit md link. */
export interface BrainEdge {
  /** Source node index. */
  a: number;
  /** Target node index. */
  b: number;
  /** 0..1 strength — links are strong, kinship scales with cosine similarity. */
  weight: number;
  /** "link" (explicit md/wikilink) or "kin" (embedding similarity). */
  kind: "link" | "kin";
}

export interface BrainMeta {
  nodes: number;
  edges: number;
  groups: string[];
  /** True when nodes carry real embedding positions (index was built). */
  embedded: boolean;
  /** Short content hash of the corpus — changes when your world changes. */
  digest: string;
  builtAt: string;
}

export interface BrainGraph {
  meta: BrainMeta;
  nodes: BrainNode[];
  edges: BrainEdge[];
}

interface FileNode {
  path: string;
  label: string;
  group: string;
  text: string;
  weight: number;
  embedding: number[];
}

const MAX_NODES = 1500; // a personal corpus is well under this; cap for the GPU.
const KIN_PER_NODE = 4; // top-k nearest neighbours kept as kinship threads.
const KIN_MIN = 0.55; // cosine floor: below this, two files aren't really kin.
const R = 100; // world radius the layouts are scaled into.

/**
 * Build the neural-net graph from your world. Prefers the RAG index (real
 * embeddings → meaningful semantic positions); falls back to a filesystem walk
 * (links-only) so `me brain` shows something even before the first `me index`.
 */
export function buildBrainGraph(cfg: Config): BrainGraph {
  const files = collectFiles(cfg);
  const embedded = files.some((f) => f.embedding.length > 0);

  // Cap to the heaviest files so a giant vault still renders smoothly.
  files.sort((a, b) => b.weight - a.weight);
  const kept = files.slice(0, MAX_NODES);
  kept.sort((a, b) => a.path.localeCompare(b.path)); // stable order for indices.

  const semantic = projectSemantic(kept, embedded);
  const order = embedded ? orderByFirstAxis(semantic) : kept.map((_, i) => i);
  const sphere = fibonacciSphere(kept.length, order);
  const galaxy = galaxySpiral(kept, order);

  const nodes: BrainNode[] = kept.map((f, i) => ({
    id: f.path,
    label: f.label,
    group: f.group,
    path: f.path,
    weight: f.weight,
    degree: 0,
    semantic: semantic[i] ?? [0, 0, 0],
    sphere: sphere[i] ?? [0, 0, 0],
    galaxy: galaxy[i] ?? [0, 0, 0],
  }));

  const edges = buildEdges(kept, embedded);
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    if (a) a.degree++;
    if (b) b.degree++;
  }

  const groups = [...new Set(nodes.map((n) => n.group))].sort();
  const digest = corpusDigest(kept);

  return {
    meta: {
      nodes: nodes.length,
      edges: edges.length,
      groups,
      embedded,
      digest,
      builtAt: new Date().toISOString(),
    },
    nodes,
    edges,
  };
}

// ---------------------------------------------------------------------------
// 1. collect file nodes (from the index, else a filesystem walk)
// ---------------------------------------------------------------------------

function collectFiles(cfg: Config): FileNode[] {
  const fromIndex = collectFromIndex(cfg);
  if (fromIndex.length > 0) return fromIndex;
  return collectFromDisk(cfg);
}

/** Aggregate index chunks into one node per source file (mean embedding). */
function collectFromIndex(cfg: Config): FileNode[] {
  const store = new VectorStore(cfg.indexDir);
  store.load();
  if (store.size === 0) return [];

  const byFile = new Map<string, Chunk[]>();
  for (const c of (store as unknown as { chunks: Chunk[] }).chunks ?? []) {
    const list = byFile.get(c.source) ?? [];
    list.push(c);
    byFile.set(c.source, list);
  }

  const out: FileNode[] = [];
  for (const [source, chunks] of byFile) {
    const first = chunks[0];
    if (!first) continue;
    const dim = first.embedding.length;
    const mean = new Array<number>(dim).fill(0);
    let n = 0;
    for (const c of chunks) {
      if (c.embedding.length !== dim) continue;
      for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) + (c.embedding[i] ?? 0);
      n++;
    }
    if (n > 0) for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) / n;
    const text = chunks.map((c) => c.text).join("\n");
    out.push({
      path: normalizePath(source),
      label: labelFor(source),
      group: first.label,
      text,
      weight: text.length,
      embedding: n > 0 ? mean : [],
    });
  }
  return out;
}

/** No index yet: walk persona + memories + corpus roots for .md (links only). */
function collectFromDisk(cfg: Config): FileNode[] {
  const seen = new Map<string, FileNode>();
  const add = (file: string, group: string): void => {
    const norm = normalizePath(file);
    if (seen.has(norm)) return;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    seen.set(norm, {
      path: norm,
      label: labelFor(file),
      group,
      text,
      weight: text.length,
      embedding: [],
    });
  };

  if (existsSync(cfg.personaPath)) add(cfg.personaPath, "persona");
  const memDir = cfg.store.memoriesDir;
  for (const f of walkMd(memDir, cfg.corpus.exclude)) add(f, "memories");
  for (const root of cfg.corpus.roots) {
    const base = expandHome(root.path);
    for (const f of walkMd(base, cfg.corpus.exclude)) add(f, root.label);
  }
  return [...seen.values()];
}

const WALK_CAP = 4000; // hard limit on .md files scanned per walk (safety).

/** Directory names to never descend into (derived from the corpus excludes). */
function excludedDirNames(exclude: string[]): Set<string> {
  const out = new Set<string>([".git", "node_modules", ".next", "dist", ".obsidian"]);
  for (const ex of exclude) {
    const token = ex.replace(/[*/\\]/g, "").trim();
    if (token) out.add(token);
  }
  return out;
}

/**
 * Pruning markdown walk. Unlike a blind recursive readdir, this never descends
 * into excluded or dotted directories (node_modules, .git, big build dirs, the
 * extracted drops), so it stays fast on a real home directory. Caps the haul so
 * a runaway tree can't stall the brain.
 */
function walkMd(root: string, exclude: string[]): string[] {
  if (!existsSync(root)) return [];
  const skip = excludedDirNames(exclude);
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0 && out.length < WALK_CAP) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name.startsWith(".") || skip.has(ent.name)) continue;
        stack.push(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
        out.push(full);
        if (out.length >= WALK_CAP) break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. semantic layout — PCA over embeddings, projected to 3D
// ---------------------------------------------------------------------------

/**
 * Project file embeddings to 3D via PCA. Works in sample space (eigenvectors of
 * the n×n Gram matrix), since #files << embedding dim — cheap and dependency
 * free. Without embeddings, returns a deterministic pseudo-random cloud that
 * MORPH can still pull into the sphere.
 */
function projectSemantic(files: FileNode[], embedded: boolean): [number, number, number][] {
  const n = files.length;
  if (n === 0) return [];
  if (!embedded || n < 4) {
    return files.map((f, i) => scatter(f.path, i));
  }

  const dim = files[0]?.embedding.length ?? 0;
  // Centre the embeddings (subtract per-dimension mean over files).
  const mean = new Array<number>(dim).fill(0);
  for (const f of files) for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) + (f.embedding[i] ?? 0);
  for (let i = 0; i < dim; i++) mean[i] = (mean[i] ?? 0) / n;
  const X: number[][] = files.map((f) =>
    Array.from({ length: dim }, (_, i) => (f.embedding[i] ?? 0) - (mean[i] ?? 0)),
  );

  // Gram matrix G = X Xᵀ  (n×n).
  const G: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) {
    const xi = X[i] ?? [];
    for (let j = i; j < n; j++) {
      const xj = X[j] ?? [];
      let d = 0;
      for (let k = 0; k < dim; k++) d += (xi[k] ?? 0) * (xj[k] ?? 0);
      const row = G[i];
      const rowj = G[j];
      if (row) row[j] = d;
      if (rowj) rowj[i] = d;
    }
  }

  // Top-3 eigenvectors by power iteration + deflation. Scores = u_k * sqrt(λ_k).
  const coords: number[][] = [];
  for (let c = 0; c < 3; c++) {
    const { vec, val } = topEigen(G, c);
    const s = Math.sqrt(Math.max(val, 0));
    coords.push(vec.map((v) => v * s));
    deflate(G, vec, val);
  }

  const pts: [number, number, number][] = files.map((_, i) => [
    coords[0]?.[i] ?? 0,
    coords[1]?.[i] ?? 0,
    coords[2]?.[i] ?? 0,
  ]);
  return rescale(pts);
}

/** Leading eigenvector of a symmetric matrix via power iteration. */
function topEigen(M: number[][], seed: number): { vec: number[]; val: number } {
  const n = M.length;
  let v = Array.from({ length: n }, (_, i) => Math.sin(i * 12.9898 + seed * 7.233 + 1) * 43758.5453);
  v = normalize(v.map((x) => x - Math.floor(x) - 0.5));
  let val = 0;
  for (let iter = 0; iter < 64; iter++) {
    const w = new Array<number>(n).fill(0);
    for (let i = 0; i < n; i++) {
      const row = M[i] ?? [];
      let s = 0;
      for (let j = 0; j < n; j++) s += (row[j] ?? 0) * (v[j] ?? 0);
      w[i] = s;
    }
    const norm = Math.hypot(...w);
    if (norm < 1e-9) break;
    const nv = w.map((x) => x / norm);
    val = norm;
    let diff = 0;
    for (let i = 0; i < n; i++) diff += Math.abs((nv[i] ?? 0) - (v[i] ?? 0));
    v = nv;
    if (diff < 1e-7) break;
  }
  return { vec: v, val };
}

/** Remove an eigen-component so the next power iteration finds the next axis. */
function deflate(M: number[][], vec: number[], val: number): void {
  const n = M.length;
  for (let i = 0; i < n; i++) {
    const row = M[i];
    if (!row) continue;
    for (let j = 0; j < n; j++) {
      row[j] = (row[j] ?? 0) - val * (vec[i] ?? 0) * (vec[j] ?? 0);
    }
  }
}

function normalize(v: number[]): number[] {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Centre + scale a point cloud so its largest extent fills the world radius. */
function rescale(pts: [number, number, number][]): [number, number, number][] {
  const n = pts.length || 1;
  const c: [number, number, number] = [0, 0, 0];
  for (const p of pts) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  c[0] /= n;
  c[1] /= n;
  c[2] /= n;
  let max = 1e-6;
  for (const p of pts) {
    max = Math.max(max, Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]));
  }
  const s = R / max;
  return pts.map((p) => [(p[0] - c[0]) * s, (p[1] - c[1]) * s, (p[2] - c[2]) * s]);
}

/** Deterministic pseudo-random point on a ball, seeded by path (no embeddings). */
function scatter(seed: string, i: number): [number, number, number] {
  const h = hashNum(seed + i);
  const u = ((h % 1000) / 1000) * 2 - 1;
  const theta = ((Math.floor(h / 1000) % 1000) / 1000) * Math.PI * 2;
  const r = R * Math.cbrt(((Math.floor(h / 1_000_000) % 1000) / 1000) * 0.9 + 0.1);
  const s = Math.sqrt(1 - u * u);
  return [r * s * Math.cos(theta), r * u, r * s * Math.sin(theta)];
}

// ---------------------------------------------------------------------------
// 3. sphere layout — the iconic shell, ordered so neighbours sit together
// ---------------------------------------------------------------------------

function orderByFirstAxis(pts: [number, number, number][]): number[] {
  return pts
    .map((p, i) => ({ i, key: p[0] }))
    .sort((a, b) => a.key - b.key)
    .map((o) => o.i);
}

/**
 * A flat-ish galaxy: a golden-angle spiral disc with a thicker core and a thin
 * rim. Always available (no embeddings needed), so MORPH always has somewhere
 * to fly to — the sphere unfurls into a spiral and back.
 */
function galaxySpiral(files: FileNode[], order: number[]): [number, number, number][] {
  const n = files.length;
  const out: [number, number, number][] = new Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let slot = 0; slot < n; slot++) {
    const node = order[slot] ?? slot;
    const t = n <= 1 ? 0 : slot / (n - 1);
    const radius = R * Math.sqrt(t) * 1.05;
    const theta = golden * slot * 2.2;
    const f = files[node];
    const jitter = ((hashNum((f?.path ?? String(node)) + ":gy") % 200) / 100 - 1) * 14 * (1 - t);
    out[node] = [radius * Math.cos(theta), jitter, radius * Math.sin(theta)];
  }
  return out;
}

/** Even points on a sphere (golden-angle spiral); `order` maps slot → node. */
function fibonacciSphere(n: number, order: number[]): [number, number, number][] {
  const out: [number, number, number][] = new Array(n);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let slot = 0; slot < n; slot++) {
    const node = order[slot] ?? slot;
    const y = n === 1 ? 0 : 1 - (slot / (n - 1)) * 2;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * slot;
    out[node] = [R * radius * Math.cos(theta) * 0.95, R * y * 0.95, R * radius * Math.sin(theta) * 0.95];
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. edges — explicit md/wikilinks (strong) + embedding kinship (faint)
// ---------------------------------------------------------------------------

function buildEdges(files: FileNode[], embedded: boolean): BrainEdge[] {
  const indexByPath = new Map<string, number>();
  const indexByBase = new Map<string, number>();
  files.forEach((f, i) => {
    indexByPath.set(f.path, i);
    indexByBase.set(basename(f.path).toLowerCase(), i);
    indexByBase.set(f.label.toLowerCase(), i);
  });

  const seen = new Set<string>();
  const edges: BrainEdge[] = [];
  const key = (a: number, b: number): string => (a < b ? `${a}-${b}` : `${b}-${a}`);

  // Explicit links: [text](rel.md) and [[wikilinks]].
  files.forEach((f, i) => {
    for (const target of extractLinks(f)) {
      let j = indexByPath.get(target);
      if (j === undefined) j = indexByBase.get(basename(target).toLowerCase());
      if (j === undefined) j = indexByBase.get(target.toLowerCase());
      if (j === undefined || j === i) continue;
      const k = key(i, j);
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ a: i, b: j, weight: 1, kind: "link" });
    }
  });

  // Kinship: top-k nearest neighbours by cosine, above the floor.
  if (embedded) {
    for (let i = 0; i < files.length; i++) {
      const ei = files[i]?.embedding ?? [];
      if (ei.length === 0) continue;
      const sims: { j: number; s: number }[] = [];
      for (let j = 0; j < files.length; j++) {
        if (j === i) continue;
        const ej = files[j]?.embedding ?? [];
        if (ej.length === 0) continue;
        const s = cosine(ei, ej);
        if (s >= KIN_MIN) sims.push({ j, s });
      }
      sims.sort((a, b) => b.s - a.s);
      for (const { j, s } of sims.slice(0, KIN_PER_NODE)) {
        const k = key(i, j);
        if (seen.has(k)) continue;
        seen.add(k);
        edges.push({ a: i, b: j, weight: Math.max(0, Math.min(1, s)), kind: "kin" });
      }
    }
  }

  return edges;
}

function extractLinks(f: FileNode): string[] {
  const out: string[] = [];
  const dir = f.path.slice(0, f.path.lastIndexOf("/"));
  // [text](path.md)
  for (const m of f.text.matchAll(/\[[^\]]*\]\(([^)]+\.md)[^)]*\)/gi)) {
    const raw = (m[1] ?? "").trim();
    if (!raw || /^https?:/i.test(raw)) {
      if (raw) out.push(raw);
      continue;
    }
    out.push(normalizePath(resolve(dir, raw)));
  }
  // [[wikilink]] (basename, optional .md)
  for (const m of f.text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const name = (m[1] ?? "").trim();
    if (name) out.push(name.toLowerCase().endsWith(".md") ? name : `${name}.md`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  return p.split(sep).join("/");
}

function labelFor(p: string): string {
  return basename(p).replace(/\.md$/i, "");
}

function hashNum(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Short, stable hash of the corpus shape — drives the brain's version digest. */
function corpusDigest(files: FileNode[]): string {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${relative(".", f.path)}:${f.weight}\n`);
  }
  return h.digest("hex").slice(0, 8);
}
