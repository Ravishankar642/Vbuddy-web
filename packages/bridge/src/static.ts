import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
};

/**
 * Serves the built web client. Unknown paths without a file extension fall
 * back to index.html so client-side routes work.
 */
export function staticHandler(rootDir: string) {
  const root = resolve(rootDir);
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (req.method !== "GET" && req.method !== "HEAD") return false;
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
    } catch {
      return false;
    }
    const target = normalize(join(root, path));
    if (target !== root && !target.startsWith(root + sep)) return false; // path traversal

    let file = target;
    let st = await stat(file).catch(() => null);
    if (st?.isDirectory()) {
      file = join(file, "index.html");
      st = await stat(file).catch(() => null);
    }
    if (!st && extname(path) === "") {
      file = join(root, "index.html");
      st = await stat(file).catch(() => null);
    }
    if (!st?.isFile()) return false;

    const isHtml = file.endsWith(".html");
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      "content-length": st.size,
      // Vite puts hashes in asset names, so they can be cached forever; HTML must always be fresh.
      "cache-control": isHtml ? "no-cache" : file.includes(`${sep}assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    createReadStream(file).pipe(res);
    return true;
  };
}
