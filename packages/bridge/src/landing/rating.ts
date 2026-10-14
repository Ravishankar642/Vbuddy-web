import type { LandingRating } from "@vbuddy/protocol";

/**
 * Landing rating. Two independent measures; the worse one decides.
 *
 *   rating    descent rate (fpm, magnitude)    peak G
 *   butter    <= 100                           <= 1.20
 *   smooth    <= 200                           <= 1.40
 *   normal    <= 300                           <= 1.60
 *   firm      <= 450                           <= 1.85
 *   hard      <= 600                           <= 2.10
 *   severe    > 600                            > 2.10
 *
 * These are the project's own bands, tuned for sim use, not an airline or
 * manufacturer standard. The G figure is the sim's per-frame value, which is a
 * coarser measure than a real accelerometer.
 */
const ORDER: LandingRating[] = ["butter", "smooth", "normal", "firm", "hard", "severe"];
const VS_LIMITS = [100, 200, 300, 450, 600];
const G_LIMITS = [1.2, 1.4, 1.6, 1.85, 2.1];

const band = (v: number, limits: number[]) => {
  const i = limits.findIndex((l) => v <= l);
  return i === -1 ? limits.length : i;
};

export function rateLanding(vsFpm: number, gPeak: number): { rating: LandingRating; ratedBy: "vs" | "g" } {
  const byVs = band(Math.abs(vsFpm), VS_LIMITS);
  const byG = band(gPeak, G_LIMITS);
  // G only wins when it is strictly worse, so a tie reports the descent rate.
  return byG > byVs ? { rating: ORDER[byG]!, ratedBy: "g" } : { rating: ORDER[byVs]!, ratedBy: "vs" };
}
