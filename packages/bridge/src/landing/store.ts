import { LandingSchema, summarize, type Landing, type LandingSummary } from "@vbuddy/protocol";
import type { Logger } from "../log.js";

/** Newest landings kept in memory and served. Older ones stay in the file. */
export const MAX_LANDINGS = 500;

/** Where landings are kept between runs (the flight database). */
export interface LandingPersistence {
  save(l: Landing): void;
  /** Raw JSON of the newest `limit` landings, oldest first. */
  loadRecent(limit: number): string[];
}

/**
 * The landing logbook: the newest landings in memory, optionally backed by
 * persistent storage so they survive a bridge restart. A stored row that
 * doesn't parse is skipped, never fatal, and a failed save never stops the
 * live stream.
 */
export class LandingStore {
  private items: Landing[] = [];
  private byId = new Map<string, Landing>();
  private cbs: Array<(l: Landing) => void> = [];
  private writeFailed = false;

  /** @param persist storage, or null to keep landings in memory only. */
  constructor(
    private persist: LandingPersistence | null,
    private log: Logger,
  ) {}

  load() {
    if (!this.persist) return;
    let bad = 0;
    const loaded: Landing[] = [];
    try {
      for (const raw of this.persist.loadRecent(MAX_LANDINGS)) {
        try {
          const r = LandingSchema.safeParse(JSON.parse(raw));
          if (r.success) loaded.push(r.data);
          else bad++;
        } catch {
          bad++;
        }
      }
    } catch (e) {
      this.log.warn(`Couldn't read saved landings: ${(e as Error).message}`);
      return;
    }
    loaded.sort((a, b) => a.ts - b.ts);
    for (const l of loaded) this.insert(l);
    this.log.info(`Loaded ${this.items.length} saved landing(s)` + (bad ? ` (${bad} unreadable skipped)` : ""));
  }

  private insert(l: Landing) {
    if (this.byId.has(l.id)) return;
    this.items.push(l);
    this.byId.set(l.id, l);
    while (this.items.length > MAX_LANDINGS) this.byId.delete(this.items.shift()!.id);
  }

  onAdd(cb: (l: Landing) => void) {
    this.cbs.push(cb);
  }

  add(l: Landing) {
    if (this.byId.has(l.id)) return;
    this.insert(l);
    for (const cb of this.cbs) cb(l);
    if (this.persist) {
      try {
        this.persist.save(l);
      } catch (e) {
        if (!this.writeFailed) this.log.warn(`Couldn't save the landing: ${(e as Error).message}. It's still available until the bridge restarts.`);
        this.writeFailed = true;
      }
    }
  }

  /** Newest first, without traces. */
  list(limit = 100): LandingSummary[] {
    return this.items
      .slice(-limit)
      .reverse()
      .map((l) => summarize(l));
  }

  get(id: string): Landing | undefined {
    return this.byId.get(id);
  }

  get size() {
    return this.items.length;
  }
}
