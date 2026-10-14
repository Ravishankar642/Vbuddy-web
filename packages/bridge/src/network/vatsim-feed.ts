import type { Logger } from "../log.js";

/** A pilot as read from the VATSIM v3 feed, reduced to what VBuddy uses. */
export interface RawPilot {
  callsign: string;
  lat: number;
  lon: number;
  alt: number;
  gs: number;
  hdg: number;
  type?: string;
  dep?: string;
  arr?: string;
}
export interface RawController {
  callsign: string;
  name: string;
  freq: string;
  /** VATSIM facility number: 0 OBS, 1 FSS, 2 DEL, 3 GND, 4 TWR, 5 APP, 6 CTR. */
  facility: number;
}
export interface RawAtis {
  callsign: string;
  freq: string;
  code: string | null;
  text: string[];
}
export interface FeedSnapshot {
  /** When VATSIM generated the data (ms). */
  updatedAt: number;
  pilots: RawPilot[];
  controllers: RawController[];
  atis: RawAtis[];
}

export const VATSIM_STATUS_URL = "https://status.vatsim.net/status.json";
export const VATSIM_FEED_URL = "https://data.vatsim.net/v3/vatsim-data.json";

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
const lines = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Reads the v3 feed. Entries missing a callsign or a usable position are dropped, never fatal. */
export function parseVatsimFeed(json: unknown): FeedSnapshot {
  const j = (json ?? {}) as Record<string, unknown>;
  const general = (j.general ?? {}) as Record<string, unknown>;
  const ts = Date.parse(str(general.update_timestamp));

  const pilots: RawPilot[] = [];
  for (const p of Array.isArray(j.pilots) ? (j.pilots as Record<string, unknown>[]) : []) {
    const lat = num(p.latitude);
    const lon = num(p.longitude);
    const callsign = str(p.callsign).trim();
    if (!callsign || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const fp = (p.flight_plan ?? null) as Record<string, unknown> | null;
    pilots.push({
      callsign,
      lat,
      lon,
      alt: num(p.altitude) || 0,
      gs: num(p.groundspeed) || 0,
      hdg: num(p.heading) || 0,
      ...(fp && str(fp.aircraft_short) ? { type: str(fp.aircraft_short) } : {}),
      ...(fp && str(fp.departure) ? { dep: str(fp.departure) } : {}),
      ...(fp && str(fp.arrival) ? { arr: str(fp.arrival) } : {}),
    });
  }

  const controllers: RawController[] = [];
  for (const c of Array.isArray(j.controllers) ? (j.controllers as Record<string, unknown>[]) : []) {
    const callsign = str(c.callsign).trim().toUpperCase();
    if (!callsign) continue;
    controllers.push({ callsign, name: str(c.name), freq: str(c.frequency), facility: num(c.facility) || 0 });
  }

  const atis: RawAtis[] = [];
  for (const a of Array.isArray(j.atis) ? (j.atis as Record<string, unknown>[]) : []) {
    const callsign = str(a.callsign).trim().toUpperCase();
    if (!callsign) continue;
    atis.push({ callsign, freq: str(a.frequency), code: str(a.atis_code) || null, text: lines(a.text_atis) });
  }

  return { updatedAt: Number.isFinite(ts) ? ts : Date.now(), pilots, controllers, atis };
}

export type FeedState = { state: "loading" | "ok" | "stale" | "error"; detail?: string };

export interface FeedOptions {
  log: Logger;
  fetch?: typeof fetch;
  /** Overrides the feed URL (skips status.json). */
  feedUrl?: string;
  intervalMs?: number;
  /** Polls only while this says someone needs the data. */
  wanted: () => boolean;
}

const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000];
const IDLE_CHECK_MS = 2_000;
const TIMEOUT_MS = 12_000;

/**
 * Polls the VATSIM v3 data feed (it refreshes every 15 s) while anyone needs
 * it, backing off after failures. Hands each new snapshot to listeners.
 */
export class VatsimFeed {
  private timer: NodeJS.Timeout | null = null;
  private feedUrl: string | null;
  private failures = 0;
  private last: FeedSnapshot | null = null;
  private dataCbs: Array<(s: FeedSnapshot) => void> = [];
  private stateCbs: Array<(s: FeedState) => void> = [];
  private stopped = true;
  private fetchFn: typeof fetch;
  private interval: number;

  constructor(private opts: FeedOptions) {
    this.feedUrl = opts.feedUrl ?? null;
    this.fetchFn = opts.fetch ?? fetch;
    this.interval = opts.intervalMs ?? 15_000;
  }

  onData(cb: (s: FeedSnapshot) => void) {
    this.dataCbs.push(cb);
  }
  onState(cb: (s: FeedState) => void) {
    this.stateCbs.push(cb);
  }
  latest() {
    return this.last;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private emitState(s: FeedState) {
    for (const cb of this.stateCbs) cb(s);
  }

  private async getJson(url: string): Promise<unknown> {
    const res = await this.fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** One poll. Exposed for tests. */
  async tick(): Promise<void> {
    if (!this.opts.wanted()) return this.schedule(IDLE_CHECK_MS);
    try {
      if (!this.feedUrl) {
        try {
          const st = (await this.getJson(VATSIM_STATUS_URL)) as { data?: { v3?: unknown } };
          const u = Array.isArray(st?.data?.v3) ? st.data.v3[0] : undefined;
          this.feedUrl = typeof u === "string" ? u : VATSIM_FEED_URL;
        } catch {
          this.feedUrl = VATSIM_FEED_URL;
        }
      }
      const snap = parseVatsimFeed(await this.getJson(this.feedUrl));
      if (this.failures) this.opts.log.info("VATSIM data is back.");
      this.failures = 0;
      const fresh = !this.last || snap.updatedAt !== this.last.updatedAt;
      this.last = snap;
      this.emitState({ state: "ok" });
      if (fresh) for (const cb of this.dataCbs) cb(snap);
      this.schedule(this.interval);
    } catch (e) {
      const msg = (e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message;
      if (this.failures === 0) this.opts.log.warn(`Couldn't get VATSIM data (${msg}). Retrying with back-off.`);
      const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)]!;
      this.failures++;
      this.emitState({ state: this.last ? "stale" : "error", detail: `Can't reach VATSIM (${msg}). Retrying in ${Math.round(delay / 1000)} s.` });
      this.schedule(delay);
    }
  }
}
