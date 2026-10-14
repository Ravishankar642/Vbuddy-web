import type { FlightRow, TrackPoint } from "../db/flight-db.js";
import { AIRPORT_DATA } from "./airport-data.js";

export interface Airport {
  icao: string;
  lat: number;
  lon: number;
  name: string;
  country: string;
  size: "l" | "m" | "s";
}

const R_NM = 3440.065;
const rad = Math.PI / 180;
export function distanceNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const a = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The world's airports (ICAO-coded, from OurAirports), looked up by position. */
export class Airports {
  readonly list: Airport[];
  private byIcao = new Map<string, Airport>();
  /** 1-degree buckets so a nearest-airport search never scans the whole list. */
  private grid = new Map<number, Airport[]>();

  constructor(data: string = AIRPORT_DATA) {
    this.list = [];
    for (const line of data.split("\n")) {
      const [icao, lat, lon, name, country, size] = line.split("|");
      if (!icao || !lat || !lon) continue;
      const a: Airport = { icao, lat: Number(lat), lon: Number(lon), name: name ?? icao, country: country ?? "", size: (size as Airport["size"]) || "s" };
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
      this.list.push(a);
      this.byIcao.set(icao, a);
      const k = this.key(a.lat, a.lon);
      const cell = this.grid.get(k);
      if (cell) cell.push(a);
      else this.grid.set(k, [a]);
    }
  }
  private key(lat: number, lon: number) {
    return Math.floor(lat + 90) * 400 + Math.floor(lon + 180);
  }
  get(icao: string): Airport | null {
    return this.byIcao.get(icao.toUpperCase()) ?? null;
  }
  /**
   * The airport the position is at: within `maxNm`, preferring bigger airports
   * when two are about as near (a gate at a big airport is also near its little neighbour).
   */
  nearest(lat: number, lon: number, maxNm = 5): Airport | null {
    const la = Math.floor(lat + 90);
    const lo = Math.floor(lon + 180);
    let best: Airport | null = null;
    let bestScore = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cell = this.grid.get((la + dy) * 400 + ((lo + dx + 360) % 360));
        if (!cell) continue;
        for (const a of cell) {
          const d = distanceNm(lat, lon, a.lat, a.lon);
          if (d > maxNm) continue;
          const score = d + (a.size === "l" ? 0 : a.size === "m" ? 1.5 : 3);
          if (score < bestScore) {
            bestScore = score;
            best = a;
          }
        }
      }
    }
    return best;
  }
}

/** Length of a flown path in nautical miles (sum of the legs between recorded points). */
export function trackLengthNm(points: TrackPoint[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) {
    const p = points[i - 1]!;
    const q = points[i]!;
    if (![p[1], p[2], q[1], q[2]].every(Number.isFinite)) continue;
    const d = distanceNm(p[1], p[2], q[1], q[2]);
    if (d < 400) n += d; // a jump this long is a gap in the recording, not flying
  }
  return n;
}

export interface FlightFacts {
  /** The flight was flown on the route of the SimBrief plan that was filled in for it. Only these count in the Atlas. */
  onPlan: boolean;
  from: { icao: string; name: string } | null;
  to: { icao: string; name: string } | null;
  distanceNm: number;
}
export type FlightWithFacts = FlightRow & FlightFacts;

export interface AtlasAirport {
  icao: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  visits: number;
}
export interface Atlas {
  flights: number;
  flightMs: number;
  distanceNm: number;
  landings: number;
  airports: AtlasAirport[];
  countries: string[];
  aircraft: Array<{ name: string; flights: number; ms: number }>;
  longest: { id: number; ms: number } | null;
  farthest: { id: number; nm: number } | null;
}

/** Works out where each flight went and how far, remembering the answer (flights don't change once they've ended). */
export class AtlasService {
  private facts = new Map<string, FlightFacts>();
  constructor(
    private airports: Airports,
    private track: (id: number, max: number) => TrackPoint[] | null,
    /** Keeps a flight's distance, so it survives the telemetry being pruned. */
    private keep: (id: number, nm: number) => void = () => {},
  ) {}

  private factsFor(f: FlightRow, live: boolean): FlightFacts {
    const key = `${f.id}:${f.endedAt}:${f.frames}`;
    const hit = this.facts.get(key);
    if (hit) return hit;
    const pick = (lat: number | null, lon: number | null) => {
      if (lat === null || lon === null) return null;
      const a = this.airports.nearest(lat, lon);
      return a ? { icao: a.icao, name: a.name } : null;
    };
    let distanceNm = f.distanceNm ?? 0;
    if (f.distanceNm === null) {
      const pts = this.track(f.id, 400);
      if (pts && pts.length > 1) {
        distanceNm = Math.round(trackLengthNm(pts));
        if (!live) this.keep(f.id, distanceNm);
      }
    }
    const from = pick(f.startLat, f.startLon);
    const to = pick(f.endLat, f.endLon);
    const onPlan = !!f.planDep && !!f.planArr && from?.icao === f.planDep && to?.icao === f.planArr;
    const out: FlightFacts = { onPlan, from, to, distanceNm };
    if (!live && (f.distanceNm !== null || distanceNm > 0)) this.facts.set(key, out);
    return out;
  }

  withFacts(flights: FlightRow[], now = Date.now()): FlightWithFacts[] {
    return flights.map((f) => ({ ...f, ...this.factsFor(f, now - f.endedAt < 120_000) }));
  }

  /** Totals for the flights flown on a SimBrief plan's route. Other recorded flights are not logged here. */
  atlas(flights: FlightRow[], now = Date.now()): Atlas {
    const all = this.withFacts(flights, now).filter((f) => f.onPlan);
    const visits = new Map<string, AtlasAirport>();
    const see = (a: { icao: string } | null) => {
      if (!a) return;
      const ap = this.airports.get(a.icao);
      if (!ap) return;
      const v = visits.get(ap.icao);
      if (v) v.visits++;
      else visits.set(ap.icao, { icao: ap.icao, name: ap.name, country: ap.country, lat: ap.lat, lon: ap.lon, visits: 1 });
    };
    const types = new Map<string, { name: string; flights: number; ms: number }>();
    let ms = 0;
    let nm = 0;
    let longest: Atlas["longest"] = null;
    let farthest: Atlas["farthest"] = null;
    for (const f of all) {
      const dur = Math.max(0, f.endedAt - f.startedAt);
      ms += dur;
      nm += f.distanceNm;
      see(f.from);
      if (f.to && f.to.icao !== f.from?.icao) see(f.to);
      const name = f.aircraft || "Unknown aircraft";
      const t = types.get(name) ?? { name, flights: 0, ms: 0 };
      t.flights++;
      t.ms += dur;
      types.set(name, t);
      if (!longest || dur > longest.ms) longest = { id: f.id, ms: dur };
      if (!farthest || f.distanceNm > farthest.nm) farthest = { id: f.id, nm: f.distanceNm };
    }
    const airports = [...visits.values()].sort((a, b) => b.visits - a.visits || a.icao.localeCompare(b.icao));
    return {
      flights: all.length,
      flightMs: ms,
      distanceNm: Math.round(nm),
      landings: all.reduce((n, f) => n + f.landings, 0),
      airports,
      countries: [...new Set(airports.map((a) => a.country).filter(Boolean))].sort(),
      aircraft: [...types.values()].sort((a, b) => b.ms - a.ms),
      longest,
      farthest,
    };
  }
}
