import { z } from "zod";

/** Which cockpit layout suits the loaded aircraft. */
export const FamilySchema = z.enum(["airbus", "boeing", "other"]);
export type Family = z.infer<typeof FamilySchema>;

export const LIGHT_IDS = ["nav", "beacon", "strobe", "landing", "taxi", "wing", "logo", "recognition", "cabin", "panel"] as const;
export const LightIdSchema = z.enum(LIGHT_IDS);
export type LightId = z.infer<typeof LightIdSchema>;

/** Boeing MCP / generic autopilot buttons. Each presses like the real button (toggles). */
export const ApButtonSchema = z.enum(["cmd", "fd", "athr", "speed", "lvlChg", "hdgSel", "lnav", "app", "altHld", "vs"]);
export type ApButton = z.infer<typeof ApButtonSchema>;

export const ApKnobSchema = z.enum(["spd", "hdg", "alt", "vs", "crs"]);
export type ApKnob = z.infer<typeof ApKnobSchema>;

/**
 * Aircraft systems and simulator controls that work the same on any aircraft that follows the simulator's standard
 * events. Each one is checked against the value the simulator reports afterwards.
 */
export const SYS_IDS = [
  "flapsUp", // one detent up
  "flapsDown", // one detent down
  "spoilersArm", // value 1 = arm, 0 = disarm
  "gear", // value 1 = down, 0 = up
  "parkingBrake", // value 1 = set, 0 = release
  "engines", // value 1 = start all, 0 = shut down all
  "engine", // value n = start engine n (1-4), -n = shut it down (fuel valve + starter, as Cobalt)
  "apu", // value 1 = start, 0 = off
  "pitotHeat", // value 1 = on, 0 = off
  "seatbelts", // value 1 = on, 0 = off
  "baroStd", // set the altimeter to 1013 / 29.92
  "baroSet", // value = hPa, or inHg when below 40
  "pause", // value 1 = pause, 0 = resume
  "simRate", // value = 0.25 to 16
  "camera", // value 0 = cockpit, 1 = outside, 2 = drone
  "flapsSet", // value = flap position 0 (up) to the number of positions
  "doorToggle", // value = door 1 to 4
  "slew", // value 1 = slew mode on, 0 = off
  "wingLeveler", // value 1 = on, 0 = off
  "panLeft", // camera moves; value = how many steps (default 1)
  "panRight",
  "panUp",
  "panDown",
  "zoomIn",
  "zoomOut",
  "viewReset",
] as const;
export const SysIdSchema = z.enum(SYS_IDS);
export type SysId = z.infer<typeof SysIdSchema>;

export const PauseScheduleSchema = z.discriminatedUnion("mode", [
  /** Pause at a wall-clock time. */
  z.object({ mode: z.literal("atTime"), atEpochMs: z.number().int().positive() }),
  /** Pause this many seconds before the top of descent. */
  z.object({ mode: z.literal("beforeTod"), leadSec: z.number().int().min(0).max(3600) }),
]);
export type PauseSchedule = z.infer<typeof PauseScheduleSchema>;

export const PanelCommandSchema = z.discriminatedUnion("op", [
  /** Aircraft systems and simulator controls. */
  z.object({ op: z.literal("sys"), id: SysIdSchema, value: z.number().min(-10000).max(100000).optional() }),
  /** Pause the simulator later, while the phone may be away. */
  z.object({ op: z.literal("pauseAt"), schedule: PauseScheduleSchema }),
  z.object({ op: z.literal("pauseCancel") }),
  /** Switch an exterior/interior light on or off. */
  z.object({ op: z.literal("light"), id: LightIdSchema, on: z.boolean() }),
  /** Press an autopilot button. */
  z.object({ op: z.literal("press"), ctl: ApButtonSchema }),
  /** Turn a knob by detents (+ = clockwise): 1 kt/Mach 0.01, 1 deg, 100 ft, 100 fpm. */
  z.object({ op: z.literal("turn"), ctl: ApKnobSchema, steps: z.number().int().min(-60).max(60).refine((n) => n !== 0) }),
  /** Airbus FCU knob: push (managed) or pull (selected). */
  z.object({ op: z.literal("fcu"), ctl: z.enum(["spd", "hdg", "alt", "vs"]), action: z.enum(["push", "pull"]) }),
  /** Dial a window to an exact value. */
  z.object({ op: z.literal("set"), ctl: ApKnobSchema, value: z.number().min(-10000).max(60000) }),
]);
export type PanelCommand = z.infer<typeof PanelCommandSchema>;

