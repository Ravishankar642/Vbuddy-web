import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A link a friend can open to follow your flight, view only: the map, your flight card, progress and landings, never
 * chat, controls or settings. One link at a time, valid 24 hours; making a new one or switching it off ends the old one.
 */
export interface WatchState {
  token: string;
  expiresAt: number;
}

const TTL_MS = 24 * 3_600_000;

export class WatchLinks {
  private st: WatchState | null = null;
  constructor(private file: string | null) {
    if (!file) return;
    try {
      const j = JSON.parse(readFileSync(file, "utf8")) as Partial<WatchState>;
      if (typeof j.token === "string" && typeof j.expiresAt === "number" && j.expiresAt > Date.now()) this.st = { token: j.token, expiresAt: j.expiresAt };
    } catch {
      /* none */
    }
  }
  current(now = Date.now()): WatchState | null {
    return this.st && this.st.expiresAt > now ? this.st : null;
  }
  create(now = Date.now()): WatchState {
    this.st = { token: randomBytes(12).toString("base64url"), expiresAt: now + TTL_MS };
    this.save();
    return this.st;
  }
  revoke() {
    this.st = null;
    this.save();
  }
  verify(token: string | undefined, now = Date.now()): boolean {
    const c = this.current(now);
    if (!c || !token || token.length !== c.token.length) return false;
    return timingSafeEqual(Buffer.from(token), Buffer.from(c.token));
  }
  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.st ?? {}));
    } catch {
      /* memory only */
    }
  }
}
