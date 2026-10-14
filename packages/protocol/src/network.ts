import { z } from "zod";

/** Online networks the bridge can show. Only VATSIM is implemented so far. */
export const NetworkIdSchema = z.enum(["vatsim"]);
export type NetworkId = z.infer<typeof NetworkIdSchema>;

/** Another pilot on the network, as the bridge passes it on (already filtered to the area around you). */
export const NetPilotSchema = z.object({
  callsign: z.string(),
  lat: z.number(),
  lon: z.number(),
  alt: z.number(), // feet MSL (as reported by the pilot's client)
  gs: z.number(), // knots
  hdg: z.number(), // degrees true
  type: z.string().optional(), // ICAO aircraft type from the flight plan, e.g. A20N
  dep: z.string().optional(),
  arr: z.string().optional(),
  /** Great-circle distance from the centre of the requested area, nm. */
  distNm: z.number(),
});
export type NetPilot = z.infer<typeof NetPilotSchema>;

export const AtcFacilitySchema = z.enum(["fss", "del", "gnd", "twr", "app", "ctr"]);
export type AtcFacility = z.infer<typeof AtcFacilitySchema>;

export const AtcStationSchema = z.object({
  callsign: z.string(), // e.g. EDGG_N_CTR
  /** Radio name, from the sector data where known, e.g. "Langen Radar (North)". */
  name: z.string(),
  freq: z.string(), // "136.955"
  facility: AtcFacilitySchema,
  /** Point to show the station at: the airport for DEL/GND/TWR/APP, the sector label for CTR/FSS. */
  lat: z.number().nullable(),
  lon: z.number().nullable(),
  /** Key for /api/network/boundaries, or null if the station has no known area. */
  boundaryId: z.string().nullable(),
  /** ATIS text lines for this station's airport, when an ATIS is online. */
  atis: z.array(z.string()).optional(),
  /** ATIS letter when known. */
  atisCode: z.string().optional(),
});
export type AtcStation = z.infer<typeof AtcStationSchema>;

export const NetworkStatusSchema = z.object({
  network: z.union([NetworkIdSchema, z.literal("off")]),
  /** loading = no data yet; ok = recent data; stale = last poll failed but older data is shown; error = no data. */
  state: z.enum(["off", "loading", "ok", "stale", "error"]),
  detail: z.string().optional(),
  /** When the network last published the data (ms), or null. */
  updatedAt: z.number().nullable(),
  /** Whether sector shapes are available (needed for boundary alerts). */
  boundaries: z.boolean(),
});
export type NetworkStatus = z.infer<typeof NetworkStatusSchema>;

/** The station you should be talking to, or null for UNICOM, and the next one on your track. */
export const AtcPositionSchema = z.object({
  current: AtcStationSchema.nullable(),
  ahead: z
    .object({
      station: AtcStationSchema.nullable(), // null = leaving coverage into UNICOM
      etaSec: z.number(),
      distNm: z.number(),
    })
    .nullable(),
});
export type AtcPosition = z.infer<typeof AtcPositionSchema>;

export const AtcAlertSchema = z.object({
  id: z.string(),
  kind: z.enum(["contact", "unicom", "ahead"]),
  station: AtcStationSchema.nullable(),
  /** For "ahead": seconds until the boundary when the alert was raised. */
  etaSec: z.number().optional(),
  /** Ready-to-show sentence, e.g. "Contact Mumbai Approach on 127.900". */
  text: z.string(),
});
export type AtcAlert = z.infer<typeof AtcAlertSchema>;

/** UNICOM frequency used on VATSIM when no ATC covers you. */
export const UNICOM_FREQ = "122.800";
