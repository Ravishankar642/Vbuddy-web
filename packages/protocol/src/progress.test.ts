import { test } from "node:test";
import assert from "node:assert/strict";
import { computeProgress, distNm, type FuelPlan, type ProfilePoint } from "./index.js";

// A straight route along the equator: 0, 100, 300 (TOD), 400 nm. One degree of longitude is about 60 nm there.
const P = (ident: string, lonDeg: number, altFt: number, fuelKg: number, stage: ProfilePoint["stage"]): ProfilePoint => ({ ident, lat: 0, lon: lonDeg, distNm: Math.round(distNm(0, 0, 0, lonDeg)), altFt, fuelKg, timeMin: null, stage });
const profile = [P("DEP", 0, 0, 10000, "CLB"), P("TOC", 100 / 60, 36000, 9000, "CRZ"), P("TOD", 300 / 60, 36000, 4000, "CRZ"), P("ARR", 400 / 60, 0, 3000, "DSC")];
const fuel: FuelPlan = { takeoffKg: 10000, landingKg: 3000, reserveKg: 1200, alternateKg: 1000, minLandingKg: 2200 };

test("progress: distance along the route, planned altitude and fuel, top of descent", () => {
  const r = computeProgress(profile, fuel, { lat: 0.05, lon: 200 / 60, altFt: 35000, onGround: false, fuelKg: 6500 })!;
  assert.ok(Math.abs(r.progress.alongNm - 200) < 1);
  assert.ok(Math.abs(r.progress.offRouteNm - 3) < 0.2);
  assert.equal(r.progress.plannedAltFt, 36000);
  assert.equal(r.progress.altDevFt, -1000);
  assert.equal(r.progress.vertical, "ok", "in cruise high/low isn't flagged");
  assert.ok(Math.abs(r.progress.todNm! - 100) < 1);
  assert.equal(r.progress.nextFix, "TOD");
  // The plan has 6,500 kg here and lands with 3,000.
  assert.equal(r.progress.plannedFuelKg, 6500);
  assert.equal(r.progress.predLandingKg, 3000);
  assert.equal(r.progress.fuelState, "ok");
});

test("progress: high on the descent, and fuel states", () => {
  const high = computeProgress(profile, fuel, { lat: 0, lon: 350 / 60, altFt: 25000, onGround: false, fuelKg: 3500 })!.progress;
  assert.equal(high.plannedAltFt, 18000);
  assert.equal(high.vertical, "high");
  assert.ok(high.todNm! < 0);
  assert.equal(high.predLandingKg, 3000);
  const low = computeProgress(profile, fuel, { lat: 0, lon: 200 / 60, altFt: 36000, onGround: false, fuelKg: 5500 })!.progress;
  assert.equal(low.predLandingKg, 2000);
  assert.equal(low.fuelState, "low");
  const crit = computeProgress(profile, fuel, { lat: 0, lon: 200 / 60, altFt: 36000, onGround: false, fuelKg: 4500 })!.progress;
  assert.equal(crit.fuelState, "critical");
});

test("progress: the segment hint keeps it from jumping back to an earlier part of the route", () => {
  // A route that comes back near its start.
  const loop = [P("A", 0, 0, 1000, "CLB"), P("B", 1, 10000, 900, "CRZ"), { ...P("C", 1, 10000, 800, "CRZ"), lat: 1 }, { ...P("D", 0.02, 10000, 700, "CRZ"), lat: 0.05 }];
  let d = 0;
  for (let i = 1; i < loop.length; i++) loop[i] = { ...loop[i]!, distNm: (d += distNm(loop[i - 1]!.lat, loop[i - 1]!.lon, loop[i]!.lat, loop[i]!.lon)) };
  const atEnd = computeProgress(loop, null, { lat: 0.05, lon: 0.1, altFt: 10000, onGround: false, fuelKg: null }, 2)!;
  assert.equal(atEnd.segment, 2);
  assert.equal(atEnd.progress.fuelState, null);
});

test("progress: forecast wind for the rest of the route (eastbound: a westerly is a tailwind)", () => {
  const windy = profile.map((p, i) => ({ ...p, windDeg: 270, windKt: i < 2 ? 100 : 40 }));
  // From 200 nm: the rest is legs 2 and 3, both 40 kt from the west.
  const r = computeProgress(windy, fuel, { lat: 0, lon: 200 / 60, altFt: 36000, onGround: false, fuelKg: 6500 })!.progress;
  assert.equal(r.windRestKt, 40);
  const head = computeProgress(windy.map((p) => ({ ...p, windDeg: 90 })), fuel, { lat: 0, lon: 200 / 60, altFt: 36000, onGround: false, fuelKg: 6500 })!.progress;
  assert.equal(head.windRestKt, -40);
  assert.equal(computeProgress(profile, fuel, { lat: 0, lon: 1, altFt: 0, onGround: false, fuelKg: null })!.progress.windRestKt, null);
});
