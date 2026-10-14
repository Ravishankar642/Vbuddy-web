import { areaFromGeometry, type Area } from "./geo.js";

/**
 * Sector data from the VATSpy data project (VATSpy.dat + Boundaries.geojson,
 * CC BY-SA 4.0) and the SimAware TRACON project (TRACONBoundaries.geojson).
 * Parsing is tolerant: a bad line or feature is skipped, never fatal.
 */

export interface Airport {
  icao: string;
  name: string;
  lat: number;
  lon: number;
}
export interface Fir {
  icao: string;
  name: string;
  boundary: string;
}
export interface Uir {
  icao: string;
  name: string;
  firs: string[];
}
export interface Tracon {
  index: number;
  prefixes: string[];
  /** Station type this shape is for: APP unless the data says otherwise (DEP, TWR...). */
  suffix: string;
  name: string;
  area: Area;
  labelLat: number | null;
  labelLon: number | null;
}
export interface FirShape {
  area: Area;
  labelLat: number | null;
  labelLon: number | null;
}

export interface SectorData {
  /** By ICAO code and by IATA/LID code (US "LAX_APP" style callsigns use the latter). */
  airports: Map<string, Airport>;
  /** By callsign prefix (the FIR's ICAO code when the data gives no prefix). */
  firByPrefix: Map<string, Fir>;
  /** By FIR ICAO code (used to expand UIRs). */
  firByIcao: Map<string, Fir[]>;
  uirs: Map<string, Uir>;
  firShapes: Map<string, FirShape>;
  tracons: Tracon[];
}

export function emptySectors(): SectorData {
  return { airports: new Map(), firByPrefix: new Map(), firByIcao: new Map(), uirs: new Map(), firShapes: new Map(), tracons: [] };
}

export function parseVatspyDat(text: string, into: SectorData = emptySectors()): SectorData {
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    const f = line.split("|").map((s) => s.trim());
    if (section === "airports" && f.length >= 6) {
      const lat = Number(f[2]);
      const lon = Number(f[3]);
      if (!f[0] || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const ap: Airport = { icao: f[0].toUpperCase(), name: f[1] ?? f[0], lat, lon };
      if (f[6] !== "1" && !into.airports.has(ap.icao)) into.airports.set(ap.icao, ap);
      const lid = f[4]?.toUpperCase();
      if (lid && !into.airports.has(lid)) into.airports.set(lid, ap);
    } else if (section === "firs" && f.length >= 4) {
      const fir: Fir = { icao: f[0]!.toUpperCase(), name: f[1] || f[0]!, boundary: f[3] || f[0]! };
      const prefix = (f[2] || f[0]!).toUpperCase();
      if (!into.firByPrefix.has(prefix)) into.firByPrefix.set(prefix, fir);
      const list = into.firByIcao.get(fir.icao) ?? [];
      list.push(fir);
      into.firByIcao.set(fir.icao, list);
    } else if (section === "uirs" && f.length >= 3) {
      const icao = f[0]!.toUpperCase();
      into.uirs.set(icao, { icao, name: f[1] || icao, firs: f[2]!.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) });
    }
  }
  return into;
}

interface Feature {
  properties?: Record<string, unknown>;
  geometry?: unknown;
}
const features = (json: unknown): Feature[] => {
  const fs = (json as { features?: unknown })?.features;
  return Array.isArray(fs) ? (fs as Feature[]) : [];
};
const numOrNull = (v: unknown) => {
  const n = Number(v);
  return v === undefined || v === null || v === "" || !Number.isFinite(n) ? null : n;
};

export function parseFirBoundaries(json: unknown, into: SectorData = emptySectors()): SectorData {
  for (const f of features(json)) {
    const id = String(f.properties?.id ?? "");
    const area = areaFromGeometry(f.geometry);
    if (!id || !area) continue;
    into.firShapes.set(id, { area, labelLat: numOrNull(f.properties?.label_lat), labelLon: numOrNull(f.properties?.label_lon) });
  }
  return into;
}

export function parseTraconBoundaries(json: unknown, into: SectorData = emptySectors()): SectorData {
  for (const f of features(json)) {
    const p = f.properties ?? {};
    const prefixes = (Array.isArray(p.prefix) ? p.prefix : [p.prefix]).filter((x): x is string => typeof x === "string" && x.length > 0).map((s) => s.toUpperCase());
    const area = areaFromGeometry(f.geometry);
    if (!prefixes.length || !area) continue;
    into.tracons.push({
      index: into.tracons.length,
      prefixes,
      suffix: typeof p.suffix === "string" && p.suffix ? p.suffix.toUpperCase() : "APP",
      name: typeof p.name === "string" ? p.name : prefixes[0]!,
      area,
      labelLat: numOrNull(p.label_lat),
      labelLon: numOrNull(p.label_lon),
    });
  }
  return into;
}
