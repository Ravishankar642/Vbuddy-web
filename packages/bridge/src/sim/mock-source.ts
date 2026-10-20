import type { SimStatus, Telemetry } from "@vbuddy/protocol";
import { EMPTY_EXTRAS, normDeg, type SimExtras, type SimSource } from "./source.js";

type Phase = "parked" | "roll" | "climb" | "descent" | "approach" | "flare" | "bounce" | "rollout" | "taxi";

const RATE_HZ = 30;
const GROUND_FT = 37; // roughly VABB elevation
const START = { lat: 19.0887, lon: 72.8835, hdg: 270 };
const M_PER_NM = 1852;
const EARTH_R = 6371000;

/** Touchdown scenarios the mock cycles through, one per circuit. */
const SCENARIOS = [
  { name: "smooth", fpm: 110, g: 1.12, bounce: false },
  { name: "firm", fpm: 380, g: 1.45, bounce: false },
  { name: "bounced", fpm: 520, g: 1.7, bounce: true },
] as const;

export interface MockOptions {
  /** Skip takeoff and climb: start on a short final and repeat landings back to back. */
  quick?: boolean;
}

/**
 * A scripted circuit (takeoff, climb, descent, approach, landing, rollout) so
 * the dashboard and landing analyzer can be developed without MSFS running.
 * Each pass lands differently (smooth, firm, bounced). Loops forever.
 *
 * Like the real sim it emits the "touchdown latch" extra, which keeps the
 * previous landing's value until the next touchdown.
 */
export class MockSource implements SimSource {
  private sampleCbs: Array<(t: Telemetry, at: number) => void> = [];
  private extrasCbs: Array<(e: SimExtras, at: number) => void> = [];
  private statusCbs: Array<(s: SimStatus) => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private st: SimStatus = {
    connected: false,
    source: "mock",
    paused: false,
    aircraftTitle: "VBuddy Mock A320",
    atcId: "A7-VBD",
    atcModel: "A20N",
    simName: "VBuddy mock flight",
  };

  private phase: Phase = "parked";
  private phaseT = 0;
  private loop = 0;
  private t!: Telemetry;
  private extras: SimExtras = { ...EMPTY_EXTRAS, cameraState: 2, simRunning: 1, touchdownNormalVelFps: 0, windKt: 8, windFromDeg: 300, fuelLbs: 24000, engineCount: 2, eng1: 1, eng2: 1, stallWarning: 0, overspeedWarning: 0 };

  constructor(private opts: MockOptions = {}) {
    this.reset();
  }

  private get scenario() {
    return SCENARIOS[this.loop % SCENARIOS.length]!;
  }

  onSample(cb: (t: Telemetry, at: number) => void) {
    this.sampleCbs.push(cb);
  }
  onExtras(cb: (e: SimExtras, at: number) => void) {
    this.extrasCbs.push(cb);
  }
  onStatus(cb: (s: SimStatus) => void) {
    this.statusCbs.push(cb);
  }
  status() {
    return this.st;
  }

