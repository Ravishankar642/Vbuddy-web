import { test } from "node:test";
import assert from "node:assert/strict";
import type { Landing, TelemetryFrame } from "@vbuddy/protocol";
import { logger } from "../log.js";
import { sampleTelemetry } from "../test-helpers.js";
import { AtlasService, Airports } from "../atlas/atlas.js";
import { FlightDb } from "./flight-db.js";
import { FlightRecorder } from "./recorder.js";
import { repairFlights } from "./repair.js";

const log = logger("test");
const fr = (seq: number, ts: number, lat: number, lon: number, over = {}): TelemetryFrame => ({ seq, ts, data: sampleTelemetry({ lat, lon, ...over }) });
const landing = (id: string, ts: number, lat: number, lon: number): Landing => ({ id, ts, lat, lon, source: "simconnect", aircraftTitle: "777-300ER", hdgTrue: 0, vsFpm: -150, vsSource: "sim", vsEstimateFpm: null, gPeak: 1.1, pitch: 3, bank: 0, iasKt: 130, gsKt: 130, bounces: 0, bounceMaxFt: 0, touchAndGo: false, lowConfidence: false, rating: "smooth", ratedBy: "vs", wind: null, flare: null, profile: [] }) as unknown as Landing;

async function mem() {
  const db = await FlightDb.open(":memory:", log);
  assert.ok(db);
  return db;
}

test("repair: a flight that began in the menu gets its real start, replayed landings are set aside, junk is hidden", async () => {
  const db = await mem();
  const T = 1_790_000_000_000;
  // Flight 1: began at the menu placeholder (0, 90), then spawned at VOMM, flew to VGHS; plan VOMM-VGHS.
  const f1 = db.openFlight({ sessionId: "s", startedAt: T, source: "simconnect", aircraft: "FenixA320", firstSeq: 0, lat: -0.0, lon: 90.0 });
  const frames: TelemetryFrame[] = [];
  for (let i = 0; i < 20; i++) frames.push(fr(i, T + i * 1000, -0.0, 90.0));
  for (let i = 20; i < 60; i++) frames.push(fr(i, T + i * 1000, 12.99, 80.17));
  for (let i = 60; i < 80; i++) frames.push(fr(i, T + i * 1000, 12.99 + (i - 60) * 0.5, 80.17 + (i - 60) * 0.5));
  db.insertFrames("s", frames);
  db.updateFlight(f1, { endedAt: T + 3 * 3_600_000, lastSeq: 79, frames: 80, endLat: 23.84, endLon: 90.4, maxAltFt: 38000, maxGsKt: 450 });
  db.setFlightPlan(f1, "VOMM", "VGHS");
  // a real landing at VGHS, then two replays of it (same spot), then a "landing" at Doha 40 s later (impossible)
  db.insertLanding(landing("a", T + 3 * 3_600_000, 23.8373, 90.4025), f1);
  db.insertLanding(landing("b", T + 3 * 3_600_000 + 120_000, 23.8373, 90.4025), f1);
  db.insertLanding(landing("c", T + 3 * 3_600_000 + 240_000, 23.8373, 90.4025), f1);
  db.insertLanding(landing("d", T + 3 * 3_600_000 + 280_000, 25.26, 51.62), f1);
  db.updateFlight(f1, { endedAt: T + 3 * 3_600_000 + 300_000, lastSeq: 79, frames: 80, endLat: 25.26, endLon: 51.62, maxAltFt: 38000, maxGsKt: 450 });
  // Flight 2: two minutes in the MSFS 2024 hangar (Boeing Field) - junk.
  const f2 = db.openFlight({ sessionId: "s", startedAt: T + 4 * 3_600_000, source: "simconnect", aircraft: "A380", firstSeq: 100, lat: 47.52, lon: -122.29 });
  db.updateFlight(f2, { endedAt: T + 4 * 3_600_000 + 120_000, lastSeq: 100, frames: 5, endLat: 47.52, endLon: -122.29, maxAltFt: 129, maxGsKt: 0 });

  const r = repairFlights(db, null);
  assert.deepEqual(r, { starts: 2, hidden: 1, landings: 3 });
  const list = db.flights(10);
  assert.deepEqual(list.map((f) => f.id), [f1], "the hangar stretch is hidden");
  const f = list[0]!;
  assert.equal(f.startLat, 12.99);
  assert.equal(f.startLon, 80.17);
  assert.equal(f.landings, 1);
  assert.ok(Math.abs(f.endLat! - 23.8373) < 0.001, "the end is where it really landed, not the replay in Doha");
  // and so it's in the Atlas as VOMM -> VGHS on the plan
  const atlas = new AtlasService(new Airports(), () => null);
  const facts = atlas.withFacts(list, T + 10 * 3_600_000)[0]!;
  assert.equal(facts.from?.icao, "VOMM");
  assert.equal(facts.to?.icao, "VGHS");
  assert.equal(facts.onPlan, true);
  assert.equal(repairFlights(db, null).hidden, 0, "only once");
  db.close();
});

test("recorder with the gate: a spawn that never went anywhere is hidden when it ends; a plan is tied to the open flight", async () => {
  const db = await mem();
  const rec = new FlightRecorder(db, "s", "simconnect", () => "A320", log);
  rec.useGate();
  rec.onFrame(fr(0, 1000, 0, 90)); // menu frames before any flight: not kept
  rec.begin(fr(1, 2000, 12.99, 80.17, { onGround: true, altAgl: 0 }));
  for (let i = 2; i < 30; i++) rec.onFrame(fr(i, 2000 + i * 200, 12.99, 80.17, { onGround: true, altAgl: 0 }));
  rec.finish();
  assert.equal(db.flights(10).length, 0);

  rec.begin(fr(40, 10_000, 12.99, 80.17));
  assert.ok(rec.setPlan({ dep: "VOMM", arr: "VGHS", callsign: "IGO123", route: "DCT", distanceNm: 900, eteMin: 140, ofpId: "x1" }));
  for (let i = 41; i < 80; i++) rec.onFrame(fr(i, 10_000 + i * 1000, 12.99 + (i - 40) * 0.05, 80.17, { onGround: false, altAgl: 5000 }));
  rec.setRecording(false);
  rec.onFrame(fr(80, 100_000, 25.26, 51.62)); // a replay: not kept
  rec.setRecording(true);
  rec.finish();
  const [f] = db.flights(10);
  assert.ok(f);
  assert.equal(f.planDep, "VOMM");
  assert.equal(f.planCallsign, "IGO123");
  assert.equal(f.planDistanceNm, 900);
  assert.ok(f.endLat! < 15, "the replay position wasn't recorded");
  db.close();
});
