import { cleanHeaders, EFB_PREFIX, MAX_REQUEST_BODY, packBody, TUNNEL_ID_HEADER, TUNNEL_PATH, TUNNEL_VERSION, unpackBody, type BridgeToRelay, type RelayToBridge } from "@vbuddy/protocol";
import { request as httpRequest, type ClientRequest } from "node:http";
import { WebSocket } from "ws";
import type { Logger } from "../log.js";

/** Header the bridge's own server checks, so it knows a request came through the relay (and from where). */
export const RELAY_TAG_HEADER = "x-vbuddy-relay";
export const RELAY_REMOTE_HEADER = "x-vbuddy-remote";

const MIN_BACKOFF = 1000;
const MAX_BACKOFF = 30_000;
const PING_MS = 20_000;

export interface RelayClientOptions {
  /** wss://relay.example.com (or ws:// for tests) */
  url: string;
  /** This install's id (public) and key (secret), see identity.ts. */
  id: string;
  key: string;
  /** The bridge's own server on this PC. */
  localPort: number;
  /** Random per run; presented on every forwarded request so the server can tell relay traffic from loopback. */
  tag: string;
  name: string;
  log: Logger;
}

export type RelayState = "off" | "connecting" | "connected";

/**
 * Dials out to the relay and answers what it forwards by calling this bridge's own HTTP/WebSocket server.
 * Nothing here knows the VBuddy protocol; it only moves bytes and says who the browser really is.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private stopped = true;
  private backoff = MIN_BACKOFF;
  private retry: NodeJS.Timeout | null = null;
  private ping: NodeJS.Timeout | null = null;
  private alive = false;
  /** Requests that have a body coming, until the body has arrived. */
  private bodies = new Map<number, { msg: Extract<RelayToBridge, { k: "req" }>; chunks: Buffer[] }>();
  private reqs = new Map<number, ClientRequest>();
  private socks = new Map<number, WebSocket>();
  private stateCbs: Array<(s: RelayState) => void> = [];
  state: RelayState = "off";
  /** The last thing that went wrong, for the console window. */
  lastError = "";
  private lastErr = "";

  constructor(private o: RelayClientOptions) {}

  onState(cb: (s: RelayState) => void) {
    this.stateCbs.push(cb);
  }
  private setState(s: RelayState) {
    if (s === this.state) return;
    this.state = s;
    for (const cb of this.stateCbs) cb(s);
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.ping) clearInterval(this.ping);
    this.retry = this.ping = null;
    this.closeStreams();
    this.ws?.close(1000, "bridge stopping");
    this.ws = null;
    this.setState("off");
  }

  private closeStreams() {
    for (const r of this.reqs.values()) r.destroy();
    for (const s of this.socks.values()) s.terminate();
    this.reqs.clear();
    this.socks.clear();
    this.bodies.clear();
  }

  private send(m: BridgeToRelay) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private connect() {
    if (this.stopped) return;
    this.setState("connecting");
    const base = this.o.url.replace(/\/+$/, "");
    const ws = new WebSocket(base + TUNNEL_PATH, { headers: { authorization: `Bearer ${this.o.key}`, [TUNNEL_ID_HEADER]: this.o.id }, handshakeTimeout: 10_000 });
    this.ws = ws;
    ws.on("open", () => {
      this.alive = true;
      ws.send(JSON.stringify({ k: "hello", v: TUNNEL_VERSION, name: this.o.name } satisfies BridgeToRelay));
      this.ping = setInterval(() => {
        if (!this.alive) return ws.terminate();
        this.alive = false;
        ws.ping();
      }, PING_MS);
    });
    ws.on("pong", () => (this.alive = true));
    ws.on("message", (data, isBinary) => {
      this.alive = true;
      if (isBinary) {
        const b = unpackBody(Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]));
        const p = b ? this.bodies.get(b.id) : undefined;
        if (b && p && p.chunks.reduce((n, c) => n + c.length, 0) + b.body.length <= MAX_REQUEST_BODY) p.chunks.push(Buffer.from(b.body));
        return;
      }
      let m: RelayToBridge;
      try {
        m = JSON.parse(data.toString()) as RelayToBridge;
      } catch {
        return;
      }
      this.onMessage(m);
    });
    ws.on("unexpected-response", (_req, res) => {
      this.note(res.statusCode === 401 ? "the relay refused this PC (its ID belongs to another key, or there were too many attempts)" : `the relay answered HTTP ${res.statusCode}`);
    });
    ws.on("error", (e) => this.note(e.message));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      this.closeStreams();
      if (this.state === "connected") this.o.log.info("Relay connection lost; reconnecting");
      this.setState("connecting");
      if (this.stopped) return;
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(MAX_BACKOFF, this.backoff * 2);
    });
  }

  private note(msg: string) {
    if (msg !== this.lastErr) this.o.log.warn(`Relay: ${msg}`);
    this.lastErr = msg;
    this.lastError = msg;
  }

  private onMessage(m: RelayToBridge) {
    switch (m.k) {
      case "ready":
        this.backoff = MIN_BACKOFF;
        this.lastErr = "";
        this.lastError = "";
        this.o.log.info(`Relay connected: ${this.o.url}`);
        this.setState("connected");
        return;
      case "req":
        // A request with a body waits for its body (binary frames), then goes on at reqEnd.
        if (m.body) {
          this.bodies.set(m.id, { msg: m, chunks: [] });
          return;
        }
        return this.forwardHttp(m);
      case "reqEnd": {
        const p = this.bodies.get(m.id);
        this.bodies.delete(m.id);
        if (p) this.forwardHttp(p.msg, Buffer.concat(p.chunks));
        return;
      }
      case "reqAbort":
        this.reqs.get(m.id)?.destroy();
        this.reqs.delete(m.id);
        this.bodies.delete(m.id);
        return;
      case "wsOpen":
        return this.forwardSocket(m);
      case "wsMsg":
        if (this.socks.get(m.id)?.readyState === WebSocket.OPEN) m.bin ? this.socks.get(m.id)!.send(Buffer.from(m.data, "base64")) : this.socks.get(m.id)!.send(m.data);
        return;
      case "wsClose": {
        const s = this.socks.get(m.id);
        this.socks.delete(m.id);
        s?.close(m.code >= 1000 && m.code < 5000 && m.code !== 1005 && m.code !== 1006 ? m.code : 1000);
        return;
      }
    }
  }

  private forwardHttp(m: Extract<RelayToBridge, { k: "req" }>, body?: Buffer) {
    // Only the Fenix EFB's own pages may use more than GET; everything else is read-only through the relay.
    const method = m.url.startsWith(EFB_PREFIX) && ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(m.method) ? m.method : m.method === "HEAD" ? "HEAD" : "GET";
    const req = httpRequest(
      { host: "127.0.0.1", port: this.o.localPort, method, path: m.url, headers: { ...cleanHeaders(m.headers), [RELAY_TAG_HEADER]: this.o.tag, [RELAY_REMOTE_HEADER]: m.ip } },
      (res) => {
        const h: Record<string, string> = {};
        for (const [k, v] of Object.entries(cleanHeaders(res.headers))) h[k] = v;
        this.send({ k: "res", id: m.id, status: res.statusCode ?? 502, headers: h });
        res.on("data", (chunk: Buffer) => {
          if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(packBody(m.id, chunk));
        });
        res.on("end", () => {
          this.reqs.delete(m.id);
          this.send({ k: "resEnd", id: m.id });
        });
      },
    );
    this.reqs.set(m.id, req);
    req.on("error", (e) => {
      if (this.reqs.delete(m.id)) this.send({ k: "resErr", id: m.id, message: e.message });
    });
    req.end(body && body.length ? body : undefined);
  }

  private forwardSocket(m: Extract<RelayToBridge, { k: "wsOpen" }>) {
    const ws = new WebSocket(`ws://127.0.0.1:${this.o.localPort}${m.url}`, m.protocols ? m.protocols.split(",").map((x) => x.trim()).filter(Boolean) : undefined, { headers: { ...cleanHeaders(m.headers), [RELAY_TAG_HEADER]: this.o.tag, [RELAY_REMOTE_HEADER]: m.ip } });
    this.socks.set(m.id, ws);
    ws.on("open", () => this.send({ k: "wsOpened", id: m.id }));
    ws.on("message", (data, isBinary) => {
      if (!isBinary) this.send({ k: "wsMsg", id: m.id, data: data.toString() });
      else if (m.url.startsWith(EFB_PREFIX)) this.send({ k: "wsMsg", id: m.id, data: (Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])).toString("base64"), bin: true });
    });
    const done = (code: number) => {
      if (this.socks.get(m.id) === ws) {
        this.socks.delete(m.id);
        this.send({ k: "wsClose", id: m.id, code });
      }
    };
    ws.on("close", (code) => done(code));
    ws.on("error", () => done(1011));
  }
}
