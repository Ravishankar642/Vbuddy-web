import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Telemetry } from "@vbuddy/protocol";
import type { Logger } from "./log.js";

/**
 * How hard the bridge works, decided in one place:
 * - lite: the pilot's choice (the app or the VBuddy window). The least work on the PC that still does everything:
 *   fewer samples from the sim, a 2 Hz stream to the app, lighter engine and systems reads, the speech engine on 2 cores.
 * - background: nobody is looking (no app on screen, the VBuddy window closed or minimised to the tray). Only what
 *   records the flight and sends notifications keeps running; screens-only reads (systems, gauges) pause.
 * - landing: in the landing window (low and descending, or rolling fast on the runway). Nothing heavy runs then:
 *   transcription waits, and the systems reads pause, so the sim isn't asked for anything it doesn't need.
 */
export interface PerfState {
  lite: boolean;
  background: boolean;
  landing: boolean;
}

/** Sim frames skipped between samples, by situation. At 60 fps: 0 skipped = 60 a second, 1 = 30, 3 = 15, 7 = 7.5. */
export function frameSkip(p: PerfState): number {
  if (p.landing) return p.lite ? 2 : 1;
  return p.lite || p.background ? 7 : 3;
}

/**
 * The landing window: airborne below 1,000 ft above the ground, or on the runway above 40 kt. Left above 1,500 ft or
 * below 30 kt, so it doesn't flip back and forth.
 */
export function inLandingWindow(t: Pick<Telemetry, "onGround" | "altAgl" | "gs">, now: boolean): boolean {
  if (t.onGround) return now ? t.gs > 30 : t.gs > 40;
  return now ? t.altAgl < 1500 : t.altAgl < 1000;
}

export class PerfService {
  private st: PerfState = { lite: false, background: false, landing: false };
  private cbs: Array<(s: PerfState, was: PerfState) => void> = [];
  private consoleSeenAt = 0;
  private consoleVisible = false;
  private appScreens = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private file: string | null,
    private log: Logger,
  ) {
    this.st.lite = this.load();
    // The VBuddy window checks in every 2 s; quiet for 8 s means it's closed.
    this.timer = setInterval(() => this.recompute(), 4000);
    this.timer.unref?.();
  }

  private load(): boolean {
    if (!this.file) return false;
    try {
      return (JSON.parse(readFileSync(this.file, "utf8")) as { lite?: unknown }).lite === true;
    } catch {
      return false;
    }
  }

  state(): PerfState {
    return { ...this.st };
  }
  onChange(cb: (s: PerfState, was: PerfState) => void) {
    this.cbs.push(cb);
  }

  private set(patch: Partial<PerfState>) {
    const next = { ...this.st, ...patch };
    if (next.lite === this.st.lite && next.background === this.st.background && next.landing === this.st.landing) return;
    const was = this.st;
    this.st = next;
    if (next.lite !== was.lite) this.log.info(`Lite mode ${next.lite ? "on" : "off"}`);
    if (next.background !== was.background) this.log.info(next.background ? "Nobody is looking: only the essentials run" : "Someone is looking again: everything runs");
    for (const cb of this.cbs) cb(next, was);
  }

  setLite(on: boolean) {
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(this.file, JSON.stringify({ lite: on }));
      } catch (e) {
        this.log.warn(`Couldn't save the lite mode setting: ${(e as Error).message}`);
      }
    }
    this.set({ lite: on });
  }

  /** From the samples: in the landing window or not. */
  sample(t: Telemetry) {
    const now = inLandingWindow(t, this.st.landing);
    if (now !== this.st.landing) this.set({ landing: now });
  }
  /** The sim went away. */
  simLost() {
    if (this.st.landing) this.set({ landing: false });
  }

  /** The VBuddy window checked in; `visible` is false when it is minimised. */
  consoleSeen(visible: boolean) {
    this.consoleSeenAt = Date.now();
    const changed = visible !== this.consoleVisible;
    this.consoleVisible = visible;
    if (changed) this.recompute();
  }
  /** How many app screens (phones, tablets, the window's own map) are open and on screen. */
  setAppScreens(n: number) {
    this.appScreens = n;
    this.recompute();
  }

  private recompute() {
    const consoleOpen = this.consoleVisible && Date.now() - this.consoleSeenAt < 8000;
    this.set({ background: !consoleOpen && this.appScreens === 0 });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
