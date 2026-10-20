import type { FlightPlanInfo } from "@vbuddy/protocol";
import type { Logger } from "../log.js";
import { nm } from "../sim/flight-gate.js";
import type { mapOfp } from "./simbrief.js";

type Mapped = NonNullable<ReturnType<typeof mapOfp>>;

/** Where the flight in progress began, for matching a plan to it. */
export interface FlightStart {
  lat: number;
  lon: number;
  /** The flight began in the air (an air start): match against the route instead of the departure. */
  airborne: boolean;
}

/** A plan's departure must be this close to where the flight began. */
const DEP_MATCH_NM = 8;
/** An air start must begin this close to the planned route. */
const ROUTE_MATCH_NM = 40;

/** Turns SimBrief's plan into what the app shows, and says whether it belongs to the flight that began at `start`. */
export function planInfo(m: Mapped, start: FlightStart | null, now: number, airportPos?: (icao: string) => { lat: number; lon: number } | null): FlightPlanInfo {
  const dep = m.airports.find((a) => a.role === "origin")!;
  const arr = m.airports.find((a) => a.role === "destination")!;
  const fixes = m.fixes.filter((f): f is typeof f & { lat: number; lon: number } => f.lat !== null && f.lon !== null).map((f) => ({ ident: f.ident, lat: f.lat, lon: f.lon }));
  const depPos = dep.lat != null && dep.lon != null ? { lat: dep.lat, lon: dep.lon } : (airportPos?.(dep.icao) ?? null);
  const arrPos = arr.lat != null && arr.lon != null ? { lat: arr.lat, lon: arr.lon } : (airportPos?.(arr.icao) ?? null);
  // The route as drawn: departure, the fixes, arrival.
  const line = [...(depPos ? [{ ident: dep.icao, ...depPos }] : []), ...fixes.filter((f) => f.ident !== dep.icao && f.ident !== arr.icao), ...(arrPos ? [{ ident: arr.icao, ...arrPos }] : [])];
  return {
    ofpId: m.ofp.ofpId ?? null,
    callsign: m.ofp.callsign,
    dep: dep.icao,
    arr: arr.icao,
    route: m.ofp.route,
    distanceNm: m.ofp.distanceNm,
    eteMin: m.ofp.eteMin,
    cruiseFt: m.ofp.cruiseFt,
    aircraft: m.ofp.aircraft,
    fixes: line.slice(0, 2000),
    matched: start ? matches(start, depPos, line) : false,
    loadedAt: now,
  };
}

function matches(start: FlightStart, depPos: { lat: number; lon: number } | null, line: Array<{ lat: number; lon: number }>): boolean {
  if (!start.airborne) return !!depPos && nm(start.lat, start.lon, depPos.lat, depPos.lon) <= DEP_MATCH_NM;
  return line.some((p) => nm(start.lat, start.lon, p.lat, p.lon) <= ROUTE_MATCH_NM);
}

export interface PlanSource {
  plan(refresh?: boolean): Promise<Mapped | null>;
}

/**
 * Keeps the SimBrief plan for the flight in progress: loads it again when you connect to VATSIM, when a flight
 * begins, and every couple of minutes until the wheels leave the ground (a plan made after spawning still counts).
 * Says when the plan that matches the flight changes, so it can be tied to the flight record and shown.
 */
export class PlanTracker {
  private cur: FlightPlanInfo | null = null;
  private cbs: Array<(p: FlightPlanInfo | null, why: string) => void> = [];

  constructor(
    private src: PlanSource,
    private log: Logger,
    private airportPos?: (icao: string) => { lat: number; lon: number } | null,
    private now: () => number = Date.now,
  ) {}

  current(): FlightPlanInfo | null {
    return this.cur;
  }
  onChange(cb: (p: FlightPlanInfo | null, why: string) => void) {
    this.cbs.push(cb);
  }

  /** Loads the plan again and works out whether it belongs to the flight that began at `start`. */
  async refresh(why: string, start: FlightStart | null, force = true): Promise<FlightPlanInfo | null> {
    let m: Mapped | null = null;
    try {
      m = await this.src.plan(force);
    } catch (e) {
      this.log.warn(`Couldn't load the SimBrief plan: ${(e as Error).message}`);
    }
    if (!m) return this.cur;
    const next = planInfo(m, start, this.now(), this.airportPos);
    const changed = !this.cur || this.cur.ofpId !== next.ofpId || this.cur.matched !== next.matched || this.cur.dep !== next.dep || this.cur.arr !== next.arr;
    this.cur = next;
    if (changed) {
      this.log.info(`SimBrief plan ${next.callsign ?? ""} ${next.dep}-${next.arr}${start ? (next.matched ? " (matches this flight)" : " (not for this flight: it began elsewhere)") : ""}`.replace(/\s+/g, " "));
      for (const cb of this.cbs) cb(next, why);
    }
    return next;
  }

  /** A new flight began: whatever plan was shown is checked against it again. */
  rematch(start: FlightStart | null) {
    if (!this.cur) return;
    void this.refresh("flight-start", start, false);
  }
}
