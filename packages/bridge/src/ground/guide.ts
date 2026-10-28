import { isTaxiClearance, parseTaxiClearance, planTaxi, taxiProgress, type GroundChart, type TaxiFrom, type TaxiGuide, type TaxiPlan, type TaxiRequest, type TaxiTo, type Telemetry } from "@vbuddy/protocol";
import type { Logger } from "../log.js";

/** A note for the pilot: shown in the open app, pushed to devices that aren't looking. */
export interface TaxiNotice {
  /** Same tag = the same notice (a later one replaces it). */
  tag: string;
  title: string;
  text: string;
}

type Result = { ok: true } | { ok: false; error: string };

/** A turn is announced this far ahead, a crossing or the holding point this far. */
const TURN_AHEAD_M = 150;
const HOLD_AHEAD_M = 120;
/** Off the route by this much, for this long, while moving: plan again from where you are. */
const OFF_ROUTE_M = 60;
const OFF_ROUTE_MS = 8000;
/** At the destination: stopped within this distance. */
const ARRIVED_M = 40;

const turnWords = (turn: "left" | "right" | "ahead") => (turn === "ahead" ? "Continue onto" : `Turn ${turn} onto`);
const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`);

/**
 * VBuddy's progressive taxi guidance, on the bridge PC: the route being followed (planned from a device, or read from
 * ATC's taxi clearance as soon as it's heard), where the aircraft is along it, and a notice before each turn, runway
 * crossing and the holding point. Every device sees the same route; it ends at the destination or on takeoff.
 */
export class TaxiGuideService {
  private g: TaxiGuide | null = null;
  private to: TaxiTo | null = null;
  private cbs: Array<() => void> = [];
  private noticeCbs: Array<(n: TaxiNotice) => void> = [];
  private said = new Set<string>();
  private lastAt = 0;
  private lastSentJson = "";
  private offSince: number | null = null;
  private arrivedAt: number | null = null;
  private last: Telemetry | null = null;
  private busy = false;

  constructor(
    private charts: { get(icao: string): Promise<{ chart: unknown; error?: string }> },
    /** The airport the aircraft is at (within a few nm), or null. */
    private nearest: (lat: number, lon: number) => string | null,
    private log: Logger,
    private now: () => number = Date.now,
  ) {}

  guide(): TaxiGuide | null {
    return this.g;
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
  onNotice(cb: (n: TaxiNotice) => void) {
    this.noticeCbs.push(cb);
  }
  private changed() {
    this.lastSentJson = JSON.stringify(this.g);
    for (const cb of this.cbs) cb();
  }
  private notice(n: TaxiNotice) {
    for (const cb of this.noticeCbs) cb(n);
  }

  private async chartFor(icao: string): Promise<GroundChart | null> {
    const r = await this.charts.get(icao);
    return (r.chart as GroundChart | null) ?? null;
  }

  private set(icao: string, plan: TaxiPlan, to: TaxiTo, source: TaxiGuide["source"], clearance: string | null, from: string | null) {
    this.g = { icao, plan, source, clearance, from, setAt: this.now(), progress: this.last ? this.progressOf(plan, this.last) : null };
    this.to = to;
    this.said.clear();
    this.offSince = null;
    this.arrivedAt = null;
    this.changed();
  }

  clear(why = "") {
    if (!this.g) return;
    this.log.info(`Taxi route cleared${why ? ` (${why})` : ""}`);
    this.g = null;
    this.to = null;
    this.changed();
  }

  /** From a device: plan a route from the aircraft (or a stand), or stop following one. */
  async request(r: TaxiRequest): Promise<Result> {
    if (r.op === "clear") {
      this.clear("asked");
      return { ok: true };
    }
    const chart = await this.chartFor(r.icao);
    if (!chart) return { ok: false, error: `No taxiway layout for ${r.icao.toUpperCase()}.` };
    const t = this.last;
    const from: TaxiFrom | null = r.fromStand !== undefined ? { kind: "parking", index: r.fromStand } : t ? { kind: "position", lat: t.lat, lon: t.lon, hdg: t.hdgTrue } : null;
    if (!from) return { ok: false, error: "The aircraft's position isn't known yet: pick the stand to start from." };
    const p = planTaxi(chart, from, r.to, r.via);
    if (!p.ok) return { ok: false, error: p.error };
    this.set(chart.icao, p, r.to, "pilot", null, null);
    return { ok: true };
  }

  /**
   * A radio call: if it is a taxi clearance for you while you're on the ground at an airport VBuddy has the layout of,
   * the route is planned from it straight away. Returns the route's words, or null when it didn't apply.
   */
  async clearance(text: string, from: string): Promise<string | null> {
    const t = this.last;
    if (!isTaxiClearance(text) || !t || !t.onGround || this.busy) return null;
    const icao = this.nearest(t.lat, t.lon);
    if (!icao) return null;
    this.busy = true;
    try {
      const chart = await this.chartFor(icao);
      if (!chart) return null;
      const c = parseTaxiClearance(text);
      let to: TaxiTo | null = null;
      if (c.runway) to = { kind: "runway", runway: c.runway };
      else if (c.stand) {
        const want = c.stand.replace(/\s/g, "").toUpperCase();
        const i = chart.parking.findIndex((p) => p.name.replace(/\s/g, "").toUpperCase() === want);
        if (i >= 0) to = { kind: "parking", index: i };
      }
      if (!to) return null;
      const p = planTaxi(chart, { kind: "position", lat: t.lat, lon: t.lon, hdg: t.hdgTrue }, to, c.via);
      if (!p.ok) {
        this.log.info(`Heard a taxi clearance but couldn't plan it at ${icao}: ${p.error}`);
        return null;
      }
      this.set(chart.icao, p, to, "atc", text.slice(0, 600), from.slice(0, 40));
      this.log.info(`Taxi route from ${from}'s clearance: ${p.text}`);
      this.notice({ tag: "route", title: "Taxi route ready", text: `${p.text}${p.unmatched.length ? ` (couldn't find ${p.unmatched.join(", ")})` : ""}` });
      return p.text;
    } finally {
      this.busy = false;
    }
  }

  private progressOf(plan: TaxiPlan, t: Telemetry) {
    return taxiProgress(plan, t.lat, t.lon);
  }

  /** Every sim frame; worked on about once a second. */
  sample(t: Telemetry) {
    this.last = t;
    const now = this.now();
    if (now - this.lastAt < 1000) return;
    this.lastAt = now;
    const g = this.g;
    if (!g) return;
    // Wheels up: the taxi is over.
    if (!t.onGround && t.altAgl > 50) return this.clear("airborne");
    const p = this.progressOf(g.plan, t);
    g.progress = p;
    const moving = t.gs > 2;

    // Off the route for a while: plan again from here, keeping the taxiways not yet reached.
    if (p.offRouteM > OFF_ROUTE_M && moving) {
      this.offSince ??= now;
      if (now - this.offSince > OFF_ROUTE_MS && p.offRouteM < 3000) void this.replan(g, t);
    } else this.offSince = null;

    const n = p.next;
    if (n) {
      const key = `${n.what}:${n.name}:${g.plan.events.findIndex((e) => e.name === n.name && (e.what === n.what || (n.what === "hold" && e.what === "cross")))}`;
      if (n.what === "turn" && n.inM <= TURN_AHEAD_M && !this.said.has(key)) {
        this.said.add(key);
        this.notice({ tag: "next", title: `${turnWords(n.turn)} ${n.name}`, text: `In ${dist(n.inM)}. ${dist(p.remainingM)} to ${g.plan.destination}.` });
      } else if ((n.what === "cross" || n.what === "hold") && n.inM <= HOLD_AHEAD_M && !this.said.has(key)) {
        this.said.add(key);
        this.notice(
          n.what === "cross"
            ? { tag: "next", title: `Hold short of runway ${n.name}`, text: `In ${dist(n.inM)}. Cross only when ATC clears you.` }
            : { tag: "next", title: `Holding point ahead`, text: `${g.plan.destination} in ${dist(n.inM)}.` },
        );
      } else if (n.what === "arrive" && p.remainingM <= ARRIVED_M && !this.said.has("arrive")) {
        this.said.add("arrive");
        this.notice({ tag: "next", title: `Arriving: ${g.plan.destination}`, text: "You're at the end of the taxi route." });
      }
    }
    // At the end and stopped (or a minute after reaching a holding point): done.
    if (p.remainingM <= ARRIVED_M) {
      this.arrivedAt ??= now;
      if ((!moving && now - this.arrivedAt > 15_000) || now - this.arrivedAt > 180_000) return this.clear("arrived");
    } else this.arrivedAt = null;

    const json = JSON.stringify(g);
    if (json !== this.lastSentJson) this.changed();
  }

  private async replan(g: TaxiGuide, t: Telemetry) {
    if (this.busy || !this.to) return;
    this.busy = true;
    try {
      const chart = await this.chartFor(g.icao);
      if (!chart || this.g !== g) return;
      const leg = g.progress?.leg ?? 0;
      const ahead = new Set(g.plan.legs.slice(leg).map((l) => l.name.replace(/\s+/g, "").toUpperCase()));
      const via = g.plan.via.filter((v) => ahead.has(v.replace(/\s+/g, "").toUpperCase()));
      const p = planTaxi(chart, { kind: "position", lat: t.lat, lon: t.lon, hdg: t.hdgTrue }, this.to, via);
      if (!p.ok) return;
      this.set(g.icao, p, this.to, g.source, g.clearance, g.from);
      this.notice({ tag: "route", title: "Taxi route updated", text: `You left the route, so it was planned again from here. ${p.text}` });
    } finally {
      this.busy = false;
    }
  }

  /** The simulator went away or a new flight began. */
  reset() {
    this.last = null;
    this.clear("new flight");
  }
}
