import { z } from "zod";

/** PMDG CDU screen size (PMDG_NG3_SDK.h / PMDG_777X_SDK.h: CDU_COLUMNS x CDU_ROWS). */
export const CDU_COLUMNS = 24;
export const CDU_ROWS = 14;

/** Cell colours as PMDG numbers them. */
export const CDU_COLORS = ["white", "cyan", "green", "magenta", "amber", "red"] as const;
/** Cell flag bits as PMDG defines them. */
export const CDU_FLAG_SMALL = 0x01;
export const CDU_FLAG_REVERSE = 0x02;
export const CDU_FLAG_UNUSED = 0x04;

/**
 * One PMDG CDU screen. Each row is CDU_COLUMNS characters (PMDG's arrows already turned into ← → ↑ ↓), with a matching
 * string of colour digits (0-5, CDU_COLORS) and flag digits (0-7, CDU_FLAG_* bits).
 */
export const CduScreenSchema = z.object({
  /** "737" (PMDG 737) or "777" (PMDG 777). */
  aircraft: z.enum(["737", "777"]),
  /** Which CDU: 0 left (captain), 1 right, 2 centre (777). */
  side: z.number().int().min(0).max(2),
  /** How many CDUs the aircraft has (2 on the 737, 3 on the 777). */
  sides: z.number().int().min(1).max(3),
  /** False until the aircraft has sent this screen (it only does when its CDU broadcast is on). */
  live: z.boolean(),
  powered: z.boolean(),
  rows: z.array(z.string().max(CDU_COLUMNS * 2)).max(CDU_ROWS),
  colors: z.array(z.string().max(CDU_COLUMNS)).max(CDU_ROWS),
  flags: z.array(z.string().max(CDU_COLUMNS)).max(CDU_ROWS),
  /** Annunciator lights above the keys. */
  annun: z.object({ exec: z.boolean(), msg: z.boolean(), fail: z.boolean(), ofst: z.boolean(), call: z.boolean(), dspy: z.boolean() }),
  /** The keys this aircraft's SDK has, by PMDG's names without the EVT_CDU_x_ prefix ("L1", "INIT_REF", "A", ...). */
  keys: z.array(z.string().max(20)).max(200),
  /** Why the screen isn't showing, in words (e.g. how to turn the broadcast on). */
  message: z.string().max(400).nullable(),
});
export type CduScreen = z.infer<typeof CduScreenSchema>;

/** A CDU key name as PMDG names it, without the EVT_CDU_x_ prefix. */
export const CduKeySchema = z.string().regex(/^[A-Z0-9_]{1,20}$/);
