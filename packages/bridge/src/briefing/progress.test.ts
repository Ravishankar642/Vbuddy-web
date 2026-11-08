import { test } from "node:test";
import assert from "node:assert/strict";
import { distNm, type FlightAlert, type FlightPlanInfo, type ProfilePoint, type Telemetry } from "@vbuddy/protocol";
import { ProgressTracker } from "./progress.js";

const P = (ident: string, lon: number, altFt: number, fuelKg: number, stage: ProfilePoint["stage"]): ProfilePoint => ({ ident, lat: 0, lon, distNm: distNm(0, 0, 0, lon), altFt, fuelKg, timeMin: null, stage });
const plan = {
  ofpId: "1", callsign: null, dep: "AAAA", arr: "BBBB", route: null, distanceNm: 400, eteMin: 60, cruiseFt: 36000, aircraft: null, fixes: [], matched: true, loadedAt: 1,
  profile: [P("AAAA", 0, 0, 10000, "CLB"), P("TOC", 100 / 60, 36000, 9000, "CRZ"), P("TOD", 300 / 60, 36000, 4000, "CRZ"), P("BBBB", 400 / 60, 0, 3000, "DSC")],
  fuelPlan: { takeoffKg: 10000, landingKg: 3000, reserveKg: 1200, alternateKg: 1000, minLandingKg: 2200 },
} as FlightPlanInfo;
const T = (lon: number): Telemetry => ({ lat: 0, lon, altMsl: 36000, altAgl: 36000, onGround: false } as Telemetry);
const KG = 1 / 0.45359237;

test("progress tracker: updates every 5 s, warns once when heading below reserve + alternate, then once more into final reserve", () => {
  const alerts: FlightAlert[] = [];
  const seen: unknown[] = [];
  const tr = new ProgressTracker(() => plan, (a) => alerts.push(a));
  tr.onChange((p) => seen.push(p));
  tr.update(T(200 / 60), 6500 * KG, 10_000);
  assert.equal(tr.current()!.fuelState, "ok");
  tr.update(T(200 / 60), 5500 * KG, 12_000); // under 5 s: ignored
  assert.equal(tr.current()!.fuelState, "ok");
  tr.update(T(200 / 60), 5500 * KG, 15_000);
  tr.update(T(201 / 60), 5490 * KG, 20_000);
  assert.deepEqual(alerts.map((a) => [a.kind, a.severity]), [["fuel", "caution"]]);
  tr.update(T(202 / 60), 4400 * KG, 25_000);
  assert.deepEqual(alerts.map((a) => a.severity), ["caution", "warning"]);
  assert.ok(seen.length >= 3);
});

test("progress tracker: nothing without a matched plan", () => {
  const tr = new ProgressTracker(() => ({ ...plan, matched: false }), () => assert.fail("no alert"));
  tr.update(T(1), 1000, 10_000);
  assert.equal(tr.current(), null);
});
