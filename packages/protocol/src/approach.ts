import { z } from "zod";

/**
 * Stabilised-approach gates: at 1,000 ft and 500 ft above the ground on the way down, is the aircraft configured and
 * stable? The usual airline criteria, simplified to what the sim reports for every aircraft.
 */
export const ApproachCheckSchema = z.object({
  key: z.enum(["gear", "flaps", "sink", "speed", "bank", "path"]),
  label: z.string(),
  ok: z.boolean(),
  value: z.string(),
});
export type ApproachCheck = z.infer<typeof ApproachCheckSchema>;

export const ApproachGateSchema = z.object({
  heightFt: z.number(),
  at: z.number(),
  stable: z.boolean(),
  checks: z.array(ApproachCheckSchema),
});
export type ApproachGate = z.infer<typeof ApproachGateSchema>;

export const GATE_HEIGHTS = [1000, 500] as const;

/** Limits: sink no more than 1,000 fpm; speed steady within 10 kt over 10 s; bank under 15°; path 2–4°. */
export const APPROACH_LIMITS = { sinkFpm: 1000, speedSpreadKt: 10, bankDeg: 15, pathMinDeg: 2, pathMaxDeg: 4 } as const;

export interface GateInput {
  gearDown: boolean;
  flapsIndex: number;
  vs: number;
  gs: number;
  bank: number;
  /** Indicated airspeeds over the last ~10 s. */
  iasRecent: number[];
}

/** The descent angle from vertical speed and ground speed, degrees (1 kt = 101.27 ft/min). */
export function pathAngle(vsFpm: number, gsKt: number): number | null {
  if (gsKt < 40) return null;
  return (Math.atan2(-vsFpm, gsKt * 101.27) * 180) / Math.PI;
}

export function checkGate(heightFt: number, at: number, x: GateInput): ApproachGate {
  const L = APPROACH_LIMITS;
  const spread = x.iasRecent.length ? Math.max(...x.iasRecent) - Math.min(...x.iasRecent) : 0;
  const path = pathAngle(x.vs, x.gs);
  const checks: ApproachCheck[] = [
    { key: "gear", label: "Gear", ok: x.gearDown, value: x.gearDown ? "Down" : "Up" },
    { key: "flaps", label: "Flaps", ok: x.flapsIndex >= 2, value: `Position ${x.flapsIndex}` },
    { key: "sink", label: "Sink rate", ok: -x.vs <= L.sinkFpm, value: `${Math.round(-x.vs)} fpm` },
    { key: "speed", label: "Speed steady", ok: spread <= L.speedSpreadKt, value: `±${Math.round(spread / 2)} kt` },
    { key: "bank", label: "Bank", ok: Math.abs(x.bank) <= L.bankDeg, value: `${Math.round(Math.abs(x.bank))}°` },
    { key: "path", label: "Descent path", ok: path !== null && path >= L.pathMinDeg && path <= L.pathMaxDeg, value: path === null ? "–" : `${path.toFixed(1)}°` },
  ];
  return { heightFt, at, stable: checks.every((c) => c.ok), checks };
}
