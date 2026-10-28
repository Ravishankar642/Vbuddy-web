import { AIRBUS_MCDU_KEYS, type CduScreen } from "@vbuddy/protocol";
import { WebSocket } from "ws";
import type { Logger } from "../log.js";
import type { PanelResult } from "../panel/backend.js";
import { C, Grid, plain, type Cell } from "./grid.js";
import type { FmsProvider } from "./hub.js";

/*
 * The FlyByWire A32NX MCDU (and aircraft built on it, like the Headwind A339X) through FlyByWire SimBridge's remote MCDU
 * socket, ws://127.0.0.1:8380/interfaces/v1/mcdu. SimBridge passes every message to every client: the aircraft sends
 * "update:<json>" with both screens (and "mcduConnected" when it joins), a client asks with "requestUpdate" and presses a
 * key with "event:left:<KEY>" or "event:right:<KEY>".
 */

/** One side's screen as the A32NX sends it: 12 lines of [left, right, centre] text with inline {colour} / {small} tags. */
export interface FbwSide {
  lines: string[][];
  scratchpad: string;
  title: string;
  titleLeft: string;
  page: string;
  /** Up, down, left, right. */
  arrows: boolean[];
}

const TAG_COLOR: Record<string, number> = { white: C.white, cyan: C.cyan, green: C.green, amber: C.amber, magenta: C.magenta, red: C.red, yellow: C.yellow, inop: C.grey };

/**
 * FlyByWire's inline markup to styled characters. {green} etc. open a colour, {small} / {big} a font size, {sp} is a
 * space, {left} / {right} are alignment hints (ignored: the column decides) and {end} closes the latest one.
 */
