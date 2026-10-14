import { z } from "zod";

/** Hoppie ACARS: telex, CPDLC-style messages, predeparture clearance and weather requests. */

export const AcarsMessageSchema = z.object({
  id: z.string(),
  ts: z.number(),
  dir: z.enum(["in", "out"]),
  /** The other station (ATC unit, another aircraft, or SERVER for information replies). */
  peer: z.string(),
  kind: z.enum(["telex", "cpdlc", "info", "system"]),
  text: z.string(),
  /** CPDLC only: this message's own number, so a reply can point back at it. */
  min: z.number().int().optional(),
  /** CPDLC only: which answers the station wants. */
  answers: z.array(z.enum(["WILCO", "UNABLE", "ROGER", "AFFIRM", "NEGATIVE", "STANDBY"])).optional(),
  /** CPDLC only: the answer already sent. */
  answered: z.string().optional(),
});
export type AcarsMessage = z.infer<typeof AcarsMessageSchema>;

export const AcarsStateSchema = z.object({
  /** A Hoppie logon code is saved on the bridge PC. */
  configured: z.boolean(),
  /** Who messages are sent as (the VATSIM callsign, else the SimBrief one). Null = unknown yet. */
  callsign: z.string().nullable(),
  /** The bridge is checking for new messages now and then. */
  polling: z.boolean(),
  lastPollAt: z.number().nullable(),
  /** The last problem, in words the pilot can act on. Null when all is well. */
  error: z.string().nullable(),
  /** CPDLC station the pilot has asked to log on to, if any. */
  logon: z.string().nullable(),
  messages: z.array(AcarsMessageSchema),
});
export type AcarsState = z.infer<typeof AcarsStateSchema>;

const station = z.string().regex(/^[A-Za-z0-9_-]{2,12}$/);
export const AcarsCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("telex"), to: station, text: z.string().min(1).max(220) }),
  z.object({ op: z.literal("info"), kind: z.enum(["metar", "taf", "atis"]), icao: z.string().regex(/^[A-Za-z][A-Za-z0-9]{3}$/) }),
  /** Predeparture clearance request, filled in from the SimBrief plan. */
  z.object({ op: z.literal("pdc"), to: station, stand: z.string().max(8).optional(), atis: z.string().regex(/^[A-Za-z]$/).optional() }),
  z.object({ op: z.literal("cpdlcLogon"), to: station }),
  z.object({ op: z.literal("cpdlcReply"), id: z.string().max(40), answer: z.enum(["WILCO", "UNABLE", "ROGER", "AFFIRM", "NEGATIVE", "STANDBY"]) }),
  z.object({ op: z.literal("poll") }),
  z.object({ op: z.literal("clear") }),
]);
export type AcarsCommand = z.infer<typeof AcarsCommandSchema>;
