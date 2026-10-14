import {
  cleanHeaders,
  EFB_PREFIX,
  isBridgeId,
  isBridgeKey,
  MAX_REQUEST_BODY,
  packBody,
  ROUTE_COOKIE,
  ROUTE_PARAM,
  TUNNEL_ID_HEADER,
  TUNNEL_PATH,
  TUNNEL_VERSION,
  unpackBody,
  WS_PATH,
  type BridgeToRelay,
  type RelayToBridge,
} from "@vbuddy/protocol";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { logger } from "./log.js";

const log = logger("relay");

const HTTP_TIMEOUT_MS = 30_000;
const WS_OPEN_TIMEOUT_MS = 10_000;
const PING_MS = 20_000;
const MAX_QUEUED = 50;
const AUTH_FAIL_LIMIT = 10;
const AUTH_FAIL_WINDOW_MS = 60_000;
const REGISTER_LIMIT = 10;
const REGISTER_WINDOW_MS = 3_600_000;
const FORGET_AFTER_MS = 120 * 24 * 3_600_000;
const COOKIE_MAX_AGE_S = 365 * 24 * 3600;
const EFB_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

export interface RelayOptions {
  host: string;
  port: number;
  /** Behind a TLS proxy on this machine (Caddy): take the browser's address from X-Forwarded-For. */
  trustProxy: boolean;
  /** Where the known bridges (id -> hash of its key) are kept. null = memory only. */
  registryFile?: string | null;
  /** How many different bridges may be registered. */
  maxBridges?: number;
  /** Per bridge. */
  maxHttp?: number;
  maxSockets?: number;
  /** New bridges one address may register per hour. */
  registerPerHour?: number;
}

export interface Relay {
  http: Server;
  port(): number;
  /** With an id: is that bridge connected. Without: is any. */
  bridgeConnected(id?: string): boolean;
  bridgeCount(): number;
  registeredCount(): number;
  close(): Promise<void>;
}

const sha = (s: string) => createHash("sha256").update(s).digest();
const isLoopback = (a: string) => a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";

type HttpStream = { kind: "http"; res: ServerResponse; started: boolean; timer: NodeJS.Timeout };
type WsStream = { kind: "ws"; ws: WebSocket; opened: boolean; queue: Array<Extract<RelayToBridge, { k: "wsMsg" }>>; timer: NodeJS.Timeout };
interface Tunnel {
  id: string;
  ws: WebSocket;
  alive: boolean;
  streams: Map<number, HttpStream | WsStream>;
}
interface Known {
  /** base64 of sha256(key) */
  hash: string;
  seen: number;
}

