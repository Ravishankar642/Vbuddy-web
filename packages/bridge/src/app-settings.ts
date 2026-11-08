import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The app's own settings (theme, map, sounds, checklist ticks…), kept on the PC so a newly paired phone gets them. */
export interface AppSettingsDoc {
  updatedAt: number;
  values: Record<string, string>;
}

const KEY = /^vbuddy\.[A-Za-z0-9._-]{1,60}$/;
const MAX_VALUE = 8_000;
const MAX_TOTAL = 48_000;

/** Only well-formed keys and string values, within size limits; anything else is dropped. */
export function cleanSettings(v: unknown): Record<string, string> | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  let total = 0;
  for (const [k, x] of Object.entries(v)) {
    if (!KEY.test(k) || typeof x !== "string" || x.length > MAX_VALUE) continue;
    total += k.length + x.length;
    if (total > MAX_TOTAL) return null;
    out[k] = x;
  }
  return out;
}

export class AppSettings {
  private doc: AppSettingsDoc = { updatedAt: 0, values: {} };
  constructor(private file: string | null) {
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as Partial<AppSettingsDoc>;
      const values = cleanSettings(j.values);
      if (values && typeof j.updatedAt === "number") this.doc = { updatedAt: j.updatedAt, values };
    } catch {
      /* none yet */
    }
  }
  get(): AppSettingsDoc {
    return this.doc;
  }
  /** Saves a newer set; an older one (another device that was offline) is ignored. Returns the stored document. */
  put(values: unknown, updatedAt: unknown): AppSettingsDoc | null {
    const v = cleanSettings(values);
    if (!v || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
    if (updatedAt <= this.doc.updatedAt) return this.doc;
    this.doc = { updatedAt: Math.min(updatedAt, Date.now() + 60_000), values: v };
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify(this.doc));
      } catch {
        /* kept in memory */
      }
    }
    return this.doc;
  }
}
