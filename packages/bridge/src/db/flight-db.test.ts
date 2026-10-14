import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Landing, TelemetryFrame } from "@vbuddy/protocol";
import { TelemetryHub } from "../hub.js";
import { logger } from "../log.js";
import { LandingAnalyzer } from "../landing/analyzer.js";
import { flyLanding } from "../landing/test-flight.js";
import { FakeSource, sampleTelemetry } from "../test-helpers.js";
import { FlightDb } from "./flight-db.js";
import { importLandingsJsonl } from "./import-jsonl.js";
import { FlightRecorder } from "./recorder.js";

const log = logger("test");

const frame = (seq: number, ts = 1_000_000 + seq * 200, over = {}): TelemetryFrame => ({ seq, ts, data: sampleTelemetry({ lat: 10 + seq / 1000, lon: 20, altMsl: 1000 + seq, gs: 200 + (seq % 5), ...over }) });

async function mem() {
  const db = await FlightDb.open(":memory:", log);
  assert.ok(db);
  return db;
}

function makeLanding(t0 = 1_000_000): Landing {
  let n = 0;
  const an = new LandingAnalyzer(() => ({ aircraftTitle: "Test", source: "simconnect" }), () => `L${t0}-${++n}`);
  return flyLanding(an, { sink: 150, latch: "fresh" }, t0).landings[0]!;
}

test("frames round-trip, ranges and strides are exact, and old ones can be pruned", async () => {
  const db = await mem();
  db.insertFrames("s1", Array.from({ length: 100 }, (_, i) => frame(i)));
  db.insertFrames("s2", [frame(0)]);
  assert.deepEqual(db.frames("s1", 10, 14).map((f) => f.seq), [10, 11, 12, 13, 14]);
  assert.deepEqual(db.frames("s1", 10, 30, 5).map((f) => f.seq), [10, 15, 20, 25, 30], "stride counts from the first requested seq");
  assert.deepEqual(db.frames("s1", 3, 3)[0], frame(3), "round-trips exactly");
  assert.equal(db.frames("s2", 0, 99).length, 1, "sessions don't mix");
  assert.equal(db.pruneFrames(1_000_000 + 50 * 200), 51);
  assert.equal(db.frameCount(), 50);
  db.close();
});

test("recorder: batches frames, splits flights on aircraft change, long gaps and sim disconnect, and ties landings to the flight", async () => {
  const db = await mem();
  let title = "A320";
  const rec = new FlightRecorder(db, "sess", "mock", () => title, log, { flightGapMs: 60_000 });
  for (let i = 0; i < 10; i++) rec.onFrame(frame(i));
  assert.equal(db.frameCount(), 0, "nothing written until a flush");
  rec.flush();
  assert.equal(db.frameCount(), 10);
  const f1 = rec.currentFlightId()!;
  rec.saveLanding(makeLanding(1_000_000));

  rec.onFrame(frame(10, 1_000_000 + 10 * 200 + 120_000)); // 2 min of silence
  rec.flush();
  const f2 = rec.currentFlightId()!;
  assert.notEqual(f2, f1, "a long gap starts a new flight");

  title = "737";
  rec.onFrame(frame(11, 1_000_000 + 10 * 200 + 120_200));
  const f3 = rec.currentFlightId()!;
  assert.notEqual(f3, f2, "a different aircraft starts a new flight");

  rec.onStatus({ connected: false, source: "mock", paused: false, aircraftTitle: "" });
  rec.onFrame(frame(12, 1_000_000 + 10 * 200 + 120_400));
  const f4 = rec.currentFlightId()!;
  assert.notEqual(f4, f3, "sim disconnect ends the flight");
  rec.flush();

  const flights = db.flights();
  assert.deepEqual(flights.map((f) => f.id), [f4, f3, f2, f1], "newest first");
  const first = flights[3]!;
  assert.equal(first.frames, 10);
  assert.equal(first.firstSeq, 0);
  assert.equal(first.lastSeq, 9);
  assert.equal(first.landings, 1);
  assert.equal(first.aircraft, "A320");
  assert.equal(first.maxAltFt, 1009);
  assert.equal(flights[1]!.aircraft, "737");

  const track = db.track(f1, 5)!;
  assert.ok(track.length >= 2 && track.length <= 6, `thinned to ~5 points, got ${track.length}`);
  assert.equal(track[0]![1], 10, "lat of the first point");
  assert.equal(db.track(9999), null);
  rec.stop();
  db.close();
});

test("recorder keeps the live stream safe when the disk fails, then catches up", async () => {
  const db = await mem();
  const rec = new FlightRecorder(db, "sess", "mock", () => "X", log);
  rec.onFrame(frame(0));
  const real = db.insertFrames.bind(db);
  let broken = true;
  db.insertFrames = (sid, fr) => {
    if (broken) throw new Error("disk full");
    real(sid, fr);
  };
  for (let i = 1; i < 6; i++) rec.onFrame(frame(i));
  rec.flush(); // fails quietly
  rec.flush();
  assert.equal(db.frameCount(), 0);
  broken = false;
  rec.flush();
  assert.equal(db.frameCount(), 6, "nothing lost once the disk works again");
  db.close();
});

