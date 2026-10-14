import type { AtcFacility, AtcStation } from "@vbuddy/protocol";
import { circleArea, mergeAreas, type Area } from "./geo.js";
import type { SectorData } from "./sectors.js";
import type { RawAtis, RawController } from "./vatsim-feed.js";

/** An online station plus where it works, ready for coverage checks. */
export interface PlacedStation {
  station: AtcStation;
  area: Area | null;
}

/** Approach radius used when a station has no published approach shape. */
export const APP_CIRCLE_NM = 35;

const BY_SUFFIX: Record<string, AtcFacility> = { FSS: "fss", DEL: "del", GND: "gnd", TWR: "twr", APP: "app", DEP: "app", CTR: "ctr" };
const BY_NUMBER: Record<number, AtcFacility> = { 1: "fss", 2: "del", 3: "gnd", 4: "twr", 5: "app", 6: "ctr" };
const ROLE: Record<string, string> = { FSS: "Radio", DEL: "Delivery", GND: "Ground", TWR: "Tower", APP: "Approach", DEP: "Departure", CTR: "Control" };

/** Not real positions: observers, supervisors' placeholder frequency, ATIS (handled separately). */
function skip(c: RawController) {
  const suffix = c.callsign.split("_").filter(Boolean).at(-1) ?? "";
  return c.freq.startsWith("199.998") || suffix === "ATIS" || suffix === "OBS" || (c.facility === 0 && !(suffix in BY_SUFFIX));
}

/** "EDGG_N_CTR" -> parts EDGG, N and suffix CTR; prefixes from most to least specific: EDGG_N, EDGG. */
function split(callsign: string) {
  const parts = callsign.toUpperCase().split("_").filter(Boolean);
  const suffix = parts.length > 1 ? parts[parts.length - 1]! : "";
  const body = parts.length > 1 ? parts.slice(0, -1) : parts;
  const prefixes: string[] = [];
  for (let k = body.length; k >= 1; k--) prefixes.push(body.slice(0, k).join("_"));
  return { suffix, body, prefixes };
}

/** The sector names in the data are often a bare place name ("Mumbai"); give those a role word. */
function withRole(name: string, suffix: string) {
  return /radar|control|center|centre|information|oceanic|radio|approach|departure|tower|ground|delivery|director|arrival/i.test(name) ? name : `${name} ${ROLE[suffix] ?? ""}`.trim();
}

const cleanFreq = (f: string) => {
  const n = Number(f);
  return Number.isFinite(n) && n > 100 ? n.toFixed(3) : f;
};

/**
 * Matches online controllers to sector shapes, the same way VATSpy and SimAware do:
 * - CTR/FSS: callsign prefix (most specific first) -> FIR; else a UIR (union of its FIRs).
 * - APP/DEP: TRACON shape with that prefix and suffix (DEP falls back to APP); else a circle round the airport.
 * - TWR: a published tower shape if there is one; otherwise the airport point.
 * - DEL/GND: the airport point.
 */
export function placeStations(controllers: RawController[], atis: RawAtis[], sectors: SectorData | null): { placed: PlacedStation[]; areas: Map<string, Area> } {
  const areas = new Map<string, Area>();
  const placed: PlacedStation[] = [];

  const atisByAirport = new Map<string, RawAtis>();
  for (const a of atis) {
    const ap = split(a.callsign).body[0];
    if (ap && !atisByAirport.has(ap)) atisByAirport.set(ap, a);
  }

  for (const c of controllers) {
    if (skip(c)) continue;
    const { suffix, body, prefixes } = split(c.callsign);
    const facility = BY_SUFFIX[suffix] ?? BY_NUMBER[c.facility];
    if (!facility) continue;
    const airport = sectors?.airports.get(body[0] ?? "") ?? null;

    let name = "";
    let boundaryId: string | null = null;
    let area: Area | null = null;
    let lat: number | null = airport?.lat ?? null;
    let lon: number | null = airport?.lon ?? null;

    if (sectors && (facility === "ctr" || facility === "fss")) {
      for (const p of prefixes) {
        const fir = sectors.firByPrefix.get(p);
        const shape = fir ? sectors.firShapes.get(fir.boundary) : undefined;
        if (fir && shape) {
          boundaryId = `fir:${fir.boundary}`;
          area = shape.area;
          name = fir.name.replace(/\s+-\s+.*$/, "");
          lat = shape.labelLat ?? (shape.area.bbox[1] + shape.area.bbox[3]) / 2;
          lon = shape.labelLon ?? (shape.area.bbox[0] + shape.area.bbox[2]) / 2;
          break;
        }
        const uir = sectors.uirs.get(p);
        if (uir) {
          const parts = uir.firs.flatMap((icao) => (sectors.firByIcao.get(icao) ?? []).slice(0, 1)).map((f) => sectors.firShapes.get(f.boundary)?.area).filter((a): a is Area => !!a);
          if (parts.length) {
            area = mergeAreas(parts);
            boundaryId = `uir:${uir.icao}`;
            name = uir.name;
            lat = (area.bbox[1] + area.bbox[3]) / 2;
            lon = (area.bbox[0] + area.bbox[2]) / 2;
            break;
          }
        }
      }
    } else if (sectors && (facility === "app" || facility === "twr")) {
      const want = facility === "twr" ? ["TWR"] : suffix === "DEP" ? ["DEP", "APP"] : ["APP"];
      search: for (const w of want)
        for (const p of prefixes)
          for (const t of sectors.tracons)
            if (t.suffix === w && t.prefixes.includes(p)) {
              boundaryId = `tracon:${t.index}`;
              area = t.area;
              name = t.name;
              break search;
            }
      if (!area && facility === "app" && airport) {
        boundaryId = `circle:${airport.icao}`;
        area = circleArea(airport.lat, airport.lon, APP_CIRCLE_NM);
      }
    }

    if (!name) name = airport ? `${airport.name} ${ROLE[suffix] ?? ""}`.trim() : c.callsign;
    else name = withRole(name, suffix);
    if (boundaryId && area) areas.set(boundaryId, area);

    const a = facility !== "ctr" && facility !== "fss" ? atisByAirport.get(body[0] ?? "") : undefined;
    placed.push({
      station: {
        callsign: c.callsign,
        name,
        freq: cleanFreq(c.freq),
        facility,
        lat,
        lon,
        boundaryId,
        ...(a ? { atis: a.text, ...(a.code ? { atisCode: a.code } : {}) } : {}),
      },
      area,
    });
  }
  placed.sort((a, b) => a.station.callsign.localeCompare(b.station.callsign));
  return { placed, areas };
}
