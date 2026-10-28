import { AIRBUS_MCDU_KEYS, type CduScreen } from "@vbuddy/protocol";
import { WebSocket } from "ws";
import type { Logger } from "../log.js";
import type { PanelResult } from "../panel/backend.js";
import { C, Grid, type Cell } from "./grid.js";
import type { FmsProvider } from "./hub.js";

/*
 * The Fenix A320 family's MCDUs, through the Fenix's own data service on this PC (the same local server as its EFB,
 * normally 127.0.0.1:8083, IPv4 only). Screens come from a GraphQL subscription (graphql-transport-ws) to the data refs
 * aircraft.mcdu1.display / aircraft.mcdu2.display, each an XML document of a title, 12 lines and the scratchpad with
 * inline one-letter codes; a key press is a GraphQL writeInt of 1, then 0, on system.switches.S_CDU<n>_KEY_<KEY>.
 */

const DISPLAYS = ["aircraft.mcdu1.display", "aircraft.mcdu2.display"] as const;
const SUBSCRIPTION = "subscription ($names: [String!]!) { dataRefs(names: $names) { name value } }";
const WRITE = "mutation ($name: String!, $value: Int!) { dataRef { writeInt(name: $name, value: $value) } }";
/** How long a key is held down, and the gap before the next one (so the MCDU sees every press). */
const PRESS_MS = 50;
const GAP_MS = 60;

/** Fenix inline codes: colours and sizes are lowercase letters (the screen text itself is upper case). */
const CODE_COLOR: Record<string, number> = { a: C.amber, c: C.cyan, g: C.green, m: C.magenta, w: C.white, y: C.yellow };
/** The Fenix font's special glyphs. */
const SPECIAL: Record<string, string> = { "#": "□", "&": "Δ", "¤": "↑", "¥": "↓", "¢": "→", "£": "←" };

const xmlText = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");

/** One Fenix display line to styled characters. A line starts large and white. */
export function fenixCells(line: string): Cell[] {
  const out: Cell[] = [];
  let color: number = C.white;
  let small = false;
  for (const ch of line) {
    if (CODE_COLOR[ch] !== undefined) color = CODE_COLOR[ch]!;
    else if (ch === "s") small = true;
    else if (ch === "l") small = false;
    else out.push({ ch: SPECIAL[ch] ?? ch, color, small });
  }
  return out;
}