  start() {
    if (this.timer) return;
    this.st = { ...this.st, connected: true };
    for (const cb of this.statusCbs) cb(this.st);
    const dt = 1 / RATE_HZ;
    this.timer = setInterval(() => {
      this.step(dt);
      const now = Date.now();
      // Extras go out before the sample, like the real sim's separate per-variable requests.
      for (const cb of this.extrasCbs) cb(this.extras, now);
      const snap = structuredClone(this.t);
      for (const cb of this.sampleCbs) cb(snap, now);
    }, 1000 / RATE_HZ);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private reset() {
    this.phase = "parked";
    this.phaseT = 0;
    this.t = {
      lat: START.lat,
      lon: START.lon,
      altMsl: GROUND_FT,
      altAgl: 0,
      groundElev: GROUND_FT,
      pitch: 0,
      bank: 0,
      hdgTrue: START.hdg,
      hdgMag: START.hdg - 0.5,
      track: START.hdg,
      ias: 0,
      tas: 0,
      gs: 0,
      mach: 0,
      vs: 0,
      onGround: true,
      gForce: 1,
      gearDown: true,
      flapsIndex: 2,
      parkingBrake: true,
      simRate: 1,
      ap: { master: false, altSel: 3000, hdgSel: START.hdg, spdSel: 220, vsSel: 0 },
    };
    if (this.opts.quick) {
      Object.assign(this.t, {
        altMsl: GROUND_FT + 800,
        altAgl: 800,
        onGround: false,
        parkingBrake: false,
        ias: 140,
        tas: 150,
        gs: 150,
        vs: -700,
        pitch: 2.5,
        flapsIndex: 4,
      });
      this.phase = "approach";
    }
  }

  private go(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private touchdown(vsFpm: number, g: number) {
    const t = this.t;
    t.onGround = true;
    t.gForce = g;
    // The sim latches its own touchdown velocity at contact (ft/s, negative = down).
    this.extras = { ...this.extras, touchdownNormalVelFps: vsFpm / 60 };
  }

  private step(dt: number) {
    const t = this.t;
    // Burn about 7,200 lb/h while flying; a fresh tank each time the loop restarts.
    if (!t.onGround && this.extras.fuelLbs !== null) this.extras = { ...this.extras, fuelLbs: Math.max(0, this.extras.fuelLbs - 2 * dt) };
    this.phaseT += dt;
    const approach = (cur: number, target: number, rate: number) =>
      cur < target ? Math.min(target, cur + rate * dt) : Math.max(target, cur - rate * dt);
    let gTarget = 1;
    const sc = this.scenario;

    switch (this.phase) {
      case "parked":
        if (this.phaseT > 5) {
          t.parkingBrake = false;
          this.go("roll");
        }
        break;
      case "roll":
        t.ias = approach(t.ias, 155, 4);
        if (t.ias > 140) t.pitch = approach(t.pitch, 8, 3);
        if (t.ias >= 150) {
          t.onGround = false;
          this.go("climb");
        }
        break;
      case "climb":
        t.vs = approach(t.vs, 2000, 600);
        t.ias = approach(t.ias, 220, 1.5);
        t.pitch = approach(t.pitch, 10, 2);
        if (t.altAgl > 400) t.gearDown = false;
        if (t.altAgl > 1200) t.flapsIndex = 0;
        if (t.altAgl > 1000) t.ap.master = true;
        if (t.altAgl >= 1500) this.go("descent");
        break;
      case "descent":
        t.vs = approach(t.vs, -1200, 500);
        t.ias = approach(t.ias, 160, 1.5);
        t.pitch = approach(t.pitch, 0, 2);
        t.ap.altSel = 1000;
        if (t.altAgl <= 1000) this.go("approach");
        break;
      case "approach":
        t.ap.master = false;
        t.gearDown = true;
        t.flapsIndex = 4;
        t.vs = approach(t.vs, -700, 300);
        t.ias = approach(t.ias, 138, 1);
        t.pitch = approach(t.pitch, 2.5, 1);
        if (t.altAgl <= 40) this.go("flare");
        break;
      case "flare":
        // Sink rate eases off with height, like a real flare, and ends at the scenario's rate.
        t.vs = Math.min(t.vs + 900 * dt, -(sc.fpm + t.altAgl * 4));
        t.pitch = approach(t.pitch, 5, 2);
        t.ias = approach(t.ias, 132, 1.5);
        if (t.altAgl <= 0) {
          this.touchdown(t.vs, sc.g);
          t.vs = 0;
          this.go(sc.bounce ? "bounce" : "rollout");
        }
        break;
      case "bounce":
        if (t.onGround) {
          // wheels on the runway for a moment, then the rebound
          if (this.phaseT >= 0.15) {
            t.vs = 700;
            t.onGround = false;
          }
          break;
        }
        t.vs -= 1000 * dt; // gravity: ~4 ft hop, about 1.4 s in the air
        t.pitch = approach(t.pitch, 4, 2);
        if (t.vs < 0 && t.altAgl <= 0) {
          t.onGround = true;
          t.vs = 0;
          t.gForce = 1.3;
          this.go("rollout");
        }
        break;
      case "rollout":
        t.vs = 0;
        t.pitch = approach(t.pitch, 0, 3);
        t.ias = approach(t.ias, 15, 3.5);
        if (t.ias <= 15) this.go("taxi");
        break;
      case "taxi":
        t.ias = approach(t.ias, 0, 3);
        t.flapsIndex = 0;
        if (this.phaseT > 6) {
          this.loop++;
          this.reset();
        }
        break;
    }

    // Kinematics
    if (!t.onGround) t.altMsl += (t.vs / 60) * dt;
    if (t.altMsl <= GROUND_FT) {
      t.altMsl = GROUND_FT;
      if (this.phase !== "flare" && this.phase !== "bounce") t.vs = Math.max(0, t.vs);
    }
    t.altAgl = t.altMsl - GROUND_FT;
    t.tas = t.ias * (1 + (t.altMsl / 1000) * 0.02);
    t.gs = t.tas;
    t.mach = t.tas / 661.5;
    t.track = t.hdgTrue;
    t.hdgMag = normDeg(t.hdgTrue - 0.5);
    t.gForce = t.gForce + (gTarget - t.gForce) * Math.min(1, dt * 4) + (t.onGround ? 0 : Math.sin(Date.now() / 700) * 0.003);

    const dist = ((t.gs * M_PER_NM) / 3600) * dt;
    const brg = (t.track * Math.PI) / 180;
    const lat1 = (t.lat * Math.PI) / 180;
    t.lat += ((dist * Math.cos(brg)) / EARTH_R) * (180 / Math.PI);
    t.lon += ((dist * Math.sin(brg)) / (EARTH_R * Math.cos(lat1))) * (180 / Math.PI);
  }
}

