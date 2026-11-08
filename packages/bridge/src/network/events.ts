import type { Fetcher } from "../briefing/weather.js";

export interface NetEvent {
  name: string;
  link: string | null;
  start: number;
  end: number;
  airports: string[];
}

const URL = "https://my.vatsim.net/api/v2/events/latest";
const TTL_MS = 60 * 60_000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function mapEvents(j: unknown): NetEvent[] {
  const list = isObj(j) && Array.isArray(j.data) ? j.data : Array.isArray(j) ? j : [];
  const out: NetEvent[] = [];
  for (const e of list) {
    if (!isObj(e)) continue;
    const start = Date.parse(String(e.start_time ?? ""));
    const end = Date.parse(String(e.end_time ?? ""));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const airports = (Array.isArray(e.airports) ? e.airports : []).map((a) => (isObj(a) ? String(a.icao ?? "") : "")).filter((x) => /^[A-Z0-9]{4}$/.test(x));
    out.push({ name: String(e.name ?? "Event"), link: typeof e.link === "string" ? e.link : null, start, end, airports });
  }
  return out;
}

/** VATSIM events, fetched at most once an hour and only when the app asks. */
export class VatsimEvents {
  private cache: { at: number; events: NetEvent[] } | null = null;
  private pending: Promise<NetEvent[]> | null = null;
  constructor(private fetcher: Fetcher) {}

  /** Events at any of these airports that haven't ended and start within 24 hours. */
  async at(icaos: string[], now = Date.now()): Promise<NetEvent[]> {
    const want = new Set(icaos.map((i) => i.toUpperCase()));
    const all = await this.all(now);
    return all.filter((e) => e.end > now && e.start < now + 24 * 3_600_000 && e.airports.some((a) => want.has(a))).slice(0, 5);
  }

  private all(now: number): Promise<NetEvent[]> {
    if (this.cache && now - this.cache.at < TTL_MS) return Promise.resolve(this.cache.events);
    this.pending ??= (async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10_000);
        try {
          const r = await this.fetcher(URL, { signal: ctl.signal, headers: { "user-agent": "VBuddy", accept: "application/json" } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const events = mapEvents(await r.json());
          this.cache = { at: now, events };
          return events;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return this.cache?.events ?? [];
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}