/** The Fenix display XML in the 24 x 14 grid. Null when it isn't a screen. */
export function fenixScreen(xml: string | null, which: 0 | 1, message: string | null): CduScreen {
  const g = new Grid();
  let live = false;
  if (xml) {
    const el = (tag: string) => [...xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag}\\s*/>`, "g"))].map((m) => xmlText(m[1] ?? ""));
    const title = el("title")[0];
    const lines = el("line");
    const pad = el("scratchpad")[0];
    if (title !== undefined || lines.length || pad !== undefined) {
      live = true;
      if (title) g.put(0, 0, fenixCells(title));
      lines.slice(0, 12).forEach((l, i) => g.put(i + 1, 0, fenixCells(l)));
      if (pad) g.put(13, 0, fenixCells(pad));
    }
  }
  return {
    aircraft: "fenix",
    layout: "airbus",
    name: "Fenix MCDU",
    side: which,
    sides: 2,
    live,
    powered: live,
    ...g.out(),
    annun: { exec: false, msg: false, fail: false, ofst: false, call: false, dspy: false },
    keys: [...AIRBUS_MCDU_KEYS],
    message: live ? null : message,
  };
}

/** VBuddy's Airbus key names to the Fenix's switch names. */
export function fenixKey(k: string): string {
  const lsk = /^([LR])([1-6])$/.exec(k);
  if (lsk) return `LSK${lsk[2]}${lsk[1]}`;
  const map: Record<string, string> = { OVFY: "OVFLY", PREV_PAGE: "ARROW_LEFT", NEXT_PAGE: "ARROW_RIGHT", UP: "ARROW_UP", DOWN: "ARROW_DOWN", CLR: "CLEAR", PLUS_MINUS: "MINUS" };
  return map[k] ?? k;
}

const NOT_RUNNING = "The Fenix's data service isn't answering on this PC. Load the Fenix (its EFB and MCDU data come from the Fenix app), then wait a moment.";
const WAITING = "Connected to the Fenix. Waiting for its MCDU screen (is the aircraft powered?).";

/** Fenix MCDUs. Connects only while a Fenix is loaded. */
export class FenixMcdu implements FmsProvider {
  readonly label = "Fenix MCDU";
  private ws: WebSocket | null = null;
  private ready = false;
  private xml: [string | null, string | null] = [null, null];
  private cbs: Array<(side: number) => void> = [];
  private retry: NodeJS.Timeout | null = null;
  private backoff = 2000;
  private wanted = false;
  private keys: Promise<unknown> = Promise.resolve();

  constructor(
    private port: () => number,
    private log: Logger,
    private fetchFn: typeof fetch = (u, i) => fetch(u, i),
    private makeSocket: (url: string) => WebSocket = (u) => new WebSocket(u, "graphql-transport-ws"),
  ) {}

  private get base() {
    return `127.0.0.1:${this.port()}`;
  }
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
      this.ready = false;
      this.xml = [null, null];
    }
  }

  private connect() {
    if (!this.wanted || this.ws) return;
    let ws: WebSocket;
    try {
      ws = this.makeSocket(`ws://${this.base}/graphql`);
    } catch {
      return this.later();
    }
    this.ws = ws;
    ws.on("open", () => ws.send(JSON.stringify({ type: "connection_init", payload: {} })));
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.ready = false;
      if (this.xml[0] || this.xml[1]) {
        this.xml = [null, null];
        for (const cb of this.cbs) {
          cb(0);
          cb(1);
        }
      }
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

  /** Exposed for tests: one message from the Fenix data service. */
  onMessage(text: string) {
    let m: { type?: string; id?: string; payload?: { data?: { dataRefs?: unknown }; errors?: unknown } };
    try {
      m = JSON.parse(text) as typeof m;
    } catch {
      return;
    }
    if (m.type === "connection_ack") {
      this.ready = true;
      this.backoff = 2000;
      this.log.info("Fenix: connected to the MCDU data");
      this.ws?.send(JSON.stringify({ id: "vbuddy-mcdu", type: "subscribe", payload: { query: SUBSCRIPTION, variables: { names: [...DISPLAYS] } } }));
    } else if (m.type === "ping") {
      this.ws?.send(JSON.stringify({ type: "pong" }));
    } else if (m.type === "next") {
      const refs = m.payload?.data?.dataRefs;
      const list = Array.isArray(refs) ? refs : refs ? [refs] : [];
      for (const r of list as Array<{ name?: string; value?: unknown }>) {
        const i = DISPLAYS.indexOf(r.name as (typeof DISPLAYS)[number]);
        if (i < 0 || typeof r.value !== "string") continue;
        if (this.xml[i] === r.value) continue;
        this.xml[i] = r.value;
        for (const cb of this.cbs) cb(i);
      }
    } else if (m.type === "error") {
      this.log.warn(`Fenix MCDU subscription refused: ${JSON.stringify(m.payload).slice(0, 200)}`);
    }
  }

  screen(side: number): CduScreen {
    const s = side === 1 ? 1 : 0;
    return fenixScreen(this.xml[s], s, this.ready ? WAITING : NOT_RUNNING);
  }

  private async write(name: string, value: number): Promise<boolean> {
    try {
      const r = await this.fetchFn(`http://${this.base}/graphql`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: WRITE, variables: { name, value } }),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return false;
      const j = (await r.json().catch(() => null)) as { data?: { dataRef?: { writeInt?: unknown } }; errors?: unknown } | null;
      return !!j && !j.errors && j.data?.dataRef?.writeInt !== false;
    } catch {
      return false;
    }
  }

  key(side: number, key: string): Promise<PanelResult> {
    if (!(AIRBUS_MCDU_KEYS as readonly string[]).includes(key)) return Promise.resolve({ ok: false, error: `The MCDU has no ${key} key.` });
    const name = `system.switches.S_CDU${side === 1 ? 2 : 1}_KEY_${fenixKey(key)}`;
    // One key at a time, in order: a press, a short hold, a release.
    const run = this.keys.then(async (): Promise<PanelResult> => {
      const down = await this.write(name, 1);
      await new Promise((r) => setTimeout(r, PRESS_MS));
      await this.write(name, 0);
      await new Promise((r) => setTimeout(r, GAP_MS));
      return down ? { ok: true } : { ok: false, error: NOT_RUNNING };
    });
    this.keys = run.catch(() => null);
    return run;
  }
}
