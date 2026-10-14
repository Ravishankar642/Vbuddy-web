import { LegCommandSchema, type LegCommand, type PlannedLeg } from "@vbuddy/protocol";
import type { FlightDb } from "./flight-db.js";

/** The pilot's planned flights: the list, and the commands that change it. */
export class LegBook {
  private cbs: Array<(legs: PlannedLeg[]) => void> = [];
  constructor(private db: FlightDb) {}

  list(): PlannedLeg[] {
    return this.db.plannedLegs();
  }
  onChange(cb: (legs: PlannedLeg[]) => void) {
    this.cbs.push(cb);
  }

  /** Validates and applies one command. The error text is for the person. */
  run(raw: unknown): { ok: true } | { ok: false; error: string } {
    const p = LegCommandSchema.safeParse(raw);
    if (!p.success) return { ok: false, error: p.error.issues[0]?.message ?? "That flight isn't valid." };
    const cmd: LegCommand = p.data;
    if ((cmd.op === "add" || cmd.op === "update") && cmd.dep === cmd.arr) return { ok: false, error: "Departure and arrival are the same airport." };
    try {
      if (!this.db.applyLeg(cmd)) return { ok: false, error: "That flight is already gone." };
    } catch (e) {
      return { ok: false, error: `Couldn't save: ${(e as Error).message}` };
    }
    const legs = this.list();
    for (const cb of this.cbs) cb(legs);
    return { ok: true };
  }
}
