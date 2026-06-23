import { homedir } from "node:os";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The per-install neural net. The package is immutable code; *this* is where a
 * user's evolving self lives. On install we provision a local store under
 * ~/.me.md/ (override with ME_HOME) and seed the persona from the package's
 * bundled template. This build bundles a blank persona template, so every
 * install starts as an empty self and evolves its own.
 *
 *   <root>/persona/me.md          the human core (seeded once, then evolves)
 *   <root>/corpus.config.json     which .md vaults to index (per host)
 *   <root>/index/                 the RAG vector cache (rebuildable; gitignored)
 *   <root>/memories/              freeform memory files the twin can write
 *   <root>/.git                   self-state time machine (tags = snapshots)
 */
export interface LocalStore {
  root: string;
  personaPath: string;
  corpusConfigPath: string;
  indexDir: string;
  memoriesDir: string;
}

/** Minimal home expansion so this module need not depend on config (no cycle). */
function expandHomeLocal(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Where the per-user store lives: ME_HOME override, else ~/.me.md. */
export function storeRoot(): string {
  const override = process.env.ME_HOME;
  if (override && override.length > 0) return expandHomeLocal(override);
  return join(homedir(), ".me.md");
}

export function resolveStore(): LocalStore {
  const root = storeRoot();
  return {
    root,
    personaPath: join(root, "persona", "me.md"),
    corpusConfigPath: join(root, "corpus.config.json"),
    indexDir: join(root, "index"),
    memoriesDir: join(root, "memories"),
  };
}

const BLANK_PERSONA = `# me

> This is your persona core. It starts blank and becomes you.

Every decision you log (\`me journal add\`) and every note you index becomes part
of "me" the next time the twin loads. Tell it who you are, how you decide, what
you value — or just start journaling and let it accumulate.

## Self-State Log (append-only)

`;

export interface ProvisionResult {
  seeded: boolean;
  store: LocalStore;
}

/**
 * Provision the store on first run. Idempotent: creates the dir skeleton, seeds
 * the persona from the bundled template (or a blank one), seeds a corpus config,
 * and writes a .gitignore so the rebuildable index is never snapshotted.
 */
export function provisionStore(
  bundledPersonaPath: string,
  bundledCorpusConfigPath: string,
  log: (msg: string) => void = () => {},
): ProvisionResult {
  const store = resolveStore();
  mkdirSync(dirname(store.personaPath), { recursive: true });
  mkdirSync(store.memoriesDir, { recursive: true });

  // index/ is a derived cache: never version it as part of a self-state.
  const gitignorePath = join(store.root, ".gitignore");
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, "index/\n", "utf8");
  }

  let seeded = false;
  if (!existsSync(store.personaPath)) {
    if (existsSync(bundledPersonaPath)) {
      copyFileSync(bundledPersonaPath, store.personaPath);
    } else {
      writeFileSync(store.personaPath, BLANK_PERSONA, "utf8");
    }
    seeded = true;
    log(`seeded persona core -> ${store.personaPath}`);
  }

  // Seed a corpus config the user can point at their own vaults, so they never
  // have to edit files inside a globally-installed package.
  if (!existsSync(store.corpusConfigPath)) {
    if (existsSync(bundledCorpusConfigPath)) {
      copyFileSync(bundledCorpusConfigPath, store.corpusConfigPath);
    } else {
      writeFileSync(
        store.corpusConfigPath,
        JSON.stringify(
          { roots: [], exclude: ["node_modules", ".git"], chunk: { maxChars: 1200, overlap: 150 } },
          null,
          2,
        ) + "\n",
        "utf8",
      );
    }
    log(`seeded corpus config -> ${store.corpusConfigPath}`);
  }

  return { seeded, store };
}
