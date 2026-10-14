import { LandingSchema } from "@vbuddy/protocol";
import { readFile, rename } from "node:fs/promises";
import type { Logger } from "../log.js";
import type { FlightDb } from "./flight-db.js";

/**
 * Part 1-2 kept landings in landings.jsonl. Moves them into the database once,
 * then renames the file to landings.jsonl.imported (never deleted). Unreadable
 * lines are skipped. Safe to run again: landings are keyed by id.
 */
export async function importLandingsJsonl(file: string, db: FlightDb, log: Logger): Promise<number> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") log.warn(`Couldn't read the old landing log ${file}: ${(e as Error).message}`);
    return 0;
  }
  let added = 0;
  let bad = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = LandingSchema.safeParse(JSON.parse(line));
      if (!r.success) bad++;
      else if (db.insertLanding(r.data, null)) added++;
    } catch {
      bad++;
    }
  }
  try {
    await rename(file, `${file}.imported`);
  } catch (e) {
    log.warn(`Imported the old landing log but couldn't rename it: ${(e as Error).message}`);
  }
  log.info(`Moved ${added} landing(s) from the old landing log into the flight database` + (bad ? ` (${bad} unreadable line(s) skipped)` : ""));
  return added;
}
