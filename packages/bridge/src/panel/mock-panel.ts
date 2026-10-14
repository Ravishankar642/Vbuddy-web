import { LIGHT_IDS, type ApButton, type ApKnob, type LightId, type PanelState, type SysId } from "@vbuddy/protocol";
import type { PanelBackend, PanelResult } from "./backend.js";

/** A pretend Boeing for the mock flight and tests. */
export class MockPanel implements PanelBackend {
  private s: PanelState;
  constructor(kind: "fenix" | "boeing" = "boeing") {
    this.s = structuredClone(this.initial);
    this.s.aircraft = kind === "boeing" ? "Mock Boeing 737-800" : "Mock Fenix A320";
    this.s.family = kind === "boeing" ? "boeing" : "airbus";
    this.s.cdu = kind === "boeing" ? { sides: 2 } : null;
  }
  private initial: PanelState = {
    aircraft: "Mock Boeing 737-800",
    family: "boeing",
    lights: Object.fromEntries(LIGHT_IDS.map((l) => [l, l === "nav" || l === "panel"])) as PanelState["lights"],
    ap: { master: false, fd: true, athr: true, speed: false, lvlChg: false, hdgSel: false, lnav: false, app: false, altHld: false, vs: false, spd: 250, machMode: false, hdg: 90, alt: 10000, vsFpm: 0, crs: 90 },
    note: null,
    sys: { flapsIndex: 0, flapsCount: 5, spoilersArmed: false, gearDown: true, parkingBrake: true, enginesRunning: 0, engineCount: 2, engines: [false, false], apuOn: false, pitotHeat: false, seatbelts: false, baroHpa: 1013.2, paused: false, simRate: 1, camera: 0, slew: false, wingLeveler: false, doors: [0, 0, 0, 0] },
  };
  private cbs: Array<() => void> = [];
  /** Controls that should pretend the aircraft ignored them (tests). */
  ignore = new Set<string>();

  state() {
    return this.s;
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
  private change(fn: (s: PanelState) => void) {
    this.s = structuredClone(this.s);
    fn(this.s);
    for (const cb of this.cbs) cb();
  }
  async fcu(ctl: "spd" | "hdg" | "alt" | "vs", action: "push" | "pull"): Promise<PanelResult> {
    if (this.s.family !== "airbus" || !this.s.ap) return { ok: false, error: "This aircraft has a Boeing MCP, not an Airbus FCU." };
    if (ctl === "vs") return { ok: true };
    this.change((s) => {
      const m = s.ap!.managed ?? { spd: false, hdg: false, alt: false };
      s.ap!.managed = { ...m, [ctl]: action === "push" };
    });
    return { ok: true };
  }
  async sys(id: SysId, value?: number): Promise<PanelResult> {
    if (this.ignore.has(id)) return { ok: false, error: "The aircraft didn't respond." };
    const on = (value ?? 1) > 0;
    this.change((s) => {
      const x = s.sys!;
      switch (id) {
        case "flapsUp": x.flapsIndex = Math.max(0, x.flapsIndex - 1); break;
        case "flapsDown": x.flapsIndex = Math.min(x.flapsCount, x.flapsIndex + 1); break;
        case "spoilersArm": x.spoilersArmed = on; break;
        case "gear": x.gearDown = on; break;
        case "parkingBrake": x.parkingBrake = on; break;
        case "engines": x.enginesRunning = on ? x.engineCount : 0; x.engines = x.engines?.map(() => on); break;
        case "engine": {
          const n = Math.abs(Math.round(value ?? 0));
          if (x.engines && n >= 1 && n <= x.engines.length) {
            x.engines = x.engines.map((r, i) => (i === n - 1 ? (value ?? 0) > 0 : r));
            x.enginesRunning = x.engines.filter(Boolean).length;
          }
          break;
        }
        case "apu": x.apuOn = on; break;
        case "pitotHeat": x.pitotHeat = on; break;
        case "seatbelts": x.seatbelts = on; break;
        case "baroStd": x.baroHpa = 1013.2; break;
        case "baroSet": x.baroHpa = (value ?? 1013) < 40 ? Math.round((value ?? 29.92) * 33.8639 * 10) / 10 : (value ?? 1013); break;
        case "pause": x.paused = on; break;
        case "simRate": x.simRate = value ?? 1; break;
        case "camera": x.camera = value ?? 0; break;
        case "flapsSet": x.flapsIndex = Math.max(0, Math.min(x.flapsCount, Math.round(value ?? 0))); break;
        case "doorToggle": {
          const n = Math.round(value ?? 1) - 1;
          const d = [...(x.doors ?? [0, 0, 0, 0])];
          d[n] = (d[n] ?? 0) > 5 ? 0 : 100;
          x.doors = d;
          break;
        }
        case "slew": x.slew = on; break;
        case "wingLeveler": x.wingLeveler = on; break;
        default: break; // camera pan and zoom have nothing to show
      }
    });
    return { ok: true };
  }
  async setLight(id: LightId, on: boolean): Promise<PanelResult> {
    if (this.ignore.has(id)) return { ok: false, error: `The ${id} light didn't respond.` };
    this.change((s) => (s.lights[id] = on));
    return { ok: true };
  }
  async press(ctl: ApButton): Promise<PanelResult> {
    if (this.ignore.has(ctl)) return { ok: false, error: "The aircraft didn't respond." };
    this.change((s) => {
      const ap = s.ap!;
      const key = ctl === "cmd" ? "master" : ctl;
      (ap as unknown as Record<string, boolean>)[key] = !(ap as unknown as Record<string, boolean>)[key];
    });
    return { ok: true };
  }
  async set(ctl: ApKnob, value: number): Promise<PanelResult> {
    if (this.ignore.has(ctl)) return { ok: false, error: "The aircraft didn't respond." };
    this.change((s) => {
      const ap = s.ap!;
      if (ctl === "spd") ap.spd = value;
      else if (ctl === "hdg") ap.hdg = value;
      else if (ctl === "alt") ap.alt = value;
      else if (ctl === "vs") ap.vsFpm = value;
      else ap.crs = value;
    });
    return { ok: true };
  }
}
