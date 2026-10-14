import { test } from "node:test";
import assert from "node:assert/strict";
import { TelemetryHub } from "./hub.js";
import { FakeSource, sampleTelemetry } from "./test-helpers.js";

function hubWith(capacityFrames: number) {
  const src = new FakeSource();
  // hz=1, minutes chosen so ring capacity == capacityFrames
  const hub = new TelemetryHub(src, 1, capacityFrames / 60);
  return { src, hub };
}

test("no frames until a sample arrives, then sequential seqs", () => {
  const { src, hub } = hubWith(60);
  assert.equal(hub.tick(), null);
  src.emit(sampleTelemetry());
  assert.equal(hub.tick()?.seq, 0);
  assert.equal(hub.tick()?.seq, 1);
  assert.equal(hub.latestSeq(), 1);
});

test("stale samples produce no frames", () => {
  const { src, hub } = hubWith(60);
  src.emit(sampleTelemetry(), Date.now() - 10_000);
  assert.equal(hub.tick(), null);
});

test("sim disconnect clears the latest sample", () => {
  const { src, hub } = hubWith(60);
  src.emit(sampleTelemetry());
  src.setStatus({ connected: false });
  assert.equal(hub.tick(), null);
});

test("resume replays exactly the missed frames", () => {
  const { src, hub } = hubWith(60);
  src.emit(sampleTelemetry());
  for (let i = 0; i < 10; i++) hub.tick();
  const r = hub.resume(hub.sessionId, 6);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.frames.map((f) => f.seq), [7, 8, 9]);
  assert.equal(hub.resume(hub.sessionId, 9).frames.length, 0);
});

test("resume reports a gap when frames fell out of the buffer", () => {
  const { src, hub } = hubWith(60);
  src.emit(sampleTelemetry());
  for (let i = 0; i < 100; i++) hub.tick(); // seqs 0..99, buffer keeps 40..99
  assert.equal(hub.oldestSeq(), 40);
  const r = hub.resume(hub.sessionId, 10);
  assert.equal(r.status, "gap");
  assert.equal(r.frames[0]?.seq, 40);
  assert.equal(r.frames.length, 60);
});

test("resume against another session says new-session", () => {
  const { hub } = hubWith(60);
  assert.equal(hub.resume("someone-else", 5).status, "new-session");
});

test("an aircraft that runs its own autopilot can switch the live 'autopilot on' flag", () => {
  const { src, hub } = hubWith(60);
  let own = false;
  hub.setApOverride(() => own);
  src.emit(sampleTelemetry({ ap: { master: false, altSel: 0, hdgSel: 0, spdSel: 0, vsSel: 0 } }));
  assert.equal(hub.tick()?.data.ap.master, false);
  own = true;
  src.emit(sampleTelemetry({ ap: { master: false, altSel: 0, hdgSel: 0, spdSel: 0, vsSel: 0 } }));
  assert.equal(hub.tick()?.data.ap.master, true);
  src.emit(sampleTelemetry({ ap: { master: true, altSel: 0, hdgSel: 0, spdSel: 0, vsSel: 0 } }));
  own = false;
  src.emit(sampleTelemetry({ ap: { master: true, altSel: 0, hdgSel: 0, spdSel: 0, vsSel: 0 } }));
  assert.equal(hub.tick()?.data.ap.master, true, "the simulator's own flag still counts");
});
