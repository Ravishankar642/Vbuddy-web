import { parseMhz, type AtcAppStatus } from "@vbuddy/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.js";

/*
 * SayIntentions.AI: its ATC conversation in VBuddy's Comms. The SayIntentions client on this PC gives the flight's own
 * key (flight.json, at http://localhost:43117/flightJSON or %LOCALAPPDATA%\SayIntentionsAI\flight.json, only while a
 * flight is active); SayIntentions' SAPI (getCommsHistory, polled with since_id) gives what was said, with the
 * pilot's developer key in X-Developer-Key. Documented at portal.sayintentions.ai/p2/docs.
 */

const SAPI = "https://apipri.sayintentions.ai/sapi";
const LOCAL = "http://127.0.0.1:43117/flightJSON";
const POLL_MS = 4000;
const IDLE_POLL_MS = 15_000;

export interface SiFlight {
  apiKey: string;
  callsign: string | null;
  flightId: string | null;
}

/** One line of the conversation. */
export interface SiLine {
  id: number;
  dir: "in" | "out";
  from: string;
  text: string;
  freqHz: number | null;
  at: number;
}

/** The flight details from flight.json (null when there is no active flight). */
export function parseFlightJson(j: unknown): SiFlight | null {
  const d = (j as { flight_details?: Record<string, unknown> } | null)?.flight_details;
  const key = d && typeof d.api_key === "string" ? d.api_key.trim() : "";
  if (!key) return null;
  const cs = typeof d!.callsign_icao === "string" && d!.callsign_icao ? d!.callsign_icao : typeof d!.callsign === "string" ? d!.callsign : null;
  return { apiKey: key, callsign: cs ? cs.toUpperCase().replace(/[^A-Z0-9]/g, "") : null, flightId: d!.flight_id !== undefined ? String(d!.flight_id) : null };
}

/** getCommsHistory entries to conversation lines: what the pilot said (out), then what ATC answered (in). */
export function parseComms(j: unknown, myCallsign: string | null): SiLine[] {
  const list = (j as { comm_history?: unknown[] } | null)?.comm_history;
  if (!Array.isArray(list)) return [];
  const out: SiLine[] = [];
  for (const e of list as Array<Record<string, unknown>>) {
    const id = Number(e.id);
    if (!Number.isFinite(id)) continue;
    const at = typeof e.stamp_zulu === "string" ? Date.parse(e.stamp_zulu) || Date.now() : Date.now();
    const freqHz = typeof e.frequency === "string" ? parseMhz(e.frequency) : null;
    const station = typeof e.station_name === "string" && e.station_name.trim() ? e.station_name.trim() : "ATC";
    const said = (k: string) => {
      const v = e[`${k}_english`] ?? e[k];
      return typeof v === "string" && v.trim() ? v.trim() : null;
    };
    const pilot = said("incoming_message");
    const atc = said("outgoing_message");
    if (pilot) out.push({ id, dir: "out", from: myCallsign ?? "YOU", text: pilot, freqHz, at });
    if (atc) out.push({ id, dir: "in", from: station, text: atc, freqHz, at: at + 1 });
  }
  return out.sort((a, b) => a.id - b.id || a.at - b.at);
}

export class SayIntentionsLink {
  private st: AtcAppStatus = { state: "off", message: null };
  private flight: SiFlight | null = null;
  private since = -1;
  private timer: NodeJS.Timeout | null = null;
  private cbs: Array<() => void> = [];
  private lineCbs: Array<(l: SiLine) => void> = [];
  private stopped = true;
  private usedKey = "";

  constructor(
    private devKey: () => string,
    private log: Logger,
    private fetchFn: typeof fetch = (u, i) => fetch(u, i),
    private flightFile: string | null = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "SayIntentionsAI", "flight.json") : null,
  ) {}

  status() {
    return this.st;
  }
  /** The SayIntentions flight's callsign, for spotting it in radio calls. */
  callsign() {
    return this.flight?.callsign ?? null;
  }
  onStatus(cb: () => void) {
    this.cbs.push(cb);
  }
  onLine(cb: (l: SiLine) => void) {
    this.lineCbs.push(cb);
  }
  private set(s: AtcAppStatus) {
    if (s.state === this.st.state && s.message === this.st.message) return;
    this.st = s;
    for (const cb of this.cbs) cb();
  }

  start() {
    this.stopped = false;
    void this.tick();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  /** The settings were changed in the VBuddy window: check again now. */
  changed() {
    if (!this.stopped) {
      if (this.timer) clearTimeout(this.timer);
      void this.tick();
    }
  }

  private async readFlight(): Promise<SiFlight | null> {
    try {
      const r = await this.fetchFn(LOCAL, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return parseFlightJson(await r.json());
    } catch {
      /* the client isn't running, or an older one: try the file */
    }
    if (!this.flightFile) return null;
    try {
      return parseFlightJson(JSON.parse(readFileSync(this.flightFile, "utf8")));
    } catch {
      return null;
    }
  }

  private async tick() {
    if (this.stopped) return;
    let wait = IDLE_POLL_MS;
    try {
      const f = await this.readFlight();
      if (f?.apiKey !== this.flight?.apiKey) this.since = -1;
      this.flight = f;
      const dev = this.devKey();
      // A different key may see a different history: start over from what it has now.
      if (dev !== this.usedKey) {
        this.usedKey = dev;
        this.since = -1;
      }
      if (!f) this.set({ state: dev ? "waiting" : "off", message: dev ? "Waiting for a SayIntentions flight on this PC." : null });
      else if (!dev) this.set({ state: "waiting", message: "SayIntentions flight found. Add your SayIntentions developer key in the VBuddy window to see its ATC here." });
      else {
        wait = POLL_MS;
        const q = new URLSearchParams({ api_key: f.apiKey, ...(this.since >= 0 ? { since_id: String(this.since) } : {}) });
        const r = await this.fetchFn(`${SAPI}/getCommsHistory?${q}`, { headers: { "X-Developer-Key": dev }, signal: AbortSignal.timeout(8000) });
        if (r.status === 401 || r.status === 403) this.set({ state: "error", message: "SayIntentions refused the developer key." });
        else if (!r.ok) this.set({ state: "error", message: `SayIntentions answered ${r.status}.` });
        else {
          const lines = parseComms(await r.json(), f.callsign);
          // The first answer is the flight so far: kept as the starting point, not repeated into Comms.
          const first = this.since < 0;
          for (const l of lines) {
            if (l.id > this.since && !first) for (const cb of this.lineCbs) cb(l);
            this.since = Math.max(this.since, l.id);
          }
          if (first && this.since < 0) this.since = 0;
          this.set({ state: "live", message: f.callsign ? `Flight ${f.callsign}` : null });
        }
      }
    } catch (e) {
      this.set({ state: "error", message: `SayIntentions: ${(e as Error).message}` });
    }
    if (!this.stopped) this.timer = setTimeout(() => void this.tick(), wait);
    this.timer?.unref?.();
  }
}
