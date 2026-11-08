import { checkGate, GATE_HEIGHTS, type ApproachGate, type Telemetry } from "@vbuddy/protocol";

const IAS_WINDOW_MS = 10_000;
/** Above this (climbing away, a go-around) the gates are armed again for the next approach. */
const REARM_FT = 1500;
/** Gates older than this aren't attached to a landing. */
const KEEP_MS = 5 * 60_000;

/**
 * Checks the stabilised-approach gates as the aircraft descends through 1,000 and 500 ft above the ground, and keeps
 * them for the landing report. Light: a few comparisons per sample.
 */
export class ApproachMonitor {
  private prevAgl: number | null = null;
  private passed = new Set<number>();
  private gates: ApproachGate[] = [];
  private ias: Array<{ at: number; kt: number }> = [];
  private cbs: Array<(g: ApproachGate) => void> = [];

  onGate(cb: (g: ApproachGate) => void) {
    this.cbs.push(cb);
  }

  update(t: Telemetry, at: number) {
    if (t.onGround) {
      this.prevAgl = null;
      this.ias = [];
      return;
    }
    this.ias.push({ at, kt: t.ias });
    while (this.ias.length && at - this.ias[0]!.at > IAS_WINDOW_MS) this.ias.shift();
    if (t.altAgl > REARM_FT) {
      this.passed.clear();
    } else if (this.prevAgl !== null && t.vs < 0) {
      for (const h of GATE_HEIGHTS) {
        if (!this.passed.has(h) && this.prevAgl > h && t.altAgl <= h) {
          this.passed.add(h);
          const g = checkGate(h, at, { gearDown: t.gearDown, flapsIndex: t.flapsIndex, vs: t.vs, gs: t.gs, bank: t.bank, iasRecent: this.ias.map((s) => s.kt) });
          this.gates = [...this.gates.filter((x) => at - x.at < KEEP_MS && x.heightFt !== h), g];
          for (const cb of this.cbs) cb(g);
        }
      }
    }
    this.prevAgl = t.altAgl;
  }

  /** The gates of the approach that just ended in a landing (and forgets them). */
  take(now: number): ApproachGate[] {
    const g = this.gates.filter((x) => now - x.at < KEEP_MS).sort((a, b) => b.heightFt - a.heightFt);
    this.gates = [];
    return g;
  }
}