export const PanelStateSchema = z.object({
  /** Aircraft title as the simulator reports it ("" until known). */
  aircraft: z.string(),
  family: FamilySchema,
  /** Lights as the simulator reports them (true = on). */
  lights: z.record(LightIdSchema, z.boolean()),
  /** Autopilot as the simulator reports it, or null when it isn't reporting. */
  ap: z
    .object({
      master: z.boolean(),
      fd: z.boolean(),
      athr: z.boolean(),
      speed: z.boolean(),
      lvlChg: z.boolean(),
      hdgSel: z.boolean(),
      lnav: z.boolean(),
      app: z.boolean(),
      altHld: z.boolean(),
      vs: z.boolean(),
      /** Selected values. spd is knots, or Mach when machMode. */
      spd: z.number(),
      machMode: z.boolean(),
      hdg: z.number(),
      alt: z.number(),
      vsFpm: z.number(),
      crs: z.number(),
      /** False when the aircraft's autopilot panel has no course knob (the 777's MCP, every Airbus FCU). */
      hasCrs: z.boolean().optional(),
      /** Airbus FCU managed dots (true = managed), when the aircraft reports them. */
      managed: z.object({ spd: z.boolean(), hdg: z.boolean(), alt: z.boolean() }).optional(),
    })
    .nullable(),
  /** Short note for the pilot, e.g. "this aircraft ignored the last command". */
  note: z.string().nullable(),
  /**
   * The aircraft's CDUs / MCDUs that VBuddy can show (PMDG 737: 2, PMDG 777: 3, the Airbus family: 2); absent when it
   * has none VBuddy can reach. kind "mcdu" = an Airbus MCDU.
   */
  cdu: z.object({ sides: z.number().int().min(1).max(3), kind: z.enum(["cdu", "mcdu"]).optional(), name: z.string().max(40).optional() }).nullable().optional(),
  /** Set when the aircraft keeps its cockpit private, so outside commands can't operate it: says why. */
  readOnly: z.string().nullable().optional(),
  /** Aircraft systems and simulator state as the simulator reports it. Absent on older bridges. */
  sys: z
    .object({
      flapsIndex: z.number(),
      flapsCount: z.number(),
      spoilersArmed: z.boolean(),
      gearDown: z.boolean(),
      parkingBrake: z.boolean(),
      enginesRunning: z.number(),
      engineCount: z.number(),
      /** Which engines are running, engine 1 first. */
      engines: z.array(z.boolean()).optional(),
      apuOn: z.boolean(),
      pitotHeat: z.boolean(),
      seatbelts: z.boolean(),
      baroHpa: z.number(),
      paused: z.boolean(),
      simRate: z.number(),
      camera: z.number(),
      /** Slew mode and the wing leveler, and how far each of the first four doors is open (0 to 100). Absent on older bridges. */
      slew: z.boolean().optional(),
      wingLeveler: z.boolean().optional(),
      doors: z.array(z.number()).optional(),
    })
    .nullable()
    .optional(),
  /** A scheduled pause that has not happened yet. */
  pauseSchedule: z
    .object({
      schedule: PauseScheduleSchema,
      /** Seconds until it fires, when that can be worked out. */
      etaSec: z.number().nullable(),
      /** What it is waiting for, in words. */
      waiting: z.string(),
    })
    .nullable()
    .optional(),
});
export type PanelState = z.infer<typeof PanelStateSchema>;

/** Which family an aircraft title belongs to. Add-on titles are matched by name, so unknown ones fall to "other". */
export function familyOf(title: string, model = ""): Family {
  const t = `${title} ${model}`.toLowerCase();
  if (/fenix|fnx|fslabs|\ba3[1-9]\d|airbus|a32nx|a3[0-9]{2}\b|inibuilds.*a3/.test(t)) return "airbus";
  if (/pmdg|ifly|\b7[0-9]7\b|\b73[0-9]\b|\b74[0-9]\b|\b75[0-9]\b|\b76[0-9]\b|\b77[0-9]\b|\b78[0-9]\b|boeing|b7[0-9]{2}|b73[0-9]/.test(t)) return "boeing";
  return "other";
}
