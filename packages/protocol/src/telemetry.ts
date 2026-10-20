import { z } from "zod";

/**
 * One snapshot of the user's aircraft. Units are in the field names' comments
 * and are fixed: the bridge converts everything before it goes on the wire, so
 * clients never have to guess.
 */
export const TelemetrySchema = z.object({
  // Position
  lat: z.number(), // degrees, +N
  lon: z.number(), // degrees, +E
  altMsl: z.number(), // feet
  altAgl: z.number(), // feet (radio height style, above ground under the aircraft)
  groundElev: z.number(), // feet MSL of the ground under the aircraft

  // Attitude / direction
  pitch: z.number(), // degrees, + nose up
  bank: z.number(), // degrees, + right wing down
  hdgTrue: z.number(), // degrees 0-360
  hdgMag: z.number(), // degrees 0-360
  track: z.number(), // degrees true, ground track 0-360

  // Speeds
  ias: z.number(), // knots
  tas: z.number(), // knots
  gs: z.number(), // knots
  mach: z.number(),
  vs: z.number(), // feet per minute, + climbing

  // State
  onGround: z.boolean(),
  gForce: z.number(),
  gearDown: z.boolean(), // gear handle position
  flapsIndex: z.number().int(),
  parkingBrake: z.boolean(),
  simRate: z.number(),

  // Autopilot (generic simvars; aircraft-specific FCU values come from adapters later)
  ap: z.object({
    master: z.boolean(),
    altSel: z.number(), // feet
    hdgSel: z.number(), // degrees
    spdSel: z.number(), // knots
    vsSel: z.number(), // fpm
  }),
});
export type Telemetry = z.infer<typeof TelemetrySchema>;

/** A telemetry snapshot stamped with its position in the bridge's stream. */
export const TelemetryFrameSchema = z.object({
  /** Monotonic within one bridge session. Gaps tell the client it missed frames. */
  seq: z.number().int().nonnegative(),
  /** Bridge clock, ms since epoch, when the snapshot was taken. */
  ts: z.number(),
  data: TelemetrySchema,
});
export type TelemetryFrame = z.infer<typeof TelemetryFrameSchema>;

export const SimStatusSchema = z.object({
  /** Bridge has a live SimConnect connection. */
  connected: z.boolean(),
  /** "simconnect" for the real sim, "mock" for the built-in test flight. */
  source: z.enum(["simconnect", "mock"]),
  paused: z.boolean(),
  /** Aircraft title from the sim, e.g. "FenixA320 ..." Empty when unknown. */
  aircraftTitle: z.string(),
  /** Simulator application name/version as reported by SimConnect, if known. */
  simName: z.string().optional(),
  /** Human-readable reason when not connected. */
  detail: z.string().optional(),
  /**
   * The aircraft is spawned and flying (or parked at its spawn point), not in the menu, loading, or watching a
   * replay. Only then are flights recorded, landings counted and the map trail drawn. Absent from older bridges.
   */
  inFlight: z.boolean().optional(),
  /** The aircraft's registration as the sim has it (ATC ID, e.g. "A7-BCE"). */
  atcId: z.string().optional(),
  /** The registration filed in your VATSIM flight plan's remarks (REG/...), while connected. */
  vatsimReg: z.string().optional(),
  /** The aircraft's ICAO type as the sim has it (ATC MODEL, e.g. "B788"). */
  atcModel: z.string().optional(),
  /** The flight being recorded, while there is one. */
  flight: z
    .object({
      /** Row in the bridge's flight log (null while it couldn't be written). */
      id: z.number().int().nullable(),
      startedAt: z.number(),
      /** The map trail is drawn from this time on: spawned and, when vPilot is linked, connected to VATSIM. Null = not yet. */
      trackSince: z.number().nullable(),
      /** Wheels up (PC clock), once the aircraft has taken off on this flight. */
      takeoffAt: z.number().nullable().optional(),
    })
    .nullable()
    .optional(),
});
export type SimStatus = z.infer<typeof SimStatusSchema>;
