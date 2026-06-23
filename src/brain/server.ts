import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.js";
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

/** Where the static brain app lives — works from dist (built) and src (tsx). */
function assetsDir(cfg: Config): string {
  const candidates = [
    join(cfg.repoRoot, "src", "brain", "app"),
    join(dirname(fileURLToPath(import.meta.url)), "app"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "brain", "app"),
  ];
  for (const c of candidates) if (existsSync(join(c, "index.html"))) return c;
  return candidates[0] as string;
}

/**
 * Build the neural-net graph from your world and serve the quantum view on a
 * local port. Returns a handle so callers (the REPL) can keep it warm and close
 * it on exit, or (the standalone command) can wait on it until Ctrl-C.
 */
export async function serveBrain(cfg: Config, opts: BrainServeOptions = {}): Promise<BrainServer> {
  const step = opts.onStep ?? (() => {});
  const dir = assetsDir(cfg);

  step("projecting your world into 3D…");
  const graph = buildBrainGraph(cfg);
  const version = brainVersion(cfg);
  const payload = JSON.stringify({ graph, version });
  step(`${graph.meta.nodes} nodes · ${graph.meta.edges} threads · #${graph.meta.digest}`);

  const server = createServer((req, res) => {
    const urlPath = (req.url ?? "/").split("?")[0] ?? "/";

    if (urlPath === "/graph.json") {
      res.writeHead(200, { "content-type": MIME[".json"], "cache-control": "no-store" });
      res.end(payload);
      return;
    }

    // Whitelist static files only — no path traversal.
    const name = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
    const allowed = name === "index.html" || name === "app.js";
    const file = join(dir, name);
    if (!allowed || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("read error");
    }
  });

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
        server.close(() => resolve());
      }),
  };
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
