import { z } from "zod";

/** Knobs that turn in clicks. baro1 = captain's EFIS baro knob. */
export const KnobIdSchema = z.enum(["spd", "hdg", "alt", "vs", "baro1"]);
export type KnobId = z.infer<typeof KnobIdSchema>;

/** FCU knobs you can push (managed / level off) and pull (selected). baro1: push = QNH, pull = STD. */
export const PushPullIdSchema = z.enum(["spd", "hdg", "alt", "vs", "baro1"]);
export type PushPullId = z.infer<typeof PushPullIdSchema>;

export const ButtonIdSchema = z.enum([
  "ap1",
  "ap2",
  "athr",
  "loc",
  "appr",
  "exped",
  "spdMach",
  "hdgTrk",
  "metric",
  "fd1",
  "ls1",
  "cstr1",
  "wpt1",
  "vord1",
  "ndb1",
  "arpt1",
]);
export type ButtonId = z.infer<typeof ButtonIdSchema>;

export const CockpitCommandSchema = z.discriminatedUnion("op", [
  /** Turn a knob by whole clicks (+ = clockwise). */
  z.object({ op: z.literal("turn"), ctl: KnobIdSchema, clicks: z.number().int().min(-50).max(50).refine((n) => n !== 0) }),
  z.object({ op: z.literal("push"), ctl: PushPullIdSchema }),
  z.object({ op: z.literal("pull"), ctl: PushPullIdSchema }),
  z.object({ op: z.literal("press"), ctl: ButtonIdSchema }),
  /** ND mode selector, 0..4 = ROSE LS, ROSE VOR, ROSE NAV, ARC, PLAN. */
  z.object({ op: z.literal("ndMode"), efis: z.literal(1), value: z.number().int().min(0).max(4) }),
  /** Dial the FCU window to an exact value (the bridge turns the knob and reads it back). */
  z.object({ op: z.literal("target"), ctl: z.enum(["spd", "hdg", "alt", "vs"]), value: z.number().min(-10000).max(50000) }),
]);
export type CockpitCommand = z.infer<typeof CockpitCommandSchema>;

/** What the Fenix FCU and captain's EFIS show. Values are what the windows display. */
export const FcuStateSchema = z.object({
  aircraft: z.enum(["fenix-a320", "inibuilds", "mock"]),
  power: z.boolean(),
  spd: z.number(), // knots, or Mach (e.g. 0.78) when spdIsMach
  spdIsMach: z.boolean(),
  spdDashed: z.boolean(),
  spdManaged: z.boolean(),
  hdg: z.number(),
  hdgDashed: z.boolean(),
  hdgManaged: z.boolean(),
  trkFpa: z.boolean(),
  alt: z.number(),
  altManaged: z.boolean(),
  /** Feet per altitude-knob click, when known (100 or 1000). */
  altStep: z.number().nullable(),
  vs: z.number(), // fpm (or FPA x 1000 in TRK/FPA mode)
  vsDashed: z.boolean(),
  lights: z.object({
    ap1: z.boolean(),
    ap2: z.boolean(),
    athr: z.boolean(),
    loc: z.boolean(),
    appr: z.boolean(),
    exped: z.boolean(),
  }),
  efis1: z.object({
    baroHpa: z.number(),
    baroInHg: z.number(),
    ndMode: z.number().int(),
  }),
});
export type FcuState = z.infer<typeof FcuStateSchema>;

export const ControlInfoSchema = z.object({
  /** May this client send commands? */
  allowed: z.boolean(),
  /** Why: this PC, a paired device, or not paired yet. */
  reason: z.enum(["localhost", "paired", "not-paired"]),
  deviceName: z.string().optional(),
  /** Reached through the relay and not paired yet: nothing but pairing is available until it is. */
  locked: z.boolean().optional(),
  /** How commands reach the aircraft and whether that has been seen to work. */
  path: z.enum(["mobiflight", "simconnect", "mock", "none"]),
  working: z.boolean().nullable(),
  detail: z.string().optional(),
});
export type ControlInfo = z.infer<typeof ControlInfoSchema>;

export const PairedDeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  pairedAt: z.number(),
  lastSeen: z.number().nullable(),
});
export type PairedDevice = z.infer<typeof PairedDeviceSchema>;
