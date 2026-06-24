import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
import { EngineClient } from "../engine/client.js";
import { Session } from "../core/orchestrator.js";
import { appendExchange, latestSessionRecap, recapForPrompt } from "../journal/session.js";
import { buildBrainGraph } from "./graph.js";
import { brainVersion } from "./version.js";

export interface BrainServer {
  url: string;
  port: number;
  server: Server;
  close: () => Promise<void>;
}

export interface BrainServeOptions {
  /** Preferred port; falls forward if busy. Default 7337. */
  port?: number;
  /** Open the system browser at the URL. Default true. */
  open?: boolean;
  onStep?: (msg: string) => void;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Max chat message we accept, and max request body we read. */
const MAX_MESSAGE_CHARS = 8000;
const MAX_BODY_BYTES = 65536;
/** Engine health is cached briefly so /chat never hammers a missing endpoint. */
const HEALTH_TTL_MS = 4000;

const NO_ENGINE_REPLY =
  "no local engine is running, so there's nothing to think with yet, and i won't " +
  "pretend otherwise. start your twin with `me up` (it installs and sizes the engine " +
  "on first run), then talk to me here and the net will grow from real thought.";

/** Where the static brain app lives. Works from dist (built) and src (tsx). */
function assetsDir(cfg: Config): string {
  const candidates = [
    join(cfg.repoRoot, "src", "brain", "app"),
    join(dirname(fileURLToPath(import.meta.url)), "app"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "brain", "app"),
  ];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return candidates[0] as string;
}

/** Build the current graph + version as a JSON payload string (fresh each call). */
function graphPayload(cfg: Config): { json: string; nodes: number; edges: number; digest: string } {
  const graph = buildBrainGraph(cfg);
  const version = brainVersion(cfg);
  return {
    json: JSON.stringify({ graph, version }),
    nodes: graph.meta.nodes,
    edges: graph.meta.edges,
    digest: graph.meta.digest,
  };
}

/**
 * Build the neural-net graph from your world and serve the quantum view on a
 * local port. The view is live: it talks to your twin (POST /chat) and grows a
 * node on every answered message, and /graph.json rebuilds on request so new
 * stars appear. With no engine it replies honestly and grows nothing.
 */
export async function serveBrain(cfg: Config, opts: BrainServeOptions = {}): Promise<BrainServer> {
  const step = opts.onStep ?? (() => {});
  const dir = assetsDir(cfg);

  step("projecting your world into 3D…");
  const first = graphPayload(cfg);
  step(`${first.nodes} nodes · ${first.edges} threads · #${first.digest}`);

  // Lazily-created conversational session (no MCP tools in the browser surface,
  // this is the "talk to your brain + watch it grow" panel, not the full agent).
  let session: Session | null = null;
  const getSession = (): Session => {
    if (!session) {
      const recap = recapForPrompt(latestSessionRecap(cfg.store));
      session = new Session(cfg, { useTools: false, recap });
    }
    return session;
  };

  // Cached engine health so a missing Ollama doesn't stall every keystroke.
  let health = { at: 0, ok: false };
  const engineHealthy = async (): Promise<boolean> => {
    const now = Date.now();
    if (now - health.at < HEALTH_TTL_MS) return health.ok;
    let ok = false;
    try {
      ok = await new EngineClient(cfg.engine).health();
    } catch {
      ok = false;
    }
    health = { at: now, ok };
    return ok;
  };

  // One thought at a time: a single Session isn't safe under concurrent sends.
  let busy = false;

  const handleChat = async (message: string): Promise<{ answer: string; engine: boolean }> => {
    // No engine, no growth. The net grows from real thought, not from echoing
    // the user back at themselves: that was the old fake-work fallback, removed.
    if (!(await engineHealthy())) {
      return { answer: NO_ENGINE_REPLY, engine: false };
    }
    const s = getSession();
    try {
      const r = await s.send(message);
      // Grow only on a real answer: one node per exchange, chained into the net.
      // Then drain the buffer (growth is already persisted to disk).
      const turn = s.lastTurn() ?? { at: new Date().toISOString(), prompt: message, answer: r.answer };
      try {
        appendExchange(cfg.store, cfg.personaPath, turn);
      } catch {
        // a failed write must not break the reply; the net just won't grow this turn
      }
      s.drainTranscript();
      return { answer: r.answer, engine: true };
    } catch {
      // The engine looked up but the send failed: a transient snag, not a thought.
      // Don't plant a node for it.
      s.drainTranscript();
      return {
        answer: "i hit a snag reaching the engine just now. try again in a moment.",
        engine: false,
      };
    }
  };

  const server = createServer((req, res) => {
    void route(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("server error");
      }
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

    // Live graph: rebuilt on every request so growth shows up immediately.
    if (urlPath === "/graph.json") {
      const payload = graphPayload(cfg);
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(payload.json);
      return;
    }

    // Lightweight state: does the twin have an engine to talk back with?
    if (urlPath === "/state") {
      const ok = await engineHealthy();
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(JSON.stringify({ engine: ok, version: brainVersion(cfg) }));
      return;
    }

    // Talk to your brain. Replies and grows the net when an engine is up; with
    // no engine it says so honestly and grows nothing.
    if (urlPath === "/chat") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "text/plain" });
        res.end("method not allowed");
        return;
      }
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(413, { "content-type": MIME[".json"] });
        res.end(JSON.stringify({ error: "message too large" }));
        return;
      }
      let message = "";
      try {
        const parsed = JSON.parse(body || "{}") as { message?: unknown };
        if (typeof parsed.message === "string") message = parsed.message.trim();
      } catch {
        message = "";
      }
      if (!message || message.length > MAX_MESSAGE_CHARS) {
        res.writeHead(400, { "content-type": MIME[".json"] });
        res.end(JSON.stringify({ error: "send a non-empty message under 8000 characters" }));
        return;
      }
      if (busy) {
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify({ answer: "one thought at a time. i'm still on your last message.", engine: false, busy: true }));
        return;
      }
      busy = true;
      try {
        const out = await handleChat(message);
        res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
        res.end(JSON.stringify(out));
      } finally {
        busy = false;
      }
      return;
    }

    // Static files: whitelist only, no path traversal.
    const name = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const allowed = name === "index.html" || name === "app.js";
    const file = join(dir, name);
    if (!allowed || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      const fileBody = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(fileBody);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("read error");
    }
  }

  const port = await listen(server, opts.port ?? 7337);
  const url = `http://localhost:${port}/`;

  if (opts.open !== false) {
    openBrowser(url);
    step(`opened ${url}`);
  }

  return {
    url,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        void (session ? session.close() : Promise.resolve()).finally(() => {
          server.close(() => resolve());
        });
      }),
  };
}

/** Read a request body with a hard size cap, so a runaway POST can't OOM us. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Listen on the first free port at or after `start` (tries a small window). */
function listen(server: Server, start: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let port = start;
    const tries = 25;
    const attempt = () => {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < start + tries) {
          port++;
          attempt();
        } else {
          reject(err);
        }
      });
      server.listen(port, "127.0.0.1", () => resolve(port));
    };
    attempt();
  });
}

/** Best-effort cross-platform "open this URL in the default browser". */
export function openBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // caller prints the URL regardless
  }
}
