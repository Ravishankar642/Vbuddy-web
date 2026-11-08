import type { Fetcher } from "./weather.js";
import { WEATHER_HOST } from "./weather.js";

/** A SIGMET area for the map: hazard, levels, valid until, and its outline. */
export interface SigmetArea {
  hazard: string;
  qualifier: string | null;
  baseFt: number | null;
  topFt: number | null;
  validTo: number | null;
  firName: string | null;
  raw: string | null;
  /** Outline rings as [lat, lon] pairs (rounded to 0.01°). */
  rings: Array<Array<[number, number]>>;
}

const TTL_MS = 15 * 60_000;
type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const s = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Picks what the map needs out of the Aviation Weather Center's international SIGMET GeoJSON. */
export function mapSigmets(j: unknown): SigmetArea[] {
  const feats = isObj(j) && Array.isArray(j.features) ? j.features : [];
  const out: SigmetArea[] = [];
  for (const f of feats) {
    if (!isObj(f) || !isObj(f.properties) || !isObj(f.geometry)) continue;
    const p = f.properties;
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" && Array.isArray(g.coordinates) ? g.coordinates : [];
    const rings: Array<Array<[number, number]>> = [];
    for (const poly of polys as unknown[]) {
      if (!Array.isArray(poly) || !Array.isArray(poly[0])) continue;
      const ring = (poly[0] as unknown[]).filter((c): c is [number, number] => Array.isArray(c) && typeof c[0] === "number" && typeof c[1] === "number").map(([lon, lat]) => [r2(lat), r2(lon)] as [number, number]);
      if (ring.length >= 3) rings.push(ring);
    }
    if (!rings.length) continue;
    // Seconds since 1970 in the JSON feed, possibly an ISO time in the GeoJSON: take either.
    const toN = n(p.validTimeTo);
    const toS = toN === null ? s(p.validTimeTo) : null;
    out.push({
      hazard: s(p.hazard) ?? "SIGMET",
      qualifier: s(p.qualifier),
      baseFt: n(p.base),
      topFt: n(p.top),
      validTo: toN !== null ? (toN < 1e12 ? toN * 1000 : toN) : toS ? Date.parse(toS) || null : null,
      firName: s(p.firName),
      raw: s(p.rawSigmet),
      rings,
    });
  }
  return out;
}

/** International SIGMETs, fetched only when a map with weather on asks, and kept 15 minutes. */
export class Sigmets {
  private cache: { at: number; areas: SigmetArea[] } | null = null;
  private pending: Promise<SigmetArea[]> | null = null;
  constructor(private fetcher: Fetcher) {}

  async get(now = Date.now()): Promise<SigmetArea[]> {
    if (this.cache && now - this.cache.at < TTL_MS) return this.cache.areas;
    this.pending ??= (async () => {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 10_000);
        try {
          const r = await this.fetcher(`${WEATHER_HOST}/api/data/isigmet?format=geojson`, { signal: ctl.signal, headers: { "user-agent": "VBuddy" } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const areas = mapSigmets(await r.json()).filter((a) => a.validTo === null || a.validTo > now);
          this.cache = { at: now, areas };
          return areas;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        return this.cache?.areas ?? [];
      } finally {
        this.pending = null;
      }
    })();
    return this.pending;
  }
}
