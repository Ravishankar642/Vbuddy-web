import { test } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../log.js";
import { FlightDb, type FlightRow, type TrackPoint } from "../db/flight-db.js";
import { FlightRecorder } from "../db/recorder.js";
import { sampleTelemetry } from "../test-helpers.js";
import { LegBook } from "../db/legs.js";
import { Airports, AtlasService, distanceNm, trackLengthNm } from "./atlas.js";

const flight = (id: number, over: Partial<FlightRow> = {}): FlightRow => ({
  id, sessionId: "s", startedAt: 1_000_000, endedAt: 1_000_000 + 3_600_000, source: "mock", aircraft: "A320", firstSeq: 0, lastSeq: 10, frames: 11,
  startLat: 51.4706, startLon: -0.4619, endLat: 40.6398, endLon: -73.7789, maxAltFt: 37000, maxGsKt: 480, landings: 1, distanceNm: null, planDep: "EGLL", planArr: "KJFK", ...over,
});

test("the airport list finds the airport a position is at, and prefers the big one", () => {
  const ap = new Airports();
  assert.ok(ap.list.length > 10000);
  assert.equal(ap.nearest(51.4706, -0.4619)?.icao, "EGLL");
  assert.equal(ap.nearest(40.6398, -73.7789)?.icao, "KJFK");
  assert.equal(ap.nearest(0, -30), null, "mid-ocean is no airport");
  assert.equal(ap.get("egll")?.country, "GB");
});

test("distance and track length", () => {
  assert.ok(Math.abs(distanceNm(51.4706, -0.4619, 40.6398, -73.7789) - 2991) < 30);
  const pts: TrackPoint[] = [[0, 0, 0, 0, 0, 0], [1, 0, 1, 0, 0, 0], [2, 0, 2, 0, 0, 0], [3, 40, 40, 0, 0, 0]];
  assert.ok(Math.abs(trackLengthNm(pts) - 120) < 1, "a huge jump (a gap in the recording) isn't counted");
});

test("atlas adds up flights, airports, countries and aircraft", () => {
  // a dense path London to New York along a meridian-ish line, 50 steps
  const track = (): TrackPoint[] => Array.from({ length: 51 }, (_, i) => [i, 51.47 + (40.64 - 51.47) * (i / 50), -0.46 + (-73.78 + 0.46) * (i / 50), 0, 0, 0] as TrackPoint);
  const svc = new AtlasService(new Airports(), track);
  const rows = [
    flight(1),
    flight(2, { startLat: 40.6398, startLon: -73.7789, endLat: 51.4706, endLon: -0.4619, aircraft: "737", planDep: "KJFK", planArr: "EGLL" }),
    flight(3, { planDep: null, planArr: null }), // flown with no plan filled in
    flight(4, { planArr: "KBOS" }), // plan said Boston, the flight went to New York
  ];
  const a = svc.atlas(rows, 99_000_000);
  assert.equal(a.flights, 2, "only flights flown on the plan's route are logged");
  assert.equal(a.landings, 2);
  assert.equal(a.airports.find((x) => x.icao === "EGLL")?.visits, 2);
  assert.equal(a.airports.find((x) => x.icao === "KJFK")?.visits, 2);
  assert.deepEqual(a.countries, ["GB", "US"]);
  assert.equal(a.aircraft.length, 2);
  assert.ok(a.distanceNm > 5000);
  const facts = svc.withFacts(rows, 99_000_000);
  assert.deepEqual(facts.map((f) => f.onPlan), [true, true, false, false]);
  assert.equal(facts[0]!.from?.icao, "EGLL");
});

test("the recorder ties a flight to the SimBrief plan filled in when it began, or first filled in later, and keeps the first", async () => {
  const db = await FlightDb.open(":memory:", logger("test"));
  assert.ok(db);
  let plan: { dep: string; arr: string } | null = null;
  const rec = new FlightRecorder(db, "s", "mock", () => "A320", logger("test"), {}, () => plan);
  rec.onFrame({ seq: 0, ts: 1000, data: sampleTelemetry({ lat: 51.47, lon: -0.46 }) });
  rec.flush();
  assert.equal(db.flights()[0]!.planDep, null, "no plan yet");
  plan = { dep: "EGLL", arr: "KJFK" };
  rec.onFrame({ seq: 1, ts: 1200, data: sampleTelemetry({ lat: 51.5, lon: -0.5 }) });
  rec.flush();
  plan = { dep: "LFPG", arr: "EDDF" };
  rec.onFrame({ seq: 2, ts: 1400, data: sampleTelemetry({ lat: 51.6, lon: -0.6 }) });
  rec.flush();
  const f = db.flights()[0]!;
  assert.deepEqual([f.planDep, f.planArr], ["EGLL", "KJFK"]);
  rec.stop();
  db.close();
});

test("a flight's distance is kept once worked out, so it survives the route being pruned", () => {
  const kept = new Map<number, number>();
  let pruned = false;
  const track = (): TrackPoint[] | null => (pruned ? [] : Array.from({ length: 21 }, (_, i) => [i, 51 + i * 0.1, 0, 0, 0, 0] as TrackPoint));
  const svc = new AtlasService(new Airports(), track, (id, nm) => kept.set(id, nm));
  const first = svc.withFacts([flight(7)], 99_000_000)[0]!;
  assert.ok(first.distanceNm > 100);
  assert.equal(kept.get(7), first.distanceNm);
  pruned = true;
  const later = new AtlasService(new Airports(), track, () => assert.fail("already stored"));
  assert.equal(later.withFacts([flight(7, { distanceNm: kept.get(7)! })], 99_000_000)[0]!.distanceNm, first.distanceNm);
  assert.equal(svc.withFacts([flight(8)], 99_000_000)[0]!.distanceNm, 0, "no route and nothing stored is shown as zero, not guessed");
});

test("planned legs: add, change, delete, and bad input is turned away with a plain reason", async () => {
  const db = await FlightDb.open(":memory:", logger("test"));
  assert.ok(db);
  const book = new LegBook(db);
  let notified = 0;
  book.onChange(() => notified++);
  assert.deepEqual(book.run({ op: "add", dep: " egll ", arr: "kjfk", aircraft: "A350", plannedAt: 5000, notes: "" }), { ok: true });
  assert.deepEqual(book.run({ op: "add", dep: "LFPG", arr: "EDDF", aircraft: "", plannedAt: null, notes: "x" }), { ok: true });
  assert.deepEqual(book.list().map((l) => l.dep), ["EGLL", "LFPG"], "dated legs first, undated last");
  const id = book.list()[0]!.id;
  assert.deepEqual(book.run({ op: "update", id, dep: "EGLL", arr: "KBOS", aircraft: "A350", plannedAt: 5000, notes: "" }), { ok: true });
  assert.equal(book.list()[0]!.arr, "KBOS");
  assert.equal((book.run({ op: "add", dep: "EGLL", arr: "EGLL", aircraft: "", plannedAt: null, notes: "" }) as { error: string }).error, "Departure and arrival are the same airport.");
  assert.match((book.run({ op: "add", dep: "??", arr: "KJFK", aircraft: "", plannedAt: null, notes: "" }) as { error: string }).error, /airport code/);
  assert.deepEqual(book.run({ op: "delete", id }), { ok: true });
  assert.equal((book.run({ op: "delete", id }) as { error: string }).error, "That flight is already gone.");
  assert.equal(book.list().length, 1);
  assert.equal(notified, 4);
  db.close();
});
