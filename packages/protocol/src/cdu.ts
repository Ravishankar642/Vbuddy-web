import { z } from "zod";

/** CDU / MCDU screen size: 24 columns x 14 rows (PMDG's CDU_COLUMNS x CDU_ROWS; the Airbus MCDU is the same grid). */
export const CDU_COLUMNS = 24;
export const CDU_ROWS = 14;

/** Cell colours: 0-5 as PMDG numbers them, 6-7 added for the Airbus MCDU (yellow, and grey for "inop"). */
export const CDU_COLORS = ["white", "cyan", "green", "magenta", "amber", "red", "yellow", "grey"] as const;
/** Cell flag bits as PMDG defines them (small also marks the Airbus MCDU's small font). */
export const CDU_FLAG_SMALL = 0x01;
export const CDU_FLAG_REVERSE = 0x02;
export const CDU_FLAG_UNUSED = 0x04;

/**
 * One CDU / MCDU screen. Each row is CDU_COLUMNS characters (arrows already turned into ← → ↑ ↓), with a matching
 * string of colour digits (0-7, CDU_COLORS) and flag digits (0-7, CDU_FLAG_* bits).
 */
export const CduScreenSchema = z.object({
  /** Which aircraft: "737" / "777" (PMDG), "a32nx" (FlyByWire and aircraft built on it), "fenix" (Fenix A320 family), "mock". */
  aircraft: z.string().max(24),
  /** The key layout to draw: a Boeing CDU or an Airbus MCDU. Absent = Boeing (older bridges). */
  layout: z.enum(["boeing", "airbus"]).optional(),
  /** What to call it on screen ("PMDG 737", "Fenix A320", "FlyByWire A32NX"). */
  name: z.string().max(40).optional(),
  /** Which CDU: 0 left (captain), 1 right, 2 centre (777). */
  side: z.number().int().min(0).max(2),
  /** How many CDUs the aircraft has (2 on the 737 and the Airbus family, 3 on the 777). */
  sides: z.number().int().min(1).max(3),
  /** False until the aircraft has sent this screen. */
  live: z.boolean(),
  powered: z.boolean(),
  rows: z.array(z.string().max(CDU_COLUMNS * 2)).max(CDU_ROWS),
  colors: z.array(z.string().max(CDU_COLUMNS)).max(CDU_ROWS),
  flags: z.array(z.string().max(CDU_COLUMNS)).max(CDU_ROWS),
  /** Annunciator lights above the keys (Boeing). */
  annun: z.object({ exec: z.boolean(), msg: z.boolean(), fail: z.boolean(), ofst: z.boolean(), call: z.boolean(), dspy: z.boolean() }),
  /**
   * The keys this CDU has. Boeing: PMDG's names without the EVT_CDU_x_ prefix ("L1", "INIT_REF", "A", ...). Airbus:
   * AIRBUS_MCDU_KEYS. Both use DOT, PLUS_MINUS, SLASH, SPACE and CLR for the editing keys.
   */
  keys: z.array(z.string().max(20)).max(200),
  /** Why the screen isn't showing, in words (e.g. how to turn the data on). */
  message: z.string().max(400).nullable(),
});
export type CduScreen = z.infer<typeof CduScreenSchema>;

/** A CDU key name (see CduScreen.keys). */
export const CduKeySchema = z.string().regex(/^[A-Z0-9_]{1,20}$/);

/** VBuddy's names for the Airbus MCDU keys, the same whichever aircraft is behind them. */
export const AIRBUS_MCDU_KEYS = [
  ...["L", "R"].flatMap((s) => [1, 2, 3, 4, 5, 6].map((n) => `${s}${n}`)),
  "DIR", "PROG", "PERF", "INIT", "DATA", "FPLN", "RAD_NAV", "FUEL_PRED", "SEC_FPLN", "ATC_COM", "MENU", "AIRPORT",
  "PREV_PAGE", "UP", "NEXT_PAGE", "DOWN",
  ..."1234567890".split(""), "DOT", "PLUS_MINUS",
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""), "SLASH", "SPACE", "OVFY", "CLR",
] as const;

/** An empty grid row set, for building screens. */
export function blankCdu(): { rows: string[]; colors: string[]; flags: string[] } {
  return {
    rows: Array.from({ length: CDU_ROWS }, () => " ".repeat(CDU_COLUMNS)),
    colors: Array.from({ length: CDU_ROWS }, () => "0".repeat(CDU_COLUMNS)),
    flags: Array.from({ length: CDU_ROWS }, () => "0".repeat(CDU_COLUMNS)),
  };
}
