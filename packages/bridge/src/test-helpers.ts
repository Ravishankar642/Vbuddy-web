import type { SimStatus, Telemetry } from "@vbuddy/protocol";
import type { SimExtras, SimSource } from "./sim/source.js";

export function sampleTelemetry(over: Partial<Telemetry> = {}): Telemetry {
  return {
    lat: 1, lon: 2, altMsl: 1000, altAgl: 900, groundElev: 100, pitch: 0, bank: 0, hdgTrue: 90, hdgMag: 89, track: 90,
    ias: 200, tas: 210, gs: 210, mach: 0.32, vs: 0, onGround: false, gForce: 1, gearDown: false, flapsIndex: 0,
    parkingBrake: false, simRate: 1, ap: { master: true, altSel: 5000, hdgSel: 90, spdSel: 220, vsSel: 0 },
    ...over,
  };
}

/** A SimSource the test drives by hand. */
export class FakeSource implements SimSource {
  sampleCbs: Array<(t: Telemetry, at: number) => void> = [];
  extrasCbs: Array<(e: SimExtras, at: number) => void> = [];
  statusCbs: Array<(s: SimStatus) => void> = [];
  st: SimStatus = { connected: true, source: "mock", paused: false, aircraftTitle: "Test" };
  start() {}
  async stop() {}
  onSample(cb: (t: Telemetry, at: number) => void) { this.sampleCbs.push(cb); }
  onExtras(cb: (e: SimExtras, at: number) => void) { this.extrasCbs.push(cb); }
  onStatus(cb: (s: SimStatus) => void) { this.statusCbs.push(cb); }
  status() { return this.st; }
  emit(t: Telemetry, at = Date.now()) { for (const cb of this.sampleCbs) cb(t, at); }
  setStatus(s: Partial<SimStatus>) { this.st = { ...this.st, ...s }; for (const cb of this.statusCbs) cb(this.st); }
}
