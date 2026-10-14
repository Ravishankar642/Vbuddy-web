import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The pilot's accounts with other services. Kept on the PC running the bridge, never sent to the relay or to a phone. */
export interface Integrations {
  /** SimBrief user name or numeric pilot id. */
  simbrief: string;
  /** Hoppie ACARS logon code. */
  hoppie: string;
}

const EMPTY: Integrations = { simbrief: "", hoppie: "" };

/** A SimBrief user name is letters, digits and a few separators; a pilot id is digits. */
export function cleanSimbrief(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return "";
  return /^[A-Za-z0-9 ._-]{1,40}$/.test(s) ? s : null;
}

export function cleanHoppie(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s === "") return "";
  return /^[A-Za-z0-9]{6,40}$/.test(s) ? s : null;
}

export class IntegrationStore {
  private value: Integrations = { ...EMPTY };

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as Partial<Integrations>;
      this.value = { simbrief: cleanSimbrief(j.simbrief) ?? "", hoppie: cleanHoppie(j.hoppie) ?? "" };
    } catch {
      /* first run, or unreadable: start empty */
    }
  }

  get(): Integrations {
    return { ...this.value };
  }

  /** Only the fields present are changed. Returns an error message for a value that can't be right. */
  set(patch: { simbrief?: unknown; hoppie?: unknown }): string | null {
    const next = { ...this.value };
    if (patch.simbrief !== undefined) {
      const s = cleanSimbrief(patch.simbrief);
      if (s === null) return "The SimBrief name can only have letters, digits, spaces, dots, dashes and underscores.";
      next.simbrief = s;
    }
    if (patch.hoppie !== undefined) {
      const h = cleanHoppie(patch.hoppie);
      if (h === null) return "The Hoppie logon code is letters and digits only (6 or more).";
      next.hoppie = h;
    }
    this.value = next;
    this.save();
    return null;
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      writeFileSync(tmp, JSON.stringify(this.value), { mode: 0o600 });
      renameSync(tmp, this.file);
      try {
        chmodSync(this.file, 0o600);
      } catch {
        /* Windows */
      }
    } catch {
      /* kept for this run */
    }
  }
}
