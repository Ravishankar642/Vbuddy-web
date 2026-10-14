import { z } from "zod";

/**
 * Landing debrief records.
 *
 * Heights ("agl") in a landing are measured from the wheels-on-ground
 * reference at first touchdown (0 = the touchdown point), so they are not
 * thrown off by aircraft whose "altitude above ground" simvar doesn't read 0
 * on the runway. Descent rates are negative, like the live `vs` value.
 */

export const LandingRatingSchema = z.enum(["butter", "smooth", "normal", "firm", "hard", "severe"]);
export type LandingRating = z.infer<typeof LandingRatingSchema>;

/** One point of the approach/flare/rollout trace, ~10 per second. */
export const FlareSampleSchema = z.object({
  /** Seconds relative to first touchdown (negative = before). */
  t: z.number(),
  /** Feet above the touchdown point. */
  agl: z.number(),
  /** Feet per minute, negative = descending. */
  vs: z.number(),
  /** Degrees, positive = nose up. */
  pitch: z.number(),
  /** Knots indicated. */
  ias: z.number(),
  g: z.number(),
  onGround: z.boolean(),
});
export type FlareSample = z.infer<typeof FlareSampleSchema>;

export const LandingSummarySchema = z.object({
  id: z.string(),
  /** Bridge clock, ms since epoch, at first touchdown. */
  ts: z.number(),
  source: z.enum(["simconnect", "mock"]),
  aircraftTitle: z.string(),
  lat: z.number(),
  lon: z.number(),
  hdgTrue: z.number(),

  /** Descent rate at touchdown, fpm (negative). From the sim's own touchdown latch when available. */
  vsFpm: z.number(),
  vsSource: z.enum(["sim", "estimated"]),
  /** The rate worked out from the per-frame data, kept for cross-checking `vsFpm`. */
  vsEstimateFpm: z.number().nullable(),
  /** Peak G in the window from just before to one second after first contact. */
  gPeak: z.number(),
  /** Attitude and speed at first contact. */
  pitch: z.number(),
  bank: z.number(),
  iasKt: z.number(),
  gsKt: z.number(),

  bounces: z.number().int().nonnegative(),
  /** Highest bounce, feet above the touchdown point. 0 when there was none. */
  bounceMaxFt: z.number(),
  /** The aircraft took off again instead of stopping. */
  touchAndGo: z.boolean(),
  /** Frame timing around touchdown was too sparse to trust the estimate. */
  lowConfidence: z.boolean(),

  rating: LandingRatingSchema,
  /** Which measurement decided the rating. */
  ratedBy: z.enum(["vs", "g"]),

  /** Wind at touchdown. headwind < 0 is a tailwind; crosswind > 0 is from the right. */
  wind: z
    .object({
      speedKt: z.number(),
      fromDeg: z.number(),
      headwindKt: z.number(),
      crosswindKt: z.number(),
    })
    .nullable(),

  flare: z.object({
    /** Descent rate when passing these heights on the way down; null if not seen. */
    sinkAt50: z.number().nullable(),
    sinkAt30: z.number().nullable(),
    sinkAt10: z.number().nullable(),
    /** Fastest descent in the last 100 ft, and the height where it happened. */
    peakSinkFpm: z.number().nullable(),
    peakSinkAtFt: z.number().nullable(),
    /** How much the descent eased between that peak and touchdown (positive = eased). */
    easedByFpm: z.number().nullable(),
    /** Pitch change from 50 ft to touchdown, degrees (positive = pitched up). */
    pitchChange: z.number().nullable(),
  }),
});
export type LandingSummary = z.infer<typeof LandingSummarySchema>;

export const LandingSchema = LandingSummarySchema.extend({
  profile: z.array(FlareSampleSchema),
});
export type Landing = z.infer<typeof LandingSchema>;

export function summarize(l: Landing): LandingSummary {
  const { profile: _profile, ...rest } = l;
  return rest;
}
