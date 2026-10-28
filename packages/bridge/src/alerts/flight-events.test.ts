import assert from "node:assert/strict";
import { test } from "node:test";
import { logger } from "../log.js";
import { sampleTelemetry } from "../test-helpers.js";
import { EMPTY_EXTRAS } from "../sim/source.js";
import { PlanTracker, planInfo } from "../briefing/plan-tracker.js";
import { FlightEvents } from "./flight-events.js";

const ofp = (dep = "VOMM", arr = "VGHS", id = "1") =>
  ({
    ofp: { ofpId: id, callsign: "IGO123", route: "DCT", distanceNm: 900, eteMin: 140, cruiseFt: 36000, aircraft: "A20N" },
    airports: [
      { role: "origin", icao: dep, lat: 12.99, lon: 80.17 },
      { role: "destination", icao: arr, lat: 23.84, lon: 90.4 },
    ],
    fixes: [{ ident: "MMV", lat: 13.5, lon: 81, altFt: 20000, via: null }],
  }) as never;

test("plan: matched when the flight began at its departure, not when it began somewhere else", () => {
  assert.equal(planInfo(ofp(), { lat: 12.995, lon: 80.165, airborne: false }, 0).matched, true);
  assert.equal(planInfo(ofp(), { lat: 47.52, lon: -122.29, airborne: false }, 0).matched, false);
  assert.equal(planInfo(ofp(), { lat: 13.6, lon: 81.1, airborne: true }, 0).matched, true, "an air start near the route");
  const p = planInfo(ofp(), null, 0);
  assert.deepEqual(p.fixes.map((f) => f.ident), ["VOMM", "MMV", "VGHS"]);
});

test("plan tracker: says when a new plan arrives, not when the same one is loaded again", async () => {
  let plan = ofp();
  const t = new PlanTracker({ plan: async () => plan }, logger("test"));
  const seen: string[] = [];
  t.onChange((p, why) => seen.push(`${why}:${p?.ofpId}:${p?.matched}`));
  await t.refresh("vatsim", null);
  await t.refresh("timer", null);
  plan = ofp("VOMM", "VOBL", "2");
  await t.refresh("vatsim", { lat: 12.99, lon: 80.17, airborne: false });
  assert.deepEqual(seen, ["vatsim:1:false", "vatsim:2:true"]);
});

test("plan tracker: a flown plan leaves the app and doesn't come back until SimBrief has a new one", async () => {
  let plan = ofp();
  const t = new PlanTracker({ plan: async () => plan }, logger("test"));
  const seen: string[] = [];
  t.onChange((p, why) => seen.push(`${why}:${p?.ofpId ?? "none"}`));
  await t.refresh("vatsim", null);
  t.done();
  assert.equal(t.current(), null);
  assert.equal(await t.refresh("timer", null), null);
  plan = ofp("VOBL", "VOMM", "2");
  await t.refresh("flight-start", { lat: 12.99, lon: 80.17, airborne: false });
  assert.deepEqual(seen, ["vatsim:1", "flown:none", "flight-start:2"]);
});

test("repair: a plan a short hidden stretch took goes back to the flight after it", async () => {
  const { FlightDb } = await import("../db/flight-db.js");
  const { repairPlans } = await import("../db/repair.js");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const db = (await FlightDb.open(join(mkdtempSync(join(tmpdir(), "vb-rp-")), "f.db"), logger("test")))!;
  const at = Date.parse("2026-10-27T09:19:00Z");
  const mk = (start: number) => db.openFlight({ sessionId: "s", startedAt: start, source: "simconnect", aircraft: "FenixA321", firstSeq: 0, lat: 24.43, lon: 54.65 });
  const short = mk(at);
  const real = mk(at + 120_000);
  db.setFlightPlan(short, "OMAA", "VOMM", { callsign: "ETD8KU", route: "DCT", distanceNm: 1500, eteMin: 220, ofpId: "191345040" });
  db.hideFlight(short);
  assert.equal(repairPlans(db, null), 1);
  const f = db.allFlights().find((x) => x.id === real)!;
  assert.equal(f.planDep, "OMAA");
  assert.equal(f.planCallsign, "ETD8KU");
  assert.equal(repairPlans(db, null), 0, "runs once");
  db.close();
});

test("events: takeoff, 10,000 ft both ways, top of climb, near the destination and at the gate, each once", () => {
  const e = new FlightEvents();
  e.setPlan({ arr: "VGHS", arrLat: 23.84, arrLon: 90.4, cruiseFt: 36000 });
  const kinds: string[] = [];
  let at = 0;
  const step = (over: Parameters<typeof sampleTelemetry>[0], secs = 1, x = EMPTY_EXTRAS) => {
    for (let i = 0; i < secs * 2; i++) {
      at += 500;
      for (const ev of e.update(sampleTelemetry(over), x, at)) kinds.push(ev.kind);
    }
  };
  step({ onGround: true, altAgl: 0, ias: 0, gs: 0, altMsl: 50, lat: 12.99, lon: 80.17 }, 10);
  step({ onGround: false, altAgl: 500, ias: 160, gs: 160, altMsl: 600, vs: 2000, lat: 13, lon: 80.2 }, 10);
  step({ onGround: false, altAgl: 10500, ias: 280, gs: 300, altMsl: 10500, vs: 2000, lat: 15, lon: 83 }, 2);
  step({ onGround: false, altAgl: 36000, ias: 260, gs: 450, altMsl: 36000, vs: 0, lat: 18, lon: 86 }, 5);
  step({ onGround: false, altAgl: 9000, ias: 250, gs: 280, altMsl: 9000, vs: -1500, lat: 23.2, lon: 90.1 }, 5);
  step({ onGround: true, altAgl: 0, ias: 20, gs: 20, altMsl: 30, vs: 0, lat: 23.84, lon: 90.4 }, 5);
  step({ onGround: true, altAgl: 0, ias: 0, gs: 0, altMsl: 30, vs: 0, lat: 23.84, lon: 90.4, parkingBrake: true }, 5, { ...EMPTY_EXTRAS, engineCount: 2, eng1: 0, eng2: 0 });
  assert.deepEqual(kinds, ["takeoff", "tenK", "toc", "tenK", "approach", "gate"]);
});
