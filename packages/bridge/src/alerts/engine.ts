import type { FlightAlert, Telemetry } from "@vbuddy/protocol";
import { randomUUID } from "node:crypto";
import type { SimExtras } from "../sim/source.js";
import { distNm } from "../network/geo.js";

/** Where the descent starts: the plan's own TOD fix, or (when it has none) the destination and its elevation. */
export type TodPlan = { kind: "fix"; lat: number; lon: number } | { kind: "dest"; lat: number; lon: number; elevFt: number };

/** Descent rule of thumb: 3 nm for every 1,000 ft to lose. */
const NM_PER_1000FT = 3;
const TOD_MIN_ALT = 10_000;
const TOD_MIN_GS = 150;

const LB_PER_KG = 2.20462;

/** How long a condition must hold before it is reported, and how long before the same alert may repeat. */
const STALL_HOLD_MS = 1000;
const OVERSPEED_HOLD_MS = 2000;
const ENGINE_HOLD_MS = 3000;
const ENGINE_RUNNING_MS = 15_000;
const COOLDOWN_MS = 60_000;

const AP_ON_MS = 30_000;
const AP_OFF_MS = 2000;
/** Below this the autopilot is normally switched off by the pilot for the approach, so no alert. */
const AP_CRUISE_AGL = 3000;

const SINK_FPM = -2000;
const SINK_BELOW_AGL = 1000;
const GEAR_BELOW_AGL = 800;

/** Fuel burn is measured over this window, so a short blip in the flow doesn't swing the estimate. */
const BURN_WINDOW_MS = 3 * 60_000;
const BURN_MIN_MS = 60_000;

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * Watches the flight for things a pilot would want a tap on the shoulder for.
 * Pure logic: feed it samples with the time, it hands back new alerts. Low fuel is not raised here, because each
 * device picks its own warning time; this class only reports how many minutes of fuel are left.
 */
export class FlightAlerts {
  private since = new Map<string, number>(); // condition -> when it began
  private lastFired = new Map<string, number>();
  private latched = new Set<string>(); // once-per-approach alerts
  private engineUp = new Map<number, number>(); // engine -> running since
  private engineDown = new Set<number>(); // engines already reported as stopped
  private fuelHist: Array<{ at: number; lbs: number; simRate: number }> = [];

  /** Minutes of fuel left at the recent burn rate, in sim time; null until there is enough data. */
  enduranceMin: number | null = null;
  fuelLbs: number | null = null;
  /** Minutes and distance to the top of descent; null when unknown, not in the cruise, or already passed. */
  todMinAway: number | null = null;
  todNm: number | null = null;
  private tod: TodPlan | null = null;
  private todPassed = false;

  setTodPlan(p: TodPlan | null) {
    this.tod = p;
  }

  reset() {
    this.since.clear();
    this.lastFired.clear();
    this.latched.clear();
    this.engineUp.clear();
    this.engineDown.clear();
    this.fuelHist = [];
    this.enduranceMin = null;
    this.fuelLbs = null;
    this.todMinAway = null;
    this.todNm = null;
    this.todPassed = false;
  }

  /** True once `cond` has held continuously for `ms`. */
  private held(key: string, cond: boolean, ms: number, now: number): boolean {
    if (!cond) {
      this.since.delete(key);
      return false;
    }
    const s = this.since.get(key);
    if (s === undefined) {
      this.since.set(key, now);
      return ms === 0;
    }
    return now - s >= ms;
  }

  private fire(key: string, now: number, a: Omit<FlightAlert, "id">, out: FlightAlert[]) {
    const last = this.lastFired.get(key);
    if (last !== undefined && now - last < COOLDOWN_MS) return;
    this.lastFired.set(key, now);
    out.push({ id: randomUUID(), ...a });
  }

