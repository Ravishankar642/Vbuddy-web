import { emptyValues, type FenixValues, type FenixVar } from "./fenix-vars.js";
import type { CockpitBackend, ControlPath } from "./backend.js";

const wrap360 = (n: number) => ((Math.round(n) % 360) + 360) % 360;

/**
 * A pretend Fenix FCU for the mock flight and tests: same counters and
 * behaviour as the real one (as far as the discovery run showed), applied
 * after a short delay like a real sim frame.
 */
export class MockCockpit implements CockpitBackend {
  readonly aircraft = "mock" as const;
  private v: FenixValues = emptyValues();
  private cbs: Array<() => void> = [];
  /** Tests: drop every write, as if no module were listening. */
  deaf = false;

  constructor(private delayMs = 30) {
    Object.assign(this.v, {
      B_FCU_POWER: 1,
      N_FCU_SPEED: 250,
      N_FCU_HEADING: 270,
      N_FCU_ALTITUDE: 5000,
      N_FCU_VS: 0,
      B_FCU_VERTICALSPEED_DASHED: 1,
      B_FCU_HEADING_DASHED: 0,
      N_FCU_EFIS1_BARO_HPA: 1013,
      N_FCU_EFIS1_BARO_INCH: 29.92,
      S_FCU_EFIS1_ND_MODE: 2,
      S_FCU_ALTITUDE_SCALE: 0,
      S_FCU_SPEED: 3,
      S_FCU_HEADING: 1,
      S_FCU_ALTITUDE: 3,
    } satisfies Partial<FenixValues>);
  }

  values() {
    return this.v;
  }
  onValues(cb: () => void) {
    this.cbs.push(cb);
  }
  path(): ControlPath {
    return "mock";
  }
  nextPath() {
    return false;
  }
  resetPath() {}
  paused() {
    return false;
  }

  private later(fn: () => void) {
    if (this.deaf) return;
    setTimeout(() => {
      fn();
      for (const cb of this.cbs) cb();
    }, this.delayMs);
  }

  set(name: FenixVar, value: number) {
    this.later(() => {
      this.v[name] = value;
    });
    return true;
  }

  add(name: FenixVar, delta: number) {
    this.later(() => {
      const v = this.v;
      v[name] += delta;
      const flip = (n: FenixVar) => (v[n] = v[n] ? 0 : 1);
      // A button acts on release, which is the second of its two increments.
      const released = name.startsWith("S_FCU_") && delta > 0 && v[name] % 2 === 0;
      switch (name) {
        case "E_FCU_SPEED":
          v.N_FCU_SPEED = v.B_FCU_SPEED_MACH ? Math.round((v.N_FCU_SPEED + delta * 0.01) * 100) / 100 : Math.min(399, Math.max(100, v.N_FCU_SPEED + delta));
          if (v.B_FCU_SPEED_DASHED) v.B_FCU_SPEED_DASHED = 0; // turning shows the preselected value
          break;
        case "E_FCU_HEADING":
          v.N_FCU_HEADING = wrap360(v.N_FCU_HEADING + delta);
          v.B_FCU_HEADING_DASHED = 0;
          break;
        case "E_FCU_ALTITUDE": {
          const step = v.S_FCU_ALTITUDE_SCALE ? 1000 : 100;
          v.N_FCU_ALTITUDE = Math.min(49000, Math.max(100, Math.round((v.N_FCU_ALTITUDE + delta * step) / step) * step));
          break;
        }
        case "E_FCU_VS":
          v.N_FCU_VS = Math.min(6000, Math.max(-6000, v.N_FCU_VS + delta * 100));
          v.B_FCU_VERTICALSPEED_DASHED = 0;
          break;
        case "E_FCU_EFIS1_BARO":
          v.N_FCU_EFIS1_BARO_HPA += delta;
          v.N_FCU_EFIS1_BARO_INCH = Math.round(v.N_FCU_EFIS1_BARO_HPA * 2.953) / 100;
          break;
        // push = -1, pull = +1
        case "S_FCU_SPEED":
          v.I_FCU_SPEED_MANAGED = delta < 0 ? 1 : 0;
          v.B_FCU_SPEED_DASHED = delta < 0 ? 1 : 0;
          break;
        case "S_FCU_HEADING":
          v.I_FCU_HEADING_MANAGED = delta < 0 ? 1 : 0;
          v.B_FCU_HEADING_DASHED = delta < 0 ? 1 : 0;
          break;
        case "S_FCU_ALTITUDE":
          v.I_FCU_ALTITUDE_MANAGED = delta < 0 ? 1 : 0;
          break;
        case "S_FCU_VERTICAL_SPEED":
          if (delta < 0) v.N_FCU_VS = 0; // push = level off
          v.B_FCU_VERTICALSPEED_DASHED = 0;
          break;
        default:
          if (!released) break;
          if (name === "S_FCU_AP1") flip("I_FCU_AP1");
          if (name === "S_FCU_AP2") flip("I_FCU_AP2");
          if (name === "S_FCU_ATHR") flip("I_FCU_ATHR");
          if (name === "S_FCU_LOC") flip("I_FCU_LOC");
          if (name === "S_FCU_APPR") flip("I_FCU_APPR");
          if (name === "S_FCU_EXPED") flip("I_FCU_EXPED");
          if (name === "S_FCU_HDGVS_TRKFPA") flip("B_FCU_TRKFPA");
          if (name === "S_FCU_SPD_MACH") {
            flip("B_FCU_SPEED_MACH");
            v.N_FCU_SPEED = v.B_FCU_SPEED_MACH ? 0.78 : 280;
          }
      }
    });
    return true;
  }
}
