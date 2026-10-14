import type { CockpitCommand, ControlInfo, FcuState } from "@vbuddy/protocol";
import type { Logger } from "../log.js";
import type { CockpitBackend } from "./backend.js";
import { BUTTON_VAR, KNOB_VAR, PUSHPULL_VAR, toFcuState, type FenixVar } from "./fenix-vars.js";

export interface DriverOptions {
  /** Pause between clicks; the Fenix needs a frame or two to take each one. */
  clickMs?: number;
  /** How long to wait for a write to show up before calling it lost. */
  verifyMs?: number;
  /** Lost writes in a row before trying the next way of sending. */
  failLimit?: number;
}

export type CmdOutcome = { ok: true } | { ok: false; error: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_QUEUE = 20;
const MAX_TARGET_CLICKS = 400;
/** Default display change per click, used until one click has been measured. */
const DEFAULT_STEP = { spd: 1, hdg: 1, alt: 100, vs: 100 } as const;

/**
 * Runs cockpit commands one at a time: paces clicks, checks every command
 * actually changed the aircraft's counter, and moves to another way of
 * sending when commands aren't arriving.
 */
export class CockpitDriver {
  private queue: Array<{ cmd: CockpitCommand; done: (o: CmdOutcome) => void }> = [];
  private busy = false;
  private failures = 0;
  private working: boolean | null = null;
  private detail: string | undefined;
  /** Display change per click, learned per knob (alt per scale setting). */
  private steps = new Map<string, number>();
  private changeCbs: Array<() => void> = [];
  private clickMs: number;
  private verifyMs: number;
  private failLimit: number;

  constructor(
    private backend: CockpitBackend,
    private log: Logger,
    opts: DriverOptions = {},
  ) {
    this.clickMs = opts.clickMs ?? 60;
    this.verifyMs = opts.verifyMs ?? 900;
    this.failLimit = opts.failLimit ?? 2;
  }

  onChange(cb: () => void) {
    this.changeCbs.push(cb);
  }
  private changed() {
    for (const cb of this.changeCbs) cb();
  }

  state(): FcuState | null {
    const v = this.backend.values();
    if (!v) return null;
    const scale = v.S_FCU_ALTITUDE_SCALE;
    return toFcuState(v, this.steps.get(`alt:${scale}`) ?? null, this.backend.aircraft);
  }

  link(): Pick<ControlInfo, "path" | "working" | "detail"> {
    return { path: this.backend.path(), working: this.working, ...(this.detail ? { detail: this.detail } : {}) };
  }

  /** Start over with the first way of sending (the pilot pressed Retry, or a new aircraft loaded). */
  reset() {
    this.backend.resetPath();
    this.failures = 0;
    this.working = null;
    this.detail = undefined;
    this.steps.clear();
    this.changed();
  }

  run(cmd: CockpitCommand): Promise<CmdOutcome> {
    if (!this.backend.values()) return Promise.resolve({ ok: false, error: "No Fenix A320 is loaded." });
    if (this.queue.length >= MAX_QUEUE) return Promise.resolve({ ok: false, error: "Too many commands at once. Wait a moment." });
    return new Promise((done) => {
      this.queue.push({ cmd, done });
      void this.pump();
    });
  }

  private async pump() {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length) {
        const { cmd, done } = this.queue.shift()!;
        let out: CmdOutcome;
        try {
          out = await this.exec(cmd);
        } catch (e) {
          out = { ok: false, error: (e as Error).message };
        }
        done(out);
      }
    } finally {
      this.busy = false;
    }
  }

  private val(n: FenixVar) {
    return this.backend.values()?.[n] ?? NaN;
  }

  /** Waits until `test` passes or the time runs out. */
  private async waitFor(test: () => boolean, ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (test()) return true;
      await sleep(20);
    }
    return test();
  }

  /**
   * Bookkeeping after a write that should have moved `name` from `before` by `want`.
   * Returns an outcome; switches the way of sending after repeated silence.
   */
  private async verify(name: FenixVar, before: number, want: number): Promise<CmdOutcome> {
    // Wait for all of it; anything arriving at all proves the path works.
    await this.waitFor(() => this.val(name) - before === want, this.verifyMs);
    const arrived = this.val(name) !== before;
    if (arrived) {
      const got = this.val(name) - before;
      if (this.working !== true) this.log.info(`Cockpit commands are reaching the aircraft (${this.backend.path()}).`);
      this.failures = 0;
      this.working = true;
      this.detail = undefined;
      this.changed();
      return Math.sign(got) === Math.sign(want) ? { ok: true } : { ok: false, error: "The aircraft moved the other way." };
    }
    if (this.backend.paused()) return { ok: false, error: "The simulator is paused." };
    this.failures++;
    if (this.failures >= this.failLimit) {
      this.failures = 0;
      const from = this.backend.path();
      if (this.backend.nextPath()) {
        this.log.warn(`Commands sent via ${from} aren't reaching the aircraft. Trying ${this.backend.path()}.`);
        this.working = null;
        this.detail = `Trying ${this.backend.path()} because ${from} didn't respond.`;
      } else {
        this.working = false;
        this.detail = "Commands aren't reaching the Fenix. Check that the MobiFlight WASM module is installed in the Community folder, then press Retry.";
        this.log.warn(this.detail);
      }
      this.changed();
    }
    return { ok: false, error: "The aircraft didn't respond." };
  }

  /** Sends n clicks (signed) to a counter, paced, then checks they arrived. */
  private async clicks(name: FenixVar, n: number): Promise<CmdOutcome> {
    const before = this.val(name);
    const dir = Math.sign(n);
    for (let i = 0; i < Math.abs(n); i++) {
      if (!this.backend.add(name, dir)) return { ok: false, error: "The simulator isn't connected." };
      if (i < Math.abs(n) - 1) await sleep(this.clickMs);
    }
    return this.verify(name, before, n);
  }

  private async exec(cmd: CockpitCommand): Promise<CmdOutcome> {
    switch (cmd.op) {
      case "turn":
        return this.clicks(KNOB_VAR[cmd.ctl], cmd.clicks);
      case "push":
      case "pull":
        return this.clicks(PUSHPULL_VAR[cmd.ctl], cmd.op === "push" ? -1 : 1);
      case "press": {
        // Press and release: the Fenix counts both.
        const name = BUTTON_VAR[cmd.ctl];
        const before = this.val(name);
        if (!this.backend.add(name, 1)) return { ok: false, error: "The simulator isn't connected." };
        await sleep(Math.max(80, this.clickMs));
        this.backend.add(name, 1);
        return this.verify(name, before, 2);
      }
      case "ndMode": {
        const name: FenixVar = "S_FCU_EFIS1_ND_MODE";
        const before = this.val(name);
        if (before === cmd.value) return { ok: true };
        if (!this.backend.set(name, cmd.value)) return { ok: false, error: "The simulator isn't connected." };
        return this.verify(name, before, cmd.value - before);
      }
      case "target":
        return this.target(cmd.ctl, cmd.value);
    }
  }

  private display(ctl: "spd" | "hdg" | "alt" | "vs"): FenixVar {
    return ctl === "spd" ? "N_FCU_SPEED" : ctl === "hdg" ? "N_FCU_HEADING" : ctl === "alt" ? "N_FCU_ALTITUDE" : "N_FCU_VS";
  }

  /** Waits for the window to stop changing (the Fenix may animate), up to ms. */
  private async settle(name: FenixVar, ms = 1500) {
    const end = Date.now() + ms;
    let last = this.val(name);
    let since = Date.now();
    while (Date.now() < end) {
      await sleep(30);
      const v = this.val(name);
      if (v !== last) {
        last = v;
        since = Date.now();
      } else if (Date.now() - since >= 250) break;
    }
    return last;
  }

  /**
   * Dials a window to an exact value: measure one click, send the rest, read it
   * back and correct. A value is only reported as set once the FCU shows it.
   */
  private async target(ctl: "spd" | "hdg" | "alt" | "vs", raw: number): Promise<CmdOutcome> {
    const disp = this.display(ctl);
    const knob = KNOB_VAR[ctl];
    const isMach = ctl === "spd" && (this.state()?.spdIsMach ?? false);
    if (ctl === "spd" && isMach !== raw < 10) return { ok: false, error: isMach ? "The FCU is showing Mach. Enter a Mach number like 0.78, or switch to IAS." : "Enter a speed in knots." };
    const target = ctl === "hdg" ? ((Math.round(raw) % 360) + 360) % 360 : raw;
    const tolOf = (step: number) => step / 2;
    const diffNow = () => {
      let d = target - this.val(disp);
      if (ctl === "hdg") d = ((d % 360) + 540) % 360 - 180;
      return d;
    };

    const originalScale = this.val("S_FCU_ALTITUDE_SCALE");
    let scaleChanged = false;
    const key = () => (ctl === "alt" ? `alt:${this.val("S_FCU_ALTITUDE_SCALE")}` : isMach ? "spd:mach" : ctl);

    try {
      for (let round = 0; round < 6; round++) {
        let step = this.steps.get(key());
        const d = diffNow();
        if (Math.abs(d) < tolOf(step ?? (isMach ? 0.01 : DEFAULT_STEP[ctl]))) return { ok: true };

        if (step === undefined) {
          // Measure one click.
          const before = this.val(disp);
          const r = await this.clicks(knob, Math.sign(d));
          if (!r.ok) return r;
          const after = await this.settle(disp);
          let moved = Math.abs(after - before);
          if (ctl === "hdg" && moved > 180) moved = 360 - moved;
          if (moved === 0) return { ok: false, error: "The knob turned but the window didn't change (it may be at its limit)." };
          step = isMach ? Math.round(moved * 100) / 100 : moved;
          this.steps.set(key(), step);
          this.changed();
          continue;
        }

        let n = Math.round(d / step + (isMach ? Math.sign(d) * 1e-9 : 0));
        // Big altitude change on the 100 ft setting: use the 1000 ft setting instead, and put it back afterwards.
        if (ctl === "alt" && step < 1000 && Math.abs(n) > 30 && !scaleChanged) {
          const name: FenixVar = "S_FCU_ALTITUDE_SCALE";
          const before = this.val(name);
          this.backend.set(name, before ? 0 : 1);
          if (await this.waitFor(() => this.val(name) !== before, this.verifyMs)) {
            scaleChanged = true;
            continue; // the next round measures the new step
          }
        }
        if (n === 0) n = Math.sign(d);
        n = Math.max(-MAX_TARGET_CLICKS, Math.min(MAX_TARGET_CLICKS, n));
        // Sent in chunks so the queue stays responsive and each chunk is checked.
        while (n !== 0) {
          const chunk = Math.max(-50, Math.min(50, n));
          const r = await this.clicks(knob, chunk);
          if (!r.ok) return r;
          n -= chunk;
        }
        await this.settle(disp);
      }
      const now = this.val(disp);
      return Math.abs(diffNow()) < tolOf(this.steps.get(key()) ?? 1) ? { ok: true } : { ok: false, error: `Stopped at ${now}; couldn't reach ${raw}.` };
    } finally {
      if (scaleChanged) {
        this.backend.set("S_FCU_ALTITUDE_SCALE", originalScale);
        await this.waitFor(() => this.val("S_FCU_ALTITUDE_SCALE") === originalScale, this.verifyMs);
      }
    }
  }
}
