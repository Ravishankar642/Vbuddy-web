import { WebSocket } from "ws";
import type { Logger } from "../log.js";

/**
 * ChasePlane's local API (ChasePlane for MSFS 2024 runs a WebSocket on this PC). The message shapes follow the
 * open-source ComSpotter project (github.com/sw-jannik/comspotter, MIT), which uses the same API:
 *   -> {"message":"api_connect","payload":{"client_name":"..."}}
 *   -> {"message":"api_request","request_id":"...","command":"get_views" | "set_view_by_guid","payload":{...}}
 *   <- {"message":"api_reply","request_id":"...","status":200,"payload":{...}}
 *   <- {"message":"airport_changed","payload":{"activeIdent":"EGLL"}}
 * get_views replies with payload.payload.views: [{ guid, name, icao, profile_theme, skip_cycle, position: { x: lon, y: alt, z: lat } }].
 */
export const CHASEPLANE_URL = "ws://127.0.0.1:8652/";
const REQUEST_TIMEOUT_MS = 5000;
const CONNECT_TIMEOUT_MS = 2500;

export interface ChaseView {
  guid: string;
  name: string;
  /** ChasePlane's profile theme, e.g. WORLD_TOWER for airport views. */
  theme: string;
  icao: string;
  lat: number | null;
  lon: number | null;
  skipCycle: boolean;
}

export interface ChasePlaneLink {
  views(): Promise<{ views: ChaseView[]; airport: string | null }>;
  setView(guid: string): Promise<void>;
  close(): void;
}

interface Reply {
  status: number;
  payload: unknown;
}

export class ChasePlaneClient implements ChasePlaneLink {
  private ws: WebSocket | null = null;
  private opening: Promise<WebSocket> | null = null;
  private pending = new Map<string, (r: Reply | Error) => void>();
  private counter = 0;
  private airport: string | null = null;

  constructor(
    private log: Logger,
    private url = CHASEPLANE_URL,
  ) {}

  private connect(): Promise<WebSocket> {
    if (this.ws?.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
    if (this.opening) return this.opening;
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: CONNECT_TIMEOUT_MS });
      const fail = (e: Error) => {
        this.opening = null;
        reject(e);
      };
      ws.once("error", (e) => fail(new Error(/ECONNREFUSED/.test(e.message) ? "ChasePlane isn't running (or its connection to the simulator isn't up)." : `Couldn't reach ChasePlane: ${e.message}`)));
      ws.once("open", () => {
        this.ws = ws;
        this.opening = null;
        ws.on("error", () => {});
        ws.send(JSON.stringify({ message: "api_connect", payload: { client_name: "vbuddy" } }));
        this.log.info("ChasePlane: connected");
        resolve(ws);
      });
      ws.on("message", (d) => this.onMessage(d.toString()));
      ws.on("close", () => {
        if (this.ws === ws) this.ws = null;
        for (const done of this.pending.values()) done(new Error("ChasePlane closed the connection."));
        this.pending.clear();
      });
    });
    return this.opening;
  }

  private onMessage(text: string) {
    let m: { message?: string; request_id?: string; status?: number; payload?: { activeIdent?: string } & Record<string, unknown> };
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.message === "api_reply" && typeof m.request_id === "string") {
      const done = this.pending.get(m.request_id);
      this.pending.delete(m.request_id);
      done?.({ status: Number(m.status ?? 0), payload: m.payload });
    } else if (m.message === "airport_changed" && typeof m.payload?.activeIdent === "string" && m.payload.activeIdent) {
      this.airport = m.payload.activeIdent.toUpperCase();
    }
  }

  private async request(command: string, payload: object): Promise<Reply> {
    const ws = await this.connect();
    const id = `${command}_${Date.now()}_${++this.counter}`;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("ChasePlane didn't answer."));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        if (r instanceof Error) reject(r);
        else resolve(r);
      });
      ws.send(JSON.stringify({ message: "api_request", request_id: id, command, payload }));
    });
  }

  async views(): Promise<{ views: ChaseView[]; airport: string | null }> {
    const r = await this.request("get_views", {});
    if (r.status !== 200) throw new Error(`ChasePlane refused the view list (${r.status}).`);
    return { views: parseViews(r.payload), airport: this.airport };
  }

  async setView(guid: string): Promise<void> {
    const r = await this.request("set_view_by_guid", { guid });
    if (r.status !== 200) throw new Error(r.status === 404 ? "ChasePlane doesn't have that view any more. Refresh the list." : `ChasePlane didn't switch (${r.status}).`);
  }

  close() {
    this.ws?.close();
    this.ws = null;
  }
}

/** The reply's payload carries its own { message: "get_views", payload: { views } } (as ComSpotter parses it); a bare { views } is accepted too. */
export function parseViews(payload: unknown): ChaseView[] {
  const p = payload as { payload?: { views?: unknown }; views?: unknown } | null;
  const raw = (Array.isArray(p?.payload?.views) ? p!.payload!.views : Array.isArray(p?.views) ? p!.views : []) as Array<Record<string, unknown>>;
  const out: ChaseView[] = [];
  for (const v of raw) {
    if (typeof v.guid !== "string" || !v.guid) continue;
    const pos = (v.position ?? {}) as { x?: unknown; z?: unknown };
    out.push({
      guid: v.guid,
      name: typeof v.name === "string" && v.name.trim() ? v.name.trim() : "Unnamed view",
      theme: typeof v.profile_theme === "string" ? v.profile_theme : "",
      icao: typeof v.icao === "string" ? v.icao.toUpperCase() : "",
      lat: typeof pos.z === "number" ? pos.z : null,
      lon: typeof pos.x === "number" ? pos.x : null,
      skipCycle: v.skip_cycle === true,
    });
  }
  return out;
}

/** The test flight: a few made-up views so the page can be tried without the simulator. */
export class MockChasePlane implements ChasePlaneLink {
  current = "";
  async views() {
    return {
      airport: "EGLL",
      views: [
        { guid: "m1", name: "Captain", theme: "", icao: "", lat: null, lon: null, skipCycle: false },
        { guid: "m2", name: "Overhead", theme: "", icao: "", lat: null, lon: null, skipCycle: false },
        { guid: "m3", name: "Left wing", theme: "", icao: "", lat: null, lon: null, skipCycle: false },
        { guid: "m4", name: "Tower 27L", theme: "WORLD_TOWER", icao: "EGLL", lat: 51.4706, lon: -0.4619, skipCycle: false },
      ],
    };
  }
  async setView(guid: string) {
    this.current = guid;
  }
  close() {}
}