export function fbwCells(text: string, small = false): Cell[] {
  const out: Cell[] = [];
  const stack: Array<{ color?: number; small?: boolean }> = [];
  const cur = () => {
    let color: number = C.white;
    let sm = small;
    for (const s of stack) {
      if (s.color !== undefined) color = s.color;
      if (s.small !== undefined) sm = s.small;
    }
    return { color, small: sm };
  };
  const re = /\{([a-z]+)\}/g;
  let last = 0;
  const pushText = (s: string) => {
    const st = cur();
    for (const ch of s) out.push({ ch, ...st });
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    pushText(text.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[1]!;
    if (tag === "end") stack.pop();
    else if (tag === "sp") pushText(" ");
    else if (tag === "small") stack.push({ small: true });
    else if (tag === "big") stack.push({ small: false });
    else if (TAG_COLOR[tag] !== undefined) stack.push({ color: TAG_COLOR[tag] });
    else if (tag === "left" || tag === "right") stack.push({});
  }
  pushText(text.slice(last));
  return out;
}

/** An A32NX screen in the 24 x 14 grid: title row, 12 lines (label lines in the small font), scratchpad. */
export function fbwScreen(side: FbwSide | null, which: 0 | 1, message: string | null): CduScreen {
  const g = new Grid();
  if (side) {
    g.place(0, fbwCells(side.titleLeft ?? ""), "left");
    g.place(0, fbwCells(side.title ?? ""), "center");
    g.place(0, fbwCells(side.page ?? ""), "right");
    for (let i = 0; i < 12; i++) {
      const l = side.lines?.[i] ?? ["", "", ""];
      const small = i % 2 === 0;
      g.place(i + 1, fbwCells(l[2] ?? "", small), "center");
      g.place(i + 1, fbwCells(l[0] ?? "", small), "left");
      g.place(i + 1, fbwCells(l[1] ?? "", small), "right");
    }
    g.place(13, fbwCells(side.scratchpad ?? ""), "left");
    const [up, down, left, right] = side.arrows ?? [];
    if (left && g.free(0, 22)) g.put(0, 22, plain("←"));
    if (right && g.free(0, 23)) g.put(0, 23, plain("→"));
    if (down && g.free(13, 22)) g.put(13, 22, plain("↓"));
    if (up && g.free(13, 23)) g.put(13, 23, plain("↑"));
  }
  return {
    aircraft: "a32nx",
    layout: "airbus",
    name: "FlyByWire MCDU",
    side: which,
    sides: 2,
    live: !!side,
    powered: !!side,
    ...g.out(),
    annun: { exec: false, msg: false, fail: false, ofst: false, call: false, dspy: false },
    keys: [...AIRBUS_MCDU_KEYS],
    message: side ? null : message,
  };
}

/** VBuddy's Airbus key names to FlyByWire's. */
const FBW_KEY: Record<string, string> = { RAD_NAV: "RAD", FUEL_PRED: "FUEL", SEC_FPLN: "SEC", ATC_COM: "ATC", PREV_PAGE: "PREVPAGE", NEXT_PAGE: "NEXTPAGE", PLUS_MINUS: "PLUSMINUS", SLASH: "DIV", SPACE: "SP" };
export const fbwKey = (k: string) => FBW_KEY[k] ?? k;

const NOT_RUNNING =
  "FlyByWire SimBridge isn't running on this PC. Start it (FlyByWire Installer → SimBridge), and in the aircraft's EFB set Settings → Sim Options → SimBridge to Enabled.";
const NO_AIRCRAFT = "SimBridge is running, but the aircraft hasn't sent its MCDU yet. In the EFB: Settings → Sim Options → SimBridge: Enabled.";

/** The FlyByWire MCDU through SimBridge. Connects only while this aircraft is loaded. */
export class SimBridgeMcdu implements FmsProvider {
  readonly label = "FlyByWire MCDU";
  private ws: WebSocket | null = null;
  private screens: [FbwSide | null, FbwSide | null] = [null, null];
  private cbs: Array<(side: number) => void> = [];
  private retry: NodeJS.Timeout | null = null;
  private backoff = 2000;
  private wanted = false;
  private lastJson = ["", ""];

  constructor(
    private log: Logger,
    private url = `ws://127.0.0.1:${Number(process.env.VBUDDY_SIMBRIDGE_PORT) || 8380}/interfaces/v1/mcdu`,
    private makeSocket: (url: string) => WebSocket = (u) => new WebSocket(u),
  ) {}

  sides() {
    return 2;
  }
  onCdu(cb: (side: number) => void) {
    this.cbs.push(cb);
  }

  setActive(on: boolean) {
    if (on === this.wanted) return;
    this.wanted = on;
    if (on) this.connect();
    else {
      if (this.retry) clearTimeout(this.retry);
      this.retry = null;
      this.ws?.close();
      this.ws = null;
      this.screens = [null, null];
    }
  }

  private connect() {
    if (!this.wanted || this.ws) return;
    let ws: WebSocket;
    try {
      ws = this.makeSocket(this.url);
    } catch {
      return this.later();
    }
    this.ws = ws;
    ws.on("open", () => {
      this.backoff = 2000;
      this.log.info("FlyByWire SimBridge: connected to the remote MCDU socket");
      ws.send("requestUpdate");
    });
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clear();
      this.later();
    });
    ws.on("error", () => {
      /* close follows */
    });
  }

  private later() {
    if (!this.wanted || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.backoff);
    this.backoff = Math.min(30_000, this.backoff * 2);
  }

  private clear() {
    if (!this.screens[0] && !this.screens[1]) return;
    this.screens = [null, null];
    this.lastJson = ["", ""];
    for (const cb of this.cbs) {
      cb(0);
      cb(1);
    }
  }

  /** Exposed for tests: one message from SimBridge. */
  onMessage(text: string) {
    if (text === "mcduConnected") {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("requestUpdate");
      return;
    }
    if (text === "mcduDisconnected") return this.clear();
    if (!text.startsWith("update:")) return;
    let j: { left?: FbwSide; right?: FbwSide };
    try {
      j = JSON.parse(text.slice("update:".length)) as typeof j;
    } catch {
      return;
    }
    (["left", "right"] as const).forEach((k, i) => {
      const s = j[k];
      if (!s) return;
      const json = JSON.stringify(s);
      if (json === this.lastJson[i]) return;
      this.lastJson[i] = json;
      this.screens[i] = s;
      for (const cb of this.cbs) cb(i);
    });
  }

  screen(side: number): CduScreen {
    const s = side === 1 ? 1 : 0;
    const connected = this.ws?.readyState === WebSocket.OPEN;
    return fbwScreen(this.screens[s], s, connected ? NO_AIRCRAFT : NOT_RUNNING);
  }

  async key(side: number, key: string): Promise<PanelResult> {
    if (!(AIRBUS_MCDU_KEYS as readonly string[]).includes(key)) return { ok: false, error: `The MCDU has no ${key} key.` };
    if (this.ws?.readyState !== WebSocket.OPEN) return { ok: false, error: NOT_RUNNING };
    this.ws.send(`event:${side === 1 ? "right" : "left"}:${fbwKey(key)}`);
    return { ok: true };
  }
}
