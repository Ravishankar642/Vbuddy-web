import type { PanelCommand, PanelState } from "@vbuddy/protocol";
import { LIGHT_IDS } from "@vbuddy/protocol";
import type { Logger } from "../log.js";
import type { PauseScheduler } from "../sim/pause-scheduler.js";
import type { PanelBackend, PanelResult } from "./backend.js";

const EMPTY: PanelState = {
  aircraft: "",
  family: "other",
  lights: Object.fromEntries(LIGHT_IDS.map((l) => [l, false])) as PanelState["lights"],
  ap: null,
  note: null,
};

/** How far one detent turns each window. */
const STEP = { hdg: 1, alt: 100, vs: 100, crs: 1 } as const;
const OPTIMISTIC_MS = 1500;

/**
 * Knobs arrive as "turn by n detents". The simulator answers a moment later, so fast turning would add to a stale
 * value; this remembers the value just requested and builds on it for a short while.
 */
export class PanelService {
  private asked = new Map<string, { value: number; at: number }>();

  private pauser: PauseScheduler | null = null;

  constructor(
    private backend: PanelBackend | null,
    private log: Logger,
    private now: () => number = Date.now,
  ) {}

  /** The scheduled pause is kept here, next to the controls that use it. */
  attachPauseScheduler(p: PauseScheduler) {
    this.pauser = p;
  }

  state(): PanelState {
    const b = this.backend?.state() ?? EMPTY;
    const ps = this.pauser?.status() ?? null;
    return ps ? { ...b, pauseSchedule: ps } : b;
  }
  onChange(cb: () => void) {
    this.backend?.onChange(cb);
    this.pauser?.onChange(cb);
  }

  async run(cmd: PanelCommand): Promise<PanelResult> {
    const b = this.backend;
    if (!b) return { ok: false, error: "Not available on this bridge." };
    const st = b.state();
    if (!st || !st.aircraft) return { ok: false, error: "No aircraft loaded in the simulator." };
    switch (cmd.op) {
      case "sys":
        return b.sys(cmd.id, cmd.value);
      case "pauseAt": {
        if (!this.pauser) return { ok: false, error: "Scheduled pause isn't available on this bridge." };
        const r = this.pauser.set(cmd.schedule);
        return r.ok ? { ok: true } : r;
      }
      case "pauseCancel":
        this.pauser?.cancel();
        return { ok: true };
      case "light":
        return b.setLight(cmd.id, cmd.on);
      case "press":
        return b.press(cmd.ctl);
      case "fcu":
        return b.fcu ? b.fcu(cmd.ctl, cmd.action) : { ok: false, error: "Not available on this bridge." };
      case "set":
        this.asked.delete(cmd.ctl);
        return b.set(cmd.ctl, cmd.value);
      case "turn": {
        if (!st.ap) return { ok: false, error: "This aircraft isn't reporting its autopilot, so the knobs can't be turned from here." };
        const recent = this.asked.get(cmd.ctl);
        const live = this.current(st, cmd.ctl);
        const base = recent && this.now() - recent.at < OPTIMISTIC_MS ? recent.value : live;
        let next: number;
        if (cmd.ctl === "spd") {
          next = st.ap.machMode ? Math.round((base + cmd.steps * 0.01) * 100) / 100 : Math.round(base + cmd.steps);
          next = st.ap.machMode ? Math.min(0.99, Math.max(0.1, next)) : Math.min(999, Math.max(100, next));
        } else if (cmd.ctl === "hdg" || cmd.ctl === "crs") {
          next = (((Math.round(base) + cmd.steps * STEP[cmd.ctl]) % 360) + 360) % 360;
          if (next === 0) next = 360;
        } else if (cmd.ctl === "alt") {
          next = Math.min(50000, Math.max(0, Math.round((base + cmd.steps * STEP.alt) / 100) * 100));
        } else {
          next = Math.min(8000, Math.max(-8000, Math.round((base + cmd.steps * STEP.vs) / 100) * 100));
        }
        this.asked.set(cmd.ctl, { value: next, at: this.now() });
        const r = await b.set(cmd.ctl, next);
        if (!r.ok) this.asked.delete(cmd.ctl);
        return r;
      }
    }
  }

  private current(st: PanelState, ctl: "spd" | "hdg" | "alt" | "vs" | "crs"): number {
    const ap = st.ap!;
    return ctl === "spd" ? ap.spd : ctl === "hdg" ? ap.hdg : ctl === "alt" ? ap.alt : ctl === "vs" ? ap.vsFpm : ap.crs;
  }

  /** For tests and logs. */
  describe(): string {
    const s = this.state();
    return s.aircraft ? `${s.aircraft} (${s.family})` : "no aircraft";
  }
  logUse() {
    this.log.info(`Panel: ${this.describe()}`);
  }
}