function cookieOf(req: IncomingMessage, name: string): string | null {
  for (const part of String(req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

const PAGE_STYLE = `font:16px system-ui;background:#0b1118;color:#dbe4ee;padding:2rem;max-width:32rem;margin:auto`;
const head = (title: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>`;

export function startRelay(opts: RelayOptions): Promise<Relay> {
  const maxHttp = opts.maxHttp ?? 64;
  const maxSockets = opts.maxSockets ?? 16;
  const maxBridges = opts.maxBridges ?? 5000;
  const registerPerHour = opts.registerPerHour ?? REGISTER_LIMIT;
  const registryFile = opts.registryFile ?? null;

  const known = new Map<string, Known>();
  if (registryFile && existsSync(registryFile)) {
    try {
      const raw = JSON.parse(readFileSync(registryFile, "utf8")) as Record<string, Known>;
      const now = Date.now();
      for (const [id, k] of Object.entries(raw)) {
        if (isBridgeId(id) && typeof k?.hash === "string" && now - (k.seen ?? 0) < FORGET_AFTER_MS) known.set(id, { hash: k.hash, seen: k.seen ?? now });
      }
    } catch (e) {
      log.warn(`Could not read ${registryFile} (${(e as Error).message}); starting with no known bridges`);
    }
  }
  let saveTimer: NodeJS.Timeout | null = null;
  const save = () => {
    if (!registryFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        mkdirSync(dirname(registryFile), { recursive: true });
        const tmp = registryFile + ".tmp";
        writeFileSync(tmp, JSON.stringify(Object.fromEntries(known)), { mode: 0o600 });
        renameSync(tmp, registryFile);
      } catch (e) {
        log.warn(`Could not save ${registryFile}: ${(e as Error).message}`);
      }
    }, 500);
    saveTimer.unref();
  };

  const tunnels = new Map<string, Tunnel>();
  let nextId = 1;
  const authFails = new Map<string, { n: number; since: number }>();
  const registrations = new Map<string, number[]>();

  const clientIp = (req: IncomingMessage): string => {
    const sock = req.socket.remoteAddress ?? "?";
    if (opts.trustProxy && isLoopback(sock)) {
      const parts = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      // The last entry is the one our own proxy added; earlier ones came from the browser and can be made up.
      if (parts.length) return parts[parts.length - 1]!;
    }
    return sock;
  };
  const isHttps = (req: IncomingMessage) => opts.trustProxy && isLoopback(req.socket.remoteAddress ?? "") && String(req.headers["x-forwarded-proto"] ?? "") === "https";

  const sendTunnel = (t: Tunnel, m: RelayToBridge) => {
    if (t.ws.readyState === WebSocket.OPEN) t.ws.send(JSON.stringify(m));
  };

  const endStream = (t: Tunnel, id: number, why: string) => {
    const s = t.streams.get(id);
    if (!s) return;
    t.streams.delete(id);
    clearTimeout(s.timer);
    if (s.kind === "http") {
      if (!s.started) {
        s.res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        s.res.end(`VBuddy relay: ${why}`);
      } else s.res.destroy();
    } else s.ws.close(1011, why.slice(0, 100));
  };

  const failAll = (t: Tunnel, why: string) => {
    for (const id of [...t.streams.keys()]) endStream(t, id, why);
  };

  const countKind = (t: Tunnel, kind: "http" | "ws") => {
    let n = 0;
    for (const s of t.streams.values()) if (s.kind === kind) n++;
    return n;
  };

  const offlinePage = (res: ServerResponse) => {
    res.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "retry-after": "10" });
    res.end(
      head("VBuddy") +
        `<body style="${PAGE_STYLE}"><h1>Your simulator PC isn't connected</h1>` +
        `<p>Start VBuddy on your PC and make sure <b>Cloud relay</b> is switched on in its window, then reload this page.</p>` +
        `<p style="opacity:.7">Using a different PC or phone link? <a style="color:#7cc4ff" href="/?forget=1">Enter another ID</a></p>`,
    );
  };

  const idPage = (res: ServerResponse, note = "") => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": `${ROUTE_COOKIE}=; Max-Age=0; Path=/` });
    res.end(
      head("VBuddy") +
        `<body style="${PAGE_STYLE}"><h1>VBuddy</h1><p>Enter the <b>phone link ID</b> shown in the VBuddy window on your PC (12 letters and numbers), or scan the QR code there.</p>` +
        (note ? `<p style="color:#ff9d9d">${note}</p>` : "") +
        `<form method="get" action="/"><input name="${ROUTE_PARAM}" autocapitalize="none" autocomplete="off" spellcheck="false" maxlength="12" placeholder="abcd2345wxyz" style="font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin:.5rem 0;border-radius:8px;border:1px solid #345;background:#101a24;color:inherit">` +
        `<button style="font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:0;background:#2d7be5;color:#fff">Connect</button></form>`,
    );
  };

  const http = createServer((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (url === "/relay/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, bridges: tunnels.size }));
      return;
    }
    if (url.startsWith("/relay/")) {
      res.writeHead(404).end();
      return;
    }
    const isEfb = url.startsWith(EFB_PREFIX);
    if (req.method !== "GET" && req.method !== "HEAD" && !(isEfb && EFB_METHODS.has(req.method ?? ""))) {
      res.writeHead(405, { allow: isEfb ? [...EFB_METHODS].join(", ") : "GET, HEAD" }).end();
      return;
    }
    const u = new URL(url, "http://x");
    // The phone link carries the id once; after that a cookie routes everything (assets, the API, the WebSocket).
    if (u.searchParams.has(ROUTE_PARAM) || u.searchParams.has("forget")) {
      const wanted = (u.searchParams.get(ROUTE_PARAM) ?? "").trim().toLowerCase();
      if (u.searchParams.has("forget") && !wanted) return idPage(res);
      if (!isBridgeId(wanted)) return idPage(res, "That ID doesn't look right. It is 12 letters and numbers.");
      u.searchParams.delete(ROUTE_PARAM);
      const secure = isHttps(req) ? "; Secure" : "";
      res.writeHead(302, {
        location: u.pathname + u.search,
        "set-cookie": `${ROUTE_COOKIE}=${wanted}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure}`,
        "cache-control": "no-store",
      });
      res.end();
      return;
    }
    const id = cookieOf(req, ROUTE_COOKIE);
    if (!isBridgeId(id)) {
      if (u.pathname === "/" || u.pathname === "/index.html") return idPage(res);
      res.writeHead(404).end();
      return;
    }
    const t = tunnels.get(id);
    if (!t || t.ws.readyState !== WebSocket.OPEN) return offlinePage(res);
    if (countKind(t, "http") >= maxHttp) {
      res.writeHead(503, { "retry-after": "5" }).end("busy");
      return;
    }
    const sid = nextId++;
    const timer = setTimeout(() => endStream(t, sid, "the bridge didn't answer in time"), HTTP_TIMEOUT_MS);
    t.streams.set(sid, { kind: "http", res, started: false, timer });
    res.on("close", () => {
      if (t.streams.delete(sid)) {
        clearTimeout(timer);
        sendTunnel(t, { k: "reqAbort", id: sid });
      }
    });
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
    sendTunnel(t, { k: "req", id: sid, method: req.method!, url, headers: cleanHeaders(req.headers, (n) => n === "cookie"), ip: clientIp(req), ...(hasBody ? { body: true } : {}) });
    if (hasBody) {
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_REQUEST_BODY) {
          req.destroy();
          endStream(t, sid, "that request is too large");
          return;
        }
        if (t.ws.readyState === WebSocket.OPEN) t.ws.send(packBody(sid, chunk));
      });
      req.on("end", () => sendTunnel(t, { k: "reqEnd", id: sid }));
    }
  });

  const tunnelWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const clientWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  // The EFB's own socket carries more (and binary messages); it is passed as base64.
  const efbWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  /** Checks a bridge's id and key; a new id is registered with that key (first come, first served; the key is what owns it). */
  const authBridge = (req: IncomingMessage): string | null => {
    const ip = clientIp(req);
    const now = Date.now();
    const f = authFails.get(ip);
    if (f && now - f.since < AUTH_FAIL_WINDOW_MS && f.n >= AUTH_FAIL_LIMIT) return null;
    const fail = (why: string) => {
      const cur = f && now - f.since < AUTH_FAIL_WINDOW_MS ? f : { n: 0, since: now };
      authFails.set(ip, { n: cur.n + 1, since: cur.since });
      log.warn(`Rejected a tunnel connection from ${ip} (${why})`);
      return null;
    };
    const id = req.headers[TUNNEL_ID_HEADER];
    const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""));
    const key = m?.[1];
    if (!isBridgeId(id) || !isBridgeKey(key)) return fail("missing or malformed id/key");
    const hash = sha(key);
    const k = known.get(id);
    if (k) {
      if (!timingSafeEqual(hash, Buffer.from(k.hash, "base64"))) return fail("wrong key for that id");
      k.seen = now;
      save();
    } else {
      if (known.size >= maxBridges) return fail("relay is full");
      const recent = (registrations.get(ip) ?? []).filter((x) => now - x < REGISTER_WINDOW_MS);
      if (recent.length >= registerPerHour) return fail("too many new bridges from this address");
      recent.push(now);
      registrations.set(ip, recent);
      known.set(id, { hash: hash.toString("base64"), seen: now });
      save();
      log.info(`New bridge registered: ${id} (${known.size} known)`);
    }
    authFails.delete(ip);
    return id;
  };

  http.on("upgrade", (req, socket, head) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === TUNNEL_PATH) {
      const id = authBridge(req);
      if (!id) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n");
        return;
      }
      tunnelWss.handleUpgrade(req, socket, head, (ws) => onTunnel(id, ws, clientIp(req)));
      return;
    }
    if (path === WS_PATH || path.startsWith(EFB_PREFIX)) {
      const id = cookieOf(req, ROUTE_COOKIE);
      const t = isBridgeId(id) ? tunnels.get(id) : undefined;
      if (!t || countKind(t, "ws") >= maxSockets) {
        socket.end(`HTTP/1.1 503 Service Unavailable\r\nconnection: close\r\n\r\n`);
        return;
      }
      const ip = clientIp(req);
      const headers = cleanHeaders(req.headers, (n) => n === "cookie");
      const url = req.url ?? WS_PATH;
      const protocols = String(req.headers["sec-websocket-protocol"] ?? "").slice(0, 200); // cleanHeaders drops sec-websocket-*; the EFB may want the same ones
      (path === WS_PATH ? clientWss : efbWss).handleUpgrade(req, socket, head, (ws) => onClientSocket(t, ws, ip, url, headers, protocols));
      return;
    }
    socket.destroy();
  });

  function onTunnel(id: string, ws: WebSocket, ip: string) {
    const old = tunnels.get(id);
    if (old) {
      log.info(`A new connection replaces the old one for ${id}`);
      failAll(old, "the bridge reconnected");
      old.ws.close(4000, "replaced");
    }
    const t: Tunnel = { id, ws, alive: true, streams: new Map() };
    tunnels.set(id, t);
    ws.on("pong", () => (t.alive = true));
    ws.on("message", (data: RawData, isBinary) => {
      t.alive = true;
      if (isBinary) {
        const b = unpackBody(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
        const s = b ? t.streams.get(b.id) : undefined;
        if (b && s?.kind === "http" && s.started) s.res.write(b.body);
        return;
      }
      let m: BridgeToRelay;
      try {
        m = JSON.parse(data.toString()) as BridgeToRelay;
      } catch {
        return;
      }
      if (m.k === "hello") {
        log.info(`Bridge ${id} connected from ${ip} (${String(m.name).slice(0, 40)})`);
        ws.send(JSON.stringify({ k: "ready", v: TUNNEL_VERSION } satisfies RelayToBridge));
        return;
      }
      const s = t.streams.get(m.id);
      if (!s) return;
      if (m.k === "res" && s.kind === "http") {
        s.started = true;
        s.res.writeHead(m.status, cleanHeaders(m.headers));
      } else if (m.k === "resEnd" && s.kind === "http") {
        t.streams.delete(m.id);
        clearTimeout(s.timer);
        s.res.end();
      } else if (m.k === "resErr") endStream(t, m.id, m.message);
      else if (m.k === "wsOpened" && s.kind === "ws") {
        s.opened = true;
        clearTimeout(s.timer);
        for (const q of s.queue) sendTunnel(t, { ...q, id: m.id });
        s.queue.length = 0;
      } else if (m.k === "wsMsg" && s.kind === "ws") {
        if (s.ws.readyState === WebSocket.OPEN) m.bin ? s.ws.send(Buffer.from(m.data, "base64")) : s.ws.send(m.data);
      } else if (m.k === "wsClose" && s.kind === "ws") {
        t.streams.delete(m.id);
        clearTimeout(s.timer);
        s.ws.close(m.code >= 1000 && m.code < 5000 && m.code !== 1005 && m.code !== 1006 ? m.code : 1000);
      }
    });
    ws.on("close", () => {
      if (tunnels.get(id) !== t) return;
      tunnels.delete(id);
      log.info(`Bridge ${id} disconnected`);
      failAll(t, "the bridge went away");
    });
    ws.on("error", () => {});
  }

  function onClientSocket(t: Tunnel, ws: WebSocket, ip: string, url: string, headers: Record<string, string>, protocols: string) {
    const id = nextId++;
    const timer = setTimeout(() => endStream(t, id, "the bridge didn't accept the connection"), WS_OPEN_TIMEOUT_MS);
    const st: WsStream = { kind: "ws", ws, opened: false, queue: [], timer };
    t.streams.set(id, st);
    ws.on("message", (data, isBinary) => {
      const text = isBinary ? (Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])).toString("base64") : data.toString();
      const m: Extract<RelayToBridge, { k: "wsMsg" }> = { k: "wsMsg", id, data: text, ...(isBinary ? { bin: true } : {}) };
      if (!st.opened) {
        if (st.queue.length < MAX_QUEUED) st.queue.push(m);
      } else sendTunnel(t, m);
    });
    ws.on("close", (code) => {
      if (t.streams.delete(id)) {
        clearTimeout(timer);
        sendTunnel(t, { k: "wsClose", id, code });
      }
    });
    ws.on("error", () => {});
    sendTunnel(t, { k: "wsOpen", id, url, headers, ip, ...(protocols ? { protocols } : {}) });
  }

  const beat = setInterval(() => {
    for (const t of tunnels.values()) {
      if (!t.alive) {
        log.warn(`Bridge ${t.id} stopped answering; dropping the tunnel`);
        t.ws.terminate();
        continue;
      }
      t.alive = false;
      t.ws.ping();
      for (const s of t.streams.values()) if (s.kind === "ws" && s.ws.readyState === WebSocket.OPEN) s.ws.ping();
    }
    const now = Date.now();
    for (const [k, v] of authFails) if (now - v.since > AUTH_FAIL_WINDOW_MS) authFails.delete(k);
    for (const [k, v] of registrations) {
      const keep = v.filter((x) => now - x < REGISTER_WINDOW_MS);
      if (keep.length) registrations.set(k, keep);
      else registrations.delete(k);
    }
    let dropped = false;
    for (const [id, k] of known) {
      if (!tunnels.has(id) && now - k.seen > FORGET_AFTER_MS) {
        known.delete(id);
        dropped = true;
      }
    }
    if (dropped) save();
  }, PING_MS);
  beat.unref();

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(opts.port, opts.host, () => {
      http.off("error", reject);
      const addr = http.address();
      resolve({
        http,
        port: () => (typeof addr === "object" && addr ? addr.port : opts.port),
        bridgeConnected: (id) => (id ? tunnels.has(id) : tunnels.size > 0),
        bridgeCount: () => tunnels.size,
        registeredCount: () => known.size,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(beat);
            if (saveTimer) {
              clearTimeout(saveTimer);
              saveTimer = null;
              if (registryFile) {
                try {
                  mkdirSync(dirname(registryFile), { recursive: true });
                  writeFileSync(registryFile, JSON.stringify(Object.fromEntries(known)), { mode: 0o600 });
                } catch {
                  /* best effort */
                }
              }
            }
            for (const t of tunnels.values()) {
              failAll(t, "relay shutting down");
              t.ws.close(1001, "relay shutting down");
            }
            for (const c of clientWss.clients) c.close(1001, "relay shutting down");
            http.close(() => done());
            http.closeAllConnections();
          }),
      });
    });
  });
}
