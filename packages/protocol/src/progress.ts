import { z } from "zod";

/**
 * Flight progress: where you are along the SimBrief route, against the plan's vertical profile and fuel.
 * The plan's profile comes once with the flight plan; the bridge works out the rest every few seconds.
 */

/** One navlog fix of the plan, with what SimBrief planned there. */
export const ProfilePointSchema = z.object({
  ident: z.string(),
  lat: z.number(),
  lon: z.number(),
  /** Along the route from the departure, nm. */
  distNm: z.number(),
  /** Planned altitude, ft. */
  altFt: z.number(),
  /** Planned fuel on board at this fix, kg (null when SimBrief left it out). */
  fuelKg: z.number().nullable(),
  /** Planned time from takeoff, minutes. */
  timeMin: z.number().nullable(),
  stage: z.enum(["CLB", "CRZ", "DSC"]).nullable(),
  /** SimBrief's forecast wind at this fix (direction it blows from, degrees true; speed, kt). */
  windDeg: z.number().nullable().optional(),
  windKt: z.number().nullable().optional(),
});
export type ProfilePoint = z.infer<typeof ProfilePointSchema>;

/** SimBrief's fuel figures, kg. */
export const FuelPlanSchema = z.object({
  takeoffKg: z.number().nullable(),
  landingKg: z.number().nullable(),
  reserveKg: z.number().nullable(),
  alternateKg: z.number().nullable(),
  /** Reserve plus alternate: landing with less than this means you're into reserves. */
  minLandingKg: z.number().nullable(),
});
export type FuelPlan = z.infer<typeof FuelPlanSchema>;

export const ProgressSchema = z.object({
  /** Along the route from the departure, nm. */
  alongNm: z.number(),
  totalNm: z.number(),
  remainingNm: z.number(),
  /** How far off the route line, nm. */
  offRouteNm: z.number(),
  /** The next fix ahead. */
  nextFix: z.string().nullable(),
  nextFixNm: z.number().nullable(),
  /** Altitude the plan has here, and how far above (+) or below (-) it you are, ft. */
  plannedAltFt: z.number().nullable(),
  altDevFt: z.number().nullable(),
  /** "high"/"low" only in the descent, where it matters (more than 1,000 ft off the plan's path). */
  vertical: z.enum(["ok", "high", "low"]).nullable(),
  /** To the top of descent, nm (negative once past it); null when the plan has no descent. */
  todNm: z.number().nullable(),
  /** Fuel on board now, what the plan has here, and the difference, kg. */
  fuelKg: z.number().nullable(),
  plannedFuelKg: z.number().nullable(),
  fuelDevKg: z.number().nullable(),
  /** What you'll land with at this rate: fuel now minus what the plan burns from here. */
  predLandingKg: z.number().nullable(),
  minLandingKg: z.number().nullable(),
  /** ok; low: landing below reserve + alternate; critical: landing below the final reserve. */
  fuelState: z.enum(["ok", "low", "critical"]).nullable(),
  /** The forecast wind along the rest of the route, averaged by distance: + tailwind, - headwind, kt (null without wind data). */
  windRestKt: z.number().nullable().optional(),
});
export type Progress = z.infer<typeof ProgressSchema>;

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;

export function distNm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Where `p` falls on segment a→b: the fraction along it (0..1) and the distance off it, nm (flat earth near the segment). */
function onSegment(p: { lat: number; lon: number }, a: ProfilePoint, b: ProfilePoint): { f: number; off: number } {
  const k = Math.cos(rad((a.lat + b.lat) / 2));
  const ax = a.lon * k;
  const bx = b.lon * k;
  const px = p.lon * k;
  const dx = bx - ax;
  const dy = b.lat - a.lat;
  const len2 = dx * dx + dy * dy;
  const f = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (p.lat - a.lat) * dy) / len2));
  const off = distNm(p.lat, p.lon, a.lat + dy * f, (ax + dx * f) / k);
  return { f, off };
}

