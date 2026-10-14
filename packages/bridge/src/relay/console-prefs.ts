import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Choices made in the VBuddy window (as opposed to config.env, which the user edits by hand). */
export interface ConsolePrefs {
  relay?: boolean;
}

export function readPrefs(file: string | null): ConsolePrefs {
  if (!file) return {};
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as ConsolePrefs;
    return typeof j.relay === "boolean" ? { relay: j.relay } : {};
  } catch {
    return {};
  }
}

export function writePrefs(file: string | null, prefs: ConsolePrefs): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(prefs));
    renameSync(tmp, file);
  } catch {
    /* the choice still holds for this run */
  }
}
