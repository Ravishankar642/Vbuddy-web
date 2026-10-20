import type { AirportBrief, Briefing } from "@vbuddy/protocol";
import { parseMetar } from "./metar.js";
import { mapOfp, simbriefUrl } from "./simbrief.js";
import { fetchWeather, type Fetcher } from "./weather.js";

const WEATHER_TTL = 5 * 60_000;
const OFP_TTL = 60_000;

export class BriefingService {
  private ofp: { id: string; at: number; value: ReturnType<typeof mapOfp> | "not-found" | "unreachable" } | null = null;
  private wx = new Map<string, { at: number; metar: string | null; taf: string | null; err: string | null }>();

  constructor(
    private readonly fetcher: Fetcher,
    private readonly simbriefId: () => string,
    private readonly now: () => number = Date.now,
  ) {}

  /** The callsign of the last loaded plan, without fetching anything. */
  cachedCallsign(): string | null {
    const v = this.ofp?.value;
    return v && typeof v === "object" ? v.ofp.callsign : null;
  }

  /** Departure and arrival of the last loaded plan, without fetching anything. */
  cachedEndpoints(): { dep: string; arr: string } | null {
    const v = this.ofp?.value;
    if (!v || typeof v !== "object") return null;
    const dep = v.airports.find((a) => a.role === "origin")?.icao;
    const arr = v.airports.find((a) => a.role === "destination")?.icao;
    return dep && arr ? { dep, arr } : null;
  }

  /** Loads the plan if it is stale, then returns its departure and arrival (null when there is no plan). */
  async endpoints(): Promise<{ dep: string; arr: string } | null> {
    const id = this.simbriefId();
    if (!id) return null;
    const now = this.now();
    if (!this.ofp || this.ofp.id !== id || now - this.ofp.at > OFP_TTL) await this.loadOfp(id, now);
    return this.cachedEndpoints();
  }

  /**
   * The SimBrief plan itself, without weather: loaded again when it's older than a minute, or always with `refresh`.
   * Null when there is no SimBrief name, no plan, or SimBrief can't be reached (an older good plan is kept then).
   */
  async plan(refresh = false): Promise<NonNullable<ReturnType<typeof mapOfp>> | null> {
    const id = this.simbriefId();
    if (!id) return null;
    const now = this.now();
    if (refresh || !this.ofp || this.ofp.id !== id || now - this.ofp.at > OFP_TTL) await this.loadOfp(id, now);
    const v = this.ofp?.value;
    return v && typeof v === "object" ? v : null;
  }

  /** The route fixes of the SimBrief plan, without fetching any weather. Empty when there is no plan. */
  async routeFixes(): Promise<Briefing["fixes"]> {
    const id = this.simbriefId();
    if (!id) return [];
    const now = this.now();
    if (!this.ofp || this.ofp.id !== id || now - this.ofp.at > OFP_TTL) await this.loadOfp(id, now);
    const v = this.ofp?.value;
    return v && typeof v === "object" ? v.fixes : [];
  }

  /** `extra`: an airport the pilot looked up by hand. `refresh`: skip the caches. */
  async get(opts: { extra?: string | null; refresh?: boolean } = {}): Promise<Briefing> {
    const now = this.now();
    const id = this.simbriefId();
    let problem: Briefing["problem"] = null;
    let error: string | null = null;
    let airports: AirportBrief[] = [];
    let ofp: Briefing["ofp"] = null;
    let fixes: Briefing["fixes"] = [];

    if (!id) {
      problem = "no-id";
      error = "Enter your SimBrief name in the VBuddy window on your PC to see your flight plan here.";
    } else {
      if (!this.ofp || this.ofp.id !== id || opts.refresh || now - this.ofp.at > OFP_TTL) await this.loadOfp(id, now);
      const v = this.ofp!.value;
      if (v === "not-found") {
        problem = "not-found";
        error = `SimBrief has no flight plan for "${id}". Check the name or pilot ID, and make sure you have generated a plan.`;
      } else if (v === "unreachable" || v === null) {
        problem = "unreachable";
        error = "Couldn't reach SimBrief. Check the PC's internet connection and try again.";
      } else {
        ofp = v.ofp;
        airports = v.airports.map((a) => ({ ...a }));
        fixes = v.fixes;
      }
    }

    const extra = opts.extra?.toUpperCase();
    if (extra && /^[A-Z][A-Z0-9]{3}$/.test(extra) && !airports.some((a) => a.icao === extra)) {
      airports.push({ role: "other", icao: extra, name: null, elevationFt: null, plannedRunway: null, metar: null, taf: null, weatherError: null });
    }

    if (airports.length) await this.fillWeather(airports, now, !!opts.refresh);
    return { source: ofp ? "simbrief" : "none", fetchedAt: now, ofp, airports, fixes, error, problem };
  }

  private async loadOfp(id: string, now: number) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 10_000);
      let r;
      try {
        r = await this.fetcher(simbriefUrl(id), { signal: ctl.signal, headers: { "user-agent": "VBuddy" } });
      } finally {
        clearTimeout(timer);
      }
      if (r.status === 400 || r.status === 404) return void (this.ofp = { id, at: now, value: "not-found" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const mapped = mapOfp(await r.json());
      this.ofp = { id, at: now, value: mapped ?? "not-found" };
    } catch {
      // keep an older good plan if there is one
      if (this.ofp && this.ofp.id === id && typeof this.ofp.value === "object" && this.ofp.value) return;
      this.ofp = { id, at: now - OFP_TTL + 10_000, value: "unreachable" };
    }
  }

  private async fillWeather(airports: AirportBrief[], now: number, refresh: boolean) {
    const need = airports.map((a) => a.icao).filter((i) => refresh || !this.wx.has(i) || now - this.wx.get(i)!.at > WEATHER_TTL);
    if (need.length) {
      try {
        const { metar, taf } = await fetchWeather(this.fetcher, need);
        for (const i of need) this.wx.set(i, { at: now, metar: metar.get(i) ?? null, taf: taf.get(i) ?? null, err: null });
      } catch {
        for (const i of need) if (!this.wx.get(i)?.metar) this.wx.set(i, { at: now - WEATHER_TTL + 30_000, metar: null, taf: null, err: "Couldn't reach the weather service." });
      }
    }
    for (const a of airports) {
      const w = this.wx.get(a.icao);
      if (!w) continue;
      a.taf = w.taf;
      if (w.metar) a.metar = parseMetar(w.metar, now);
      else a.weatherError = w.err ?? "No report for this airport.";
    }
  }
}
