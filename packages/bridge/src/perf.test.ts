import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Telemetry } from "@vbuddy/protocol";
import { compactTelemetry } from "./hub.js";
import { frameSkip, inLandingWindow, PerfService } from "./perf.js";
import { audioCtx } from "./voice/whisper.js";
import { FlightDb } from "./db/flight-db.js";
import { logger } from "./log.js";

const T: Telemetry = {
  lat: 12.987615040109825, lon: 80.1662671865689, altMsl: 55.10615507853849, altAgl: 8.891754801234129, groundElev: 46.214400277304364,
  pitch: -0.6615262432295808, bank: -0.026493790895216304, hdgTrue: 215.6639899374129, hdgMag: 216.79595206591728, track: 215.66635927920026,
  ias: 17.740922927856445, tas: 17.717578887939453, gs: 13.602771853557181, mach: 0.02586202509701252, vs: 14.864940941333742, onGround: true,
  gForce: 1.328678980577482, gearDown: true, flapsIndex: 5, parkingBrake: false, simRate: 1, ap: { master: false, altSel: 0, hdgSel: 0, spdSel: 0, vsSel: 0 },
};

test("telemetry frames carry rounded numbers: about half the size, still exact to 10 cm", () => {
  const c = compactTelemetry(T);
  assert.ok(JSON.stringify(c).length < JSON.stringify(T).length * 0.7, `${JSON.stringify(c).length} vs ${JSON.stringify(T).length}`);
  assert.ok(Math.abs(c.lat - T.lat) < 1e-6 && Math.abs(c.lon - T.lon) < 1e-6);
  assert.equal(c.onGround, true);
  assert.equal(c.flapsIndex, 5);
});

test("the landing window: low and descending, or rolling fast, with a margin either way", () => {
  assert.equal(inLandingWindow({ onGround: false, altAgl: 35000, gs: 450 }, false), false); // cruise
  assert.equal(inLandingWindow({ onGround: false, altAgl: 800, gs: 150 }, false), true); // short final
  assert.equal(inLandingWindow({ onGround: false, altAgl: 1200, gs: 160 }, true), true); // still in, inside the margin
  assert.equal(inLandingWindow({ onGround: false, altAgl: 1200, gs: 160 }, false), false);
  assert.equal(inLandingWindow({ onGround: true, altAgl: 0, gs: 130 }, false), true); // rollout
  assert.equal(inLandingWindow({ onGround: true, altAgl: 0, gs: 12 }, true), false); // taxi
});

test("how many sim frames are skipped: half in the landing, a quarter in cruise, an eighth when lite or nobody looks", () => {
  assert.equal(frameSkip({ lite: false, background: false, landing: true }), 1);
  assert.equal(frameSkip({ lite: true, background: false, landing: true }), 2);
  assert.equal(frameSkip({ lite: false, background: false, landing: false }), 3);
  assert.equal(frameSkip({ lite: false, background: true, landing: false }), 7);
  assert.equal(frameSkip({ lite: true, background: false, landing: false }), 7);
});

test("nobody looking: no app on screen and the VBuddy window closed or minimised; lite mode is kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-perf-"));
  const p = new PerfService(join(dir, "performance.json"), logger("test"));
  const seen: boolean[] = [];
  p.onChange((s, was) => s.background !== was.background && seen.push(s.background));
  p.setAppScreens(0);
  assert.equal(p.state().background, true);
  p.consoleSeen(true);
  assert.equal(p.state().background, false);
  p.consoleSeen(false); // minimised
  assert.equal(p.state().background, true);
  p.setAppScreens(1);
  assert.equal(p.state().background, false);
  p.setLite(true);
  p.stop();
  const again = new PerfService(join(dir, "performance.json"), logger("test"));
  assert.equal(again.state().lite, true);
  again.stop();
  assert.deepEqual(seen, [true, false, true, false]);
});

test("the speech engine looks at a window that fits the call, never under ~15 s", () => {
  assert.equal(audioCtx(3), 768);
  assert.equal(audioCtx(20), 1088);
  assert.equal(audioCtx(40), 1500);
});

test("the flight log gives back space left by old telemetry and trims its write-ahead log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vb-maint-"));
  const file = join(dir, "flights.db");
  const db = (await FlightDb.open(file, logger("test")))!;
  const frames = Array.from({ length: 40_000 }, (_, i) => ({ seq: i, ts: i, data: T }));
  for (let i = 0; i < frames.length; i += 5000) db.insertFrames("s", frames.slice(i, i + 5000));
  db.pruneFrames(39_000);
  const before = statSync(file).size;
  const m = db.maintain();
  assert.equal(m.vacuumed, true);
  assert.ok(statSync(file).size < before / 2, `${statSync(file).size} vs ${before}`);
  assert.equal(statSync(file + "-wal").size, 0);
  assert.equal(db.frameCount(), 1000);
  db.close();
});
