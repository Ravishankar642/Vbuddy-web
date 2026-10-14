import { test } from "node:test";
import assert from "node:assert/strict";
import { PauseScheduler } from "./pause-scheduler.js";

function rig() {
  const st = { now: 1_000_000, alt: 35000, vs: 0, ground: false, tod: null as number | null, paused: false, pauses: 0 };
  const p = new PauseScheduler({
    now: () => st.now,
    flight: () => ({ altMsl: st.alt, vs: st.vs, onGround: st.ground }),
    todMin: () => st.tod,
    paused: () => st.paused,
    pause: () => void st.pauses++,
  });
  const run = (sec: number) => {
    for (let i = 0; i < sec * 2; i++) {
      st.now += 500;
      p.tick();
    }
  };
  return { st, p, run };
}

test("pause: at a time fires once at that time", () => {
  const { st, p, run } = rig();
  assert.equal(p.set({ mode: "atTime", atEpochMs: st.now - 1 }).ok, false, "a past time is refused");
  assert.equal(p.set({ mode: "atTime", atEpochMs: st.now + 10_000 }).ok, true);
  run(8);
  assert.equal(st.pauses, 0);
  run(4);
  assert.equal(st.pauses, 1);
  assert.equal(p.status(), null, "it clears itself");
  run(20);
  assert.equal(st.pauses, 1);
});

test("pause: before the top of descent waits for an established cruise, then for the lead time", () => {
  const { st, p, run } = rig();
  p.set({ mode: "beforeTod", leadSec: 300 });
  st.tod = 4; // inside the lead already, but cruise isn't established yet
  run(60);
  assert.equal(st.pauses, 0, "not until level for two minutes");
  st.tod = 9;
  run(70);
  assert.equal(st.pauses, 0, "9 minutes away is outside a 5 minute lead");
  assert.equal(p.status()!.waiting, "the top of descent");
  st.tod = 4.9;
  run(1);
  assert.equal(st.pauses, 1);
});

test("pause: with no estimate it fires when a steady descent from cruise begins", () => {
  const { st, p, run } = rig();
  p.set({ mode: "beforeTod", leadSec: 60 });
  run(130);
  assert.equal(p.status()!.waiting, "the start of the descent");
  st.vs = -1500;
  run(10);
  assert.equal(st.pauses, 0, "a blip isn't a descent");
  run(10);
  assert.equal(st.pauses, 1);
});

test("pause: never pauses a sim that is already paused, and ground resets the wait", () => {
  const { st, p, run } = rig();
  p.set({ mode: "atTime", atEpochMs: st.now + 2000 });
  st.paused = true;
  run(5);
  assert.equal(st.pauses, 0);
  p.set({ mode: "beforeTod", leadSec: 0 });
  st.tod = 0;
  run(60);
  st.ground = true;
  run(130);
  st.ground = false;
  run(60);
  assert.equal(st.pauses, 0);
});