  update(t: Telemetry, x: SimExtras, now: number): FlightAlert[] {
    const out: FlightAlert[] = [];
    const air = !t.onGround;

    // Fuel: how long what's left will last, from the burn over the last few minutes (sim time).
    this.fuelLbs = x.fuelLbs;
    if (x.fuelLbs !== null && air) {
      this.fuelHist.push({ at: now, lbs: x.fuelLbs, simRate: t.simRate || 1 });
      while (this.fuelHist.length > 1 && now - this.fuelHist[0]!.at > BURN_WINDOW_MS) this.fuelHist.shift();
      const first = this.fuelHist[0]!;
      const span = now - first.at;
      const burned = first.lbs - x.fuelLbs;
      if (span >= BURN_MIN_MS && burned > 0) {
        const lbsPerMsReal = burned / span;
        this.enduranceMin = (x.fuelLbs / lbsPerMsReal / 60_000) * (t.simRate || 1);
      } else if (span >= BURN_MIN_MS) {
        this.enduranceMin = null; // not burning (e.g. refuelling or paused): no estimate
      }
    } else if (!air) {
      this.fuelHist = [];
      this.enduranceMin = null;
    }

    // Top of descent: how far (and how long) until the descent should start.
    this.todMinAway = null;
    this.todNm = null;
    if (!air || t.altMsl < TOD_MIN_ALT) {
      this.todPassed = false;
    } else if (this.tod && !this.todPassed && t.gs >= TOD_MIN_GS && t.vs > -1000) {
      const p = this.tod;
      let nm: number | null = null;
      if (p.kind === "fix") {
        nm = distNm(t.lat, t.lon, p.lat, p.lon);
        if (nm < 2) this.todPassed = true;
      } else if (Math.abs(t.vs) < 500) {
        nm = distNm(t.lat, t.lon, p.lat, p.lon) - (Math.max(0, t.altMsl - p.elevFt) / 1000) * NM_PER_1000FT;
        if (nm < 2) this.todPassed = true;
      }
      if (nm !== null && !this.todPassed) {
        this.todNm = nm;
        this.todMinAway = (nm / t.gs) * 60;
      }
    }

    // Autopilot dropping out away from the approach: it had been on for a while, then went off.
    if (air && t.ap.master) {
      if (!this.since.has("apOn")) this.since.set("apOn", now);
      this.since.delete("apOff");
    } else if (this.since.has("apOn")) {
      const wasOnLong = now - this.since.get("apOn")! >= AP_ON_MS;
      if (!air || !wasOnLong) this.since.delete("apOn");
      else if (this.held("apOff", true, AP_OFF_MS, now)) {
        this.since.delete("apOn");
        this.since.delete("apOff");
        if (t.altAgl > AP_CRUISE_AGL) this.fire("autopilot", now, { kind: "autopilot", severity: "caution", title: "Autopilot off", text: `The autopilot switched off at ${fmt(t.altMsl)} ft.` }, out);
      }
    }

    // Engines
    const n = x.engineCount ?? 0;
    const eng = [x.eng1, x.eng2, x.eng3, x.eng4];
    for (let i = 0; i < Math.min(n, 4); i++) {
      const v = eng[i];
      if (v === null || v === undefined) continue;
      const running = v >= 0.5;
      if (running && air) {
        if (!this.engineUp.has(i)) this.engineUp.set(i, now);
        if (this.engineDown.delete(i)) this.since.delete(`eng${i}`);
      } else if (!running && air) {
        const up = this.engineUp.get(i);
        if (up !== undefined && now - up >= ENGINE_RUNNING_MS && this.held(`eng${i}`, true, ENGINE_HOLD_MS, now) && !this.engineDown.has(i)) {
          this.engineDown.add(i);
          this.engineUp.delete(i);
          const stopped = [...this.engineDown].length;
          this.fire(`engine${i}`, now, { kind: "engine", severity: "warning", title: stopped >= n ? "All engines stopped" : `Engine ${i + 1} stopped`, text: stopped >= n ? "No engine is running." : `Engine ${i + 1} has stopped (${n - stopped} of ${n} still running).` }, out);
        }
      } else {
        this.engineUp.delete(i); // on the ground: shutdown is normal
        this.engineDown.delete(i);
        this.since.delete(`eng${i}`);
      }
    }

    if (this.held("stall", air && x.stallWarning !== null && x.stallWarning >= 0.5, STALL_HOLD_MS, now)) {
      this.fire("stall", now, { kind: "stall", severity: "warning", title: "Stall warning", text: `Stall warning at ${fmt(t.ias)} kt, ${fmt(t.altAgl)} ft above ground.` }, out);
    }
    if (this.held("overspeed", air && x.overspeedWarning !== null && x.overspeedWarning >= 0.5, OVERSPEED_HOLD_MS, now)) {
      this.fire("overspeed", now, { kind: "overspeed", severity: "caution", title: "Overspeed", text: `Overspeed warning at ${fmt(t.ias)} kt.` }, out);
    }

    // Low and descending: once per approach. Re-armed by climbing out or touching down.
    if (!air || t.altAgl > 2000) {
      this.latched.delete("gear");
      this.latched.delete("sink");
    }
    if (air && !t.gearDown && t.altAgl < GEAR_BELOW_AGL && t.vs < -200 && !this.latched.has("gear")) {
      this.latched.add("gear");
      this.fire("gear", now, { kind: "gear", severity: "warning", title: "Gear is up", text: `Gear is up and you are ${fmt(t.altAgl)} ft above ground, descending.` }, out);
    }
    if (air && t.altAgl < SINK_BELOW_AGL && t.altAgl > 50 && t.vs < SINK_FPM && !this.latched.has("sink")) {
      this.latched.add("sink");
      this.fire("sink", now, { kind: "sink", severity: "warning", title: "High sink rate", text: `Sink rate ${fmt(-t.vs)} ft/min at ${fmt(t.altAgl)} ft above ground.` }, out);
    }
    return out;
  }

  fuelText(unit: "kg" | "lbs" = "kg"): string {
    if (this.fuelLbs === null) return "";
    return unit === "kg" ? `${fmt(this.fuelLbs / LB_PER_KG)} kg` : `${fmt(this.fuelLbs)} lb`;
  }
}
