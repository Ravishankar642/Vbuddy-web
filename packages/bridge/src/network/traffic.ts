import type { NetPilot } from "@vbuddy/protocol";
import { distNm } from "./geo.js";
import type { OwnPosition } from "./coverage.js";
import type { RawPilot } from "./vatsim-feed.js";

export const MAX_TRAFFIC = 300;

/** Pilots within radiusNm of the centre, nearest first, at most `max`, without `exclude`. */
export function filterTraffic(pilots: RawPilot[], lat: number, lon: number, radiusNm: number, exclude: string | null, max = MAX_TRAFFIC): NetPilot[] {
  // Cheap latitude pre-filter before the trig.
  const dLat = radiusNm / 60 + 0.1;
  const out: NetPilot[] = [];
  for (const p of pilots) {
    if (p.callsign === exclude || Math.abs(p.lat - lat) > dLat) continue;
    const d = distNm(lat, lon, p.lat, p.lon);
    if (d <= radiusNm) out.push({ ...p, distNm: Math.round(d * 10) / 10 });
  }
  out.sort((a, b) => a.distNm - b.distNm);
  return out.length > max ? out.slice(0, max) : out;
}

/** How old network positions can be compared with the sim's (the feed refreshes every 15 s). */
const LAG_S = 25;

function tolerance(own: OwnPosition & { vs?: number }) {
  return { nm: 1 + (own.gs * LAG_S) / 3600, ft: 500 + (Math.abs(own.vs ?? 0) * LAG_S) / 60 };
}
const hdgDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Finds you on the network: the one pilot where your aircraft is (allowing for the
 * feed's delay). Sticks with the previous answer while it still fits. Returns null
 * when nobody (or more than one pilot) fits.
 */
export function detectSelf(pilots: RawPilot[], own: OwnPosition & { vs?: number }, prev: string | null): string | null {
  const tol = tolerance(own);
  const fits = (p: RawPilot, scale: number) =>
    distNm(own.lat, own.lon, p.lat, p.lon) <= tol.nm * scale &&
    Math.abs(p.alt - own.altMsl) <= tol.ft * scale &&
    (own.gs < 40 || p.gs < 40 || hdgDiff(p.hdg, own.track) <= 35 * scale);
  if (prev) {
    const p = pilots.find((x) => x.callsign === prev);
    if (p && fits(p, 2)) return prev;
  }
  const matches = pilots.filter((p) => fits(p, 1));
  return matches.length === 1 ? matches[0]!.callsign : null;
}
