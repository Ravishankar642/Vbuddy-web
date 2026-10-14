import { z } from "zod";

/** A flight the pilot plans to fly: shown in My flights until it is flown or deleted. */
export const PlannedLegSchema = z.object({
  id: z.number().int(),
  dep: z.string().regex(/^[A-Z0-9]{3,4}$/),
  arr: z.string().regex(/^[A-Z0-9]{3,4}$/),
  aircraft: z.string().max(60),
  /** When the pilot plans to fly it (ms since 1970), or null for "sometime". */
  plannedAt: z.number().nullable(),
  notes: z.string().max(500),
  createdAt: z.number(),
});
export type PlannedLeg = z.infer<typeof PlannedLegSchema>;

const LegFields = {
  dep: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,4}$/, "Departure must be an airport code, like EGLL"),
  arr: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{3,4}$/, "Arrival must be an airport code, like KJFK"),
  aircraft: z.string().trim().max(60),
  plannedAt: z.number().nullable(),
  notes: z.string().trim().max(500),
};

export const LegCommandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add"), ...LegFields }),
  z.object({ op: z.literal("update"), id: z.number().int(), ...LegFields }),
  z.object({ op: z.literal("delete"), id: z.number().int() }),
]);
export type LegCommand = z.infer<typeof LegCommandSchema>;