/** Initial great-circle bearing a→b, degrees true. */
export function bearing(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const y = Math.sin(rad(bLon - aLon)) * Math.cos(rad(bLat));
  const x = Math.cos(rad(aLat)) * Math.sin(rad(bLat)) - Math.sin(rad(aLat)) * Math.cos(rad(bLat)) * Math.cos(rad(bLon - aLon));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const lerp = (a: number, b: number, f: number) => a + (b - a) * f;
function lerpN(a: number | null, b: number | null, f: number): number | null {
  if (a === null || b === null) return a ?? b;
  return lerp(a, b, f);
}

export interface ProgressInput {
  lat: number;
  lon: number;
  /** The altimeter's reading, ft. */
  altFt: number;
  onGround: boolean;
  fuelKg: number | null;
}

/**
 * Where the aircraft is against the plan. `hint` is the segment it was on last time, so a route that comes back near
 * itself doesn't make it jump back.
 */
export function computeProgress(profile: ProfilePoint[], fuel: FuelPlan | null, now: ProgressInput, hint = 0): { progress: Progress; segment: number } | null {
  if (profile.length < 2) return null;
  // Segments behind the last one count only if they are much closer (25 nm), so the position never slides back.
  let best = { i: 0, f: 0, off: Infinity, score: Infinity };
  for (let i = 0; i < profile.length - 1; i++) {
    const s = onSegment(now, profile[i]!, profile[i + 1]!);
    const score = s.off + (i < hint ? 25 : 0);
    if (score < best.score - 0.01) best = { i, f: s.f, off: s.off, score };
  }
  const a = profile[best.i]!;
  const b = profile[best.i + 1]!;
  const total = profile[profile.length - 1]!.distNm;
  const along = lerp(a.distNm, b.distNm, best.f);
  const plannedAlt = lerp(a.altFt, b.altFt, best.f);
  const airborne = !now.onGround;
  const altDev = airborne ? now.altFt - plannedAlt : null;

  const todIdx = profile.findIndex((p) => p.stage === "DSC");
  const tod = todIdx > 0 ? profile[todIdx - 1]!.distNm : null;
  const descending = tod !== null && along >= tod;
  const vertical = altDev === null ? null : descending ? (altDev > 1000 ? "high" : altDev < -1000 ? "low" : "ok") : "ok";

  const next = best.f >= 0.999 ? profile[best.i + 2] ?? null : b;
  const plannedFuel = lerpN(a.fuelKg, b.fuelKg, best.f);
  const landingPlan = fuel?.landingKg ?? profile[profile.length - 1]!.fuelKg;
  const pred = now.fuelKg !== null && plannedFuel !== null && landingPlan !== null ? now.fuelKg - (plannedFuel - landingPlan) : null;
  const minLanding = fuel?.minLandingKg ?? null;
  const reserve = fuel?.reserveKg ?? null;
  const fuelState = pred === null || minLanding === null ? null : reserve !== null && pred < reserve ? "critical" : pred < minLanding ? "low" : "ok";

  // The forecast wind for the rest of the route: each leg's wind (at its end fix) along its track, weighted by distance left.
  let wSum = 0;
  let wLen = 0;
  for (let i = best.i; i < profile.length - 1; i++) {
    const p = profile[i]!;
    const q = profile[i + 1]!;
    if (q.windDeg == null || q.windKt == null) continue;
    const len = (q.distNm - p.distNm) * (i === best.i ? 1 - best.f : 1);
    if (len <= 0) continue;
    const trk = bearing(p.lat, p.lon, q.lat, q.lon);
    wSum += -q.windKt * Math.cos(rad(q.windDeg - trk)) * len;
    wLen += len;
  }

  const progress: Progress = {
    alongNm: round(along, 1),
    totalNm: round(total, 1),
    remainingNm: round(Math.max(0, total - along), 1),
    offRouteNm: round(best.off, 1),
    nextFix: next?.ident ?? null,
    nextFixNm: next ? round(distNm(now.lat, now.lon, next.lat, next.lon), 1) : null,
    plannedAltFt: Math.round(plannedAlt),
    altDevFt: altDev === null ? null : Math.round(altDev),
    vertical,
    todNm: tod === null ? null : round(tod - along, 1),
    fuelKg: now.fuelKg === null ? null : Math.round(now.fuelKg),
    plannedFuelKg: plannedFuel === null ? null : Math.round(plannedFuel),
    fuelDevKg: now.fuelKg !== null && plannedFuel !== null ? Math.round(now.fuelKg - plannedFuel) : null,
    predLandingKg: pred === null ? null : Math.round(pred),
    minLandingKg: minLanding,
    fuelState,
    windRestKt: wLen > 0 ? Math.round(wSum / wLen) : null,
  };
  return { progress, segment: best.i };
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
