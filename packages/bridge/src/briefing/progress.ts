import { randomUUID } from "node:crypto";
import { computeProgress, indicatedAlt, type FlightAlert, type FlightPlanInfo, type Progress, type Telemetry } from "@vbuddy/protocol";

const EVERY_MS = 5000;
const LBS_TO_KG = 0.45359237;

/**
 * Flight progress against the SimBrief plan (vertical profile and fuel), worked out every 5 s while a matched plan is
 * flown, and a fuel alert when you're heading for a landing below reserve + alternate (once each, per plan).
 */
export class ProgressTracker {
  private last: Progress | null = null;
  private lastAt = 0;
  private segment = 0;
  private planKey: string | null = null;
  private warned = { low: false, critical: false };
  private cbs: Array<(p: Progress | null) => void> = [];

  constructor(
    private plan: () => FlightPlanInfo | null,
    private alert: (a: FlightAlert) => void,
  ) {}

  current(): Progress | null {
    return this.last;
  }
  onChange(cb: (p: Progress | null) => void) {
    this.cbs.push(cb);
  }

  update(t: Telemetry, fuelLbs: number | null, now: number) {
    if (now - this.lastAt < EVERY_MS) return;
    this.lastAt = now;
    const p = this.plan();
    if (!p || !p.matched || !p.profile || p.profile.length < 2) return this.set(null);
    const key = `${p.ofpId ?? ""}:${p.loadedAt}`;
    if (key !== this.planKey) {
      this.planKey = key;
      this.segment = 0;
      this.warned = { low: false, critical: false };
    }
    const fuelKg = fuelLbs === null ? null : fuelLbs * LBS_TO_KG;
    const r = computeProgress(p.profile, p.fuelPlan ?? null, { lat: t.lat, lon: t.lon, altFt: indicatedAlt(t), onGround: t.onGround, fuelKg }, this.segment);
    if (!r) return this.set(null);
    this.segment = r.segment;
    const g = r.progress;
    // Fuel alerts only in flight, on the route, and not in the last few miles (where the prediction no longer helps).
    if (!t.onGround && g.offRouteNm < 50 && g.remainingNm > 15 && g.predLandingKg !== null && g.minLandingKg !== null) {
      if (g.fuelState === "critical" && !this.warned.critical) {
        this.warned = { low: true, critical: true };
        this.alert({ id: randomUUID(), kind: "fuel", severity: "warning", title: "Landing into final reserve", text: `At this rate you'll land with ${g.predLandingKg} kg, below the final reserve. Plan a diversion or a shorter routing.` });
      } else if (g.fuelState === "low" && !this.warned.low) {
        this.warned.low = true;
        this.alert({ id: randomUUID(), kind: "fuel", severity: "caution", title: "Fuel below plan", text: `At this rate you'll land with ${g.predLandingKg} kg, less than reserve + alternate (${g.minLandingKg} kg).` });
      }
    }
    this.set(g);
  }

  private set(p: Progress | null) {
    if (JSON.stringify(p) === JSON.stringify(this.last)) return;
    this.last = p;
    for (const cb of this.cbs) cb(p);
  }
}
