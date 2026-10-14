import type { PauseSchedule } from "@vbuddy/protocol";

/** Level at cruise this long before a "before top of descent" pause may fire. */
const CRUISE_HOLD_MS = 120_000;
const CRUISE_MIN_ALT = 10_000;
const CRUISE_VS = 300;
/** With no descent estimate, a sustained descent this steep, for this long, counts as the descent having started. */
const DESCENT_VS = -500;
const DESCENT_HOLD_MS = 15_000;

export interface PauseDeps {
  now(): number;
  /** The live flight, or null when there is no sim. */
  flight(): { altMsl: number; vs: number; onGround: boolean } | null;
  /** Minutes to the top of descent, or null when not known. */
  todMin(): number | null;
  paused(): boolean;
  /** Pauses the simulator. */
  pause(): Promise<unknown> | unknown;
}

export interface PauseStatus {
  schedule: PauseSchedule;
  etaSec: number | null;
  waiting: string;
}

/**
 * One scheduled pause, held on the PC so it still happens when the phone has gone away.
 *   atTime     — fires when the clock reaches the time.
 *   beforeTod  — fires the chosen number of seconds before the top of descent, but only once the flight has been level
 *                above 10,000 ft for two minutes. When no estimate exists (no SimBrief plan), fires when a steady
 *                descent from that cruise begins.
 * It fires once, clears itself, and never touches a sim that is already paused.
 */
export class PauseScheduler {
  private sch: PauseSchedule | null = null;
  private cruiseSince: number | null = null;
  private descentSince: number | null = null;
  private cbs: Array<() => void> = [];
  private lastKey = "";

  constructor(private d: PauseDeps) {}

  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
  private emit() {
    const key = JSON.stringify(this.status());
    if (key === this.lastKey) return;
    this.lastKey = key;
    for (const cb of this.cbs) cb();
  }

  set(s: PauseSchedule): { ok: true } | { ok: false; error: string } {
    if (s.mode === "atTime" && s.atEpochMs <= this.d.now()) return { ok: false, error: "That time has already passed." };
    this.sch = s;
    this.cruiseSince = null;
    this.descentSince = null;
    this.emit();
    return { ok: true };
  }
  cancel() {
    this.sch = null;
    this.emit();
  }

  /** Call about twice a second. */
  tick() {
    const s = this.sch;
    if (!s) return;
    const now = this.d.now();
    const f = this.d.flight();
    if (s.mode === "atTime") {
      if (now >= s.atEpochMs) this.fire();
      else this.emit();
      return;
    }
    if (!f || f.onGround) {
      this.cruiseSince = null;
      this.descentSince = null;
      this.emit();
      return;
    }
    const level = f.altMsl >= CRUISE_MIN_ALT && Math.abs(f.vs) <= CRUISE_VS;
    if (level) this.cruiseSince ??= now;
    else this.cruiseSince = null;
    if (this.cruiseSince !== null && now - this.cruiseSince >= CRUISE_HOLD_MS) this.wasCruise = true;
    const tod = this.d.todMin();
    // The estimate is only believed once the cruise is established; the lead time then decides.
    if (this.wasCruise && tod !== null && tod * 60 <= s.leadSec) return this.fire();
    // With no estimate, a steady descent after a real cruise is the signal.
    if (this.wasCruise && f.vs <= DESCENT_VS) this.descentSince ??= now;
    else this.descentSince = null;
    if (this.wasCruise && tod === null && this.descentSince !== null && now - this.descentSince >= DESCENT_HOLD_MS) return this.fire();
    this.emit();
  }
  private wasCruise = false;

  private fire() {
    this.sch = null;
    this.wasCruise = false;
    this.cruiseSince = null;
    this.descentSince = null;
    if (!this.d.paused()) void Promise.resolve(this.d.pause()).catch(() => {});
    this.emit();
  }

  status(): PauseStatus | null {
    const s = this.sch;
    if (!s) return null;
    const now = this.d.now();
    if (s.mode === "atTime") return { schedule: s, etaSec: Math.max(0, Math.round((s.atEpochMs - now) / 1000)), waiting: "the set time" };
    const tod = this.d.todMin();
    if (tod !== null) return { schedule: s, etaSec: Math.max(0, Math.round(tod * 60 - s.leadSec)), waiting: "the top of descent" };
    return { schedule: s, etaSec: null, waiting: this.wasCruise ? "the start of the descent" : "the cruise (no top of descent estimate yet)" };
  }
}
