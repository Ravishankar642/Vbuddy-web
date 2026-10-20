import type { FlightEvent, Telemetry } from "@vbuddy/protocol";
import { nm } from "../sim/flight-gate.js";
import type { SimExtras } from "../sim/source.js";

/** What the events need to know about the plan. */
export interface EventPlan {
  arr: string;
  arrLat: number | null;
  arrLon: number | null;
  cruiseFt: number | null;
}

let seq = 0;
const ev = (kind: FlightEvent["kind"], title: string, text: string): FlightEvent => ({ id: `${Date.now().toString(36)}-${(seq++).toString(36)}`, kind, title, text });
const fl = (ft: number) => (ft >= 18_000 ? `FL${Math.round(ft / 100)}` : `${Math.round(ft / 100) * 100} ft`);

/**
 * The milestones of a flight, worked out from the telemetry (about twice a second): wheels up, top of climb,
 * passing 10,000 ft both ways, getting near the destination, and parked at the gate after landing. Each one is
 * told once per flight (10,000 ft once each way). The app shows them; the push service sends them to devices
 * that want them.
 */
export class FlightEvents {
  private plan: EventPlan | null = null;
  private airborneSince: number | null = null;
  private tookOff = false;
  private toc = false;
  private tenUp = false;
  private tenDown = false;
  private landed = false;
  private atGate = false;
  private approachSaid = false;
  private levelSince: number | null = null;
  private maxAlt = 0;
  /** Minutes and miles to the destination at the current ground speed (null without a plan or on the ground). */
  destMinAway: number | null = null;
  destNm: number | null = null;

  setPlan(p: EventPlan | null) {
    this.plan = p;
  }

  /** A new flight begins. */
  reset() {
    this.airborneSince = null;
    this.tookOff = this.toc = this.tenUp = this.tenDown = this.landed = this.atGate = this.approachSaid = false;
    this.levelSince = null;
    this.maxAlt = 0;
    this.destMinAway = this.destNm = null;
  }

  update(t: Telemetry, x: SimExtras, at: number): FlightEvent[] {
    const out: FlightEvent[] = [];
    const air = !t.onGround && t.altAgl > 50;

    // --- wheels up
    if (air) {
      if (this.airborneSince === null) this.airborneSince = at;
      if (!this.tookOff && at - this.airborneSince > 5_000 && t.ias > 60) {
        this.tookOff = true;
        this.landed = this.atGate = false;
        out.push(ev("takeoff", "Airborne", `Wheels up${this.plan ? `, on the way to ${this.plan.arr}` : ""}.`));
      }
    } else this.airborneSince = null;
    this.maxAlt = Math.max(this.maxAlt, t.altMsl);

    // --- 10,000 ft
    if (this.tookOff && !this.tenUp && t.altMsl >= 10_000 && t.vs > 300) {
      this.tenUp = true;
      out.push(ev("tenK", "Passing 10,000 ft", "Climbing through 10,000 ft."));
    }
    if (this.tookOff && this.tenUp && !this.tenDown && this.maxAlt > 12_000 && t.altMsl <= 10_000 && t.vs < -300) {
      this.tenDown = true;
      out.push(ev("tenK", "Passing 10,000 ft", "Descending through 10,000 ft."));
    }

    // --- top of climb: the cruise altitude of the plan, or levelled off high for two minutes
    if (this.tookOff && !this.toc) {
      const cruise = this.plan?.cruiseFt ?? null;
      const level = Math.abs(t.vs) < 300 && t.altMsl > 10_000;
      if (level) this.levelSince ??= at;
      else this.levelSince = null;
      if ((cruise !== null && t.altMsl >= cruise - 300 && Math.abs(t.vs) < 500) || (cruise === null && this.levelSince !== null && at - this.levelSince > 120_000)) {
        this.toc = true;
        out.push(ev("toc", "Top of climb", `Levelled off at ${fl(t.altMsl)}.`));
      }
    }

    // --- the destination
    const p = this.plan;
    if (p && p.arrLat !== null && p.arrLon !== null && air && t.gs > 60) {
      this.destNm = nm(t.lat, t.lon, p.arrLat, p.arrLon);
      this.destMinAway = (this.destNm / t.gs) * 60;
      if (!this.approachSaid && this.tookOff && this.destMinAway <= 10 && this.toc) {
        this.approachSaid = true;
        out.push(ev("approach", `Approaching ${p.arr}`, `About ${Math.max(1, Math.round(this.destMinAway))} min (${Math.round(this.destNm)} nm) to go.`));
      }
    } else if (!air) {
      this.destMinAway = this.destNm = null;
    }

    // --- landed, then parked at the gate: stopped, parking brake set, engines off
    if (this.tookOff && t.onGround && t.gs < 30) this.landed = true;
    const engines = [x.eng1, x.eng2, x.eng3, x.eng4].slice(0, Math.max(1, Math.min(4, x.engineCount ?? 2)));
    const enginesOff = engines.every((e) => e === 0 || e === null) && engines.some((e) => e === 0);
    if (this.landed && !this.atGate && t.onGround && t.gs < 1 && t.parkingBrake && enginesOff) {
      this.atGate = true;
      this.tookOff = false; // a new departure from here counts again
      out.push(ev("gate", "At the gate", `Parked${p ? ` at ${p.arr}` : ""}, engines off.`));
    }
    return out;
  }
}

/** The simulator went away while a flight was open. */
export function simLostEvent(airborne: boolean): FlightEvent {
  return ev("simLost", "Simulator stopped", airborne ? "MSFS closed or stopped sending data in the middle of your flight." : "MSFS closed or stopped sending data.");
}

export function planLoadedEvent(p: { callsign: string | null; dep: string; arr: string; matched: boolean }): FlightEvent {
  return ev("planLoaded", "Flight plan loaded", `SimBrief ${p.callsign ? p.callsign + " " : ""}${p.dep} → ${p.arr}${p.matched ? "" : " (it doesn't start where you are)"}.`);
}

export function pausedEvent(text: string): FlightEvent {
  return ev("paused", "Simulator paused", text);
}

export function todEvent(min: number, nmAway: number): FlightEvent {
  return ev("tod", "Top of descent ahead", `The descent should start in about ${Math.max(1, Math.round(min))} min (${Math.round(nmAway)} nm).`);
}