test("old landing JSONL is imported once, bad lines skipped, original kept as .imported", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbuddy-"));
  try {
    const file = join(dir, "landings.jsonl");
    const a = makeLanding(1_000_000);
    const b = makeLanding(5_000_000);
    await writeFile(file, [JSON.stringify(a), '{"id":"half","ts":', "garbage", JSON.stringify(b), JSON.stringify({ id: "x", ts: 1 })].join("\n") + "\n");
    const db = await mem();
    assert.equal(await importLandingsJsonl(file, db, log), 2);
    assert.equal(db.landingCount(), 2);
    assert.deepEqual((await readdir(dir)).sort(), ["landings.jsonl.imported"]);
    assert.equal(await importLandingsJsonl(file, db, log), 0, "nothing to do the second time");
    // putting the file back doesn't duplicate anything
    await writeFile(file, JSON.stringify(a) + "\n");
    assert.equal(await importLandingsJsonl(file, db, log), 0);
    assert.equal(db.landingCount(), 2);
    assert.equal(JSON.parse(db.recentLandingJson(10)[0]!).id, a.id);
    db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a damaged database file is moved aside and replaced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbuddy-"));
  try {
    const file = join(dir, "flights.db");
    await writeFile(file, "this is definitely not a sqlite database, just long enough to look like one".repeat(200));
    const db = await FlightDb.open(file, log);
    assert.ok(db, "opens a fresh database");
    db.insertFrames("s", [frame(0)]);
    assert.equal(db.frameCount(), 1);
    db.close();
    const files = await readdir(dir);
    const aside = files.find((f) => f.includes(".damaged-"));
    assert.ok(aside, `damaged file kept: ${files.join(",")}`);
    assert.ok((await readFile(join(dir, aside))).toString().startsWith("this is definitely"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("data survives closing and reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbuddy-"));
  try {
    const file = join(dir, "flights.db");
    const db = (await FlightDb.open(file, log))!;
    db.insertFrames("s", Array.from({ length: 20 }, (_, i) => frame(i)));
    db.close();
    const db2 = (await FlightDb.open(file, log))!;
    assert.equal(db2.frames("s", 0, 19).length, 20);
    db2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A hub with a small in-memory ring and the recorder as its archive. */
async function archivedHub(ringFrames: number, maxReplay?: number) {
  const src = new FakeSource();
  const hub = new TelemetryHub(src, 1, ringFrames / 60, maxReplay); // hz 1: ring holds ringFrames
  const db = await mem();
  const rec = new FlightRecorder(db, hub.sessionId, "mock", () => "T", log);
  hub.onFrame((f) => rec.onFrame(f));
  hub.setArchive(rec);
  src.emit(sampleTelemetry());
  return { hub, rec, db };
}

test("resume reaches back past the in-memory buffer by reading the flight log", async () => {
  const { hub, db } = await archivedHub(60);
  for (let i = 0; i < 200; i++) hub.tick(); // seqs 0..199, ring keeps 140..199
  assert.equal(hub.oldestSeq(), 140);
  const r = hub.resume(hub.sessionId, 9);
  assert.equal(r.status, "ok", "nothing is missing any more");
  assert.equal(r.stride, 1);
  assert.deepEqual(r.frames.map((f) => f.seq), Array.from({ length: 190 }, (_, i) => i + 10));
  assert.equal(r.fromDisk, 130);
  db.close();
});

test("a very long outage is thinned evenly, always ending on the newest frame", async () => {
  const { hub, db } = await archivedHub(60, 50);
  for (let i = 0; i < 400; i++) hub.tick(); // 0..399
  const r = hub.resume(hub.sessionId, -1);
  assert.equal(r.status, "ok");
  assert.equal(r.stride, 8, "ceil(400 / 50)");
  const seqs = r.frames.map((f) => f.seq);
  assert.equal(seqs[0], 0);
  assert.equal(seqs.at(-1), 399, "the newest frame is always included");
  assert.ok(seqs.length <= 51);
  for (let i = 1; i < seqs.length - 1; i++) assert.equal(seqs[i]! - seqs[i - 1]!, 8);
  db.close();
});

test("resume still reports a gap when the log has been pruned or is broken", async () => {
  const { hub, rec, db } = await archivedHub(60);
  for (let i = 0; i < 200; i++) hub.tick();
  rec.flush();
  rec.prune(0, Date.now() + 3_600_000); // everything on disk is now "old"
  const r = hub.resume(hub.sessionId, 9);
  assert.equal(r.status, "gap");
  assert.equal(r.frames[0]?.seq, 140, "falls back to what memory still has");
  hub.setArchive({
    range() {
      throw new Error("disk gone");
    },
  });
  assert.equal(hub.resume(hub.sessionId, 9).status, "gap", "a failing disk doesn't break the reconnect");
  db.close();
});
