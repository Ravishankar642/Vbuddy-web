import assert from "node:assert/strict";
import { test } from "node:test";
import type { Telemetry } from "@vbuddy/protocol";
import { EMPTY_EXTRAS } from "./source.js";
import { FlightGate, isPlaceholder, type GateEvent } from "./flight-gate.js";

const base: Telemetry = {
  lat: 12.99, lon: 80.17, altMsl: 52, altAgl: 0, groundElev: 52, pitch: 0, bank: 0, hdgTrue: 70, hdgMag: 70, track: 70,
  ias: 0, tas: 0, gs: 0, mach: 0, vs: 0, onGround: true, gForce: 1, gearDown: true, flapsIndex: 0, parkingBrake: true, simRate: 1,
  ap: { master: false, altSel: 0, hdgSel: 0, spdSel: 0, vsSel: 0 },
};
const at = (lat: number, lon: number, more: Partial<Telemetry> = {}): Telemetry => ({ ...base, lat, lon, ...more });

function rig() {
  const g = new FlightGate({ settleMs: 5_000, menuEndMs: 10_000 });
  const ev: GateEvent[] = [];
  g.on((e) => ev.push(e));
  let now = 1_000_000;
  /** Feeds `secs` seconds of 10 Hz samples from `t`, moving along `dLatPerS` degrees a second. */
  const run = (t: Telemetry, secs: number, dLatPerS = 0) => {
    for (let i = 0; i < secs * 10; i++) {
      now += 100;
      g.sample({ ...t, lat: t.lat + (dLatPerS * i) / 10 }, now);
    }
  };
  return { g, ev, run, kinds: () => ev.map((e) => (e.kind === "flying" ? `flying:${e.flying}` : e.kind === "end" ? `end:${e.reason}` : e.kind)), now: () => now };
}

test("the menu placeholder positions are not a flight", () => {
  assert.ok(isPlaceholder(-0.0, 90.0));
  assert.ok(isPlaceholder(0, 0));
  assert.ok(!isPlaceholder(12.99, 80.17));
  const r = rig();
  r.run(at(-0.0, 90.0), 30);
  assert.deepEqual(r.ev, []);
  assert.equal(r.g.inFlight(), false);
  assert.equal(r.g.why(), "menu");
});

test("a flight starts once the aircraft has settled at its spawn point", () => {
  const r = rig();
  r.run(at(0, 90), 3); // loading
  r.run(at(12.99, 80.17), 3); // spawned, still settling
  assert.equal(r.g.inFlight(), false);
  assert.equal(r.g.why(), "settling");
  r.run(at(12.99, 80.17), 3);
  assert.equal(r.g.inFlight(), true);
  assert.deepEqual(r.kinds(), ["start", "flying:true"]);
  const start = r.ev[0] as Extract<GateEvent, { kind: "start" }>;
  assert.equal(start.t.lat, 12.99);
});

test("the MSFS 2024 hangar (camera state) is not a flight even at a real airport", () => {
  const r = rig();
  r.g.extras({ ...EMPTY_EXTRAS, cameraState: 15 });
  r.run(at(47.52, -122.29), 20);
  assert.deepEqual(r.ev, []);
  r.g.extras({ ...EMPTY_EXTRAS, cameraState: 2 });
  r.run(at(12.99, 80.17), 10);
  assert.deepEqual(r.kinds(), ["start", "flying:true"]);
});

test("a replay pauses the flight without ending it, and its frozen position at speed is spotted without the camera", () => {
  const r = rig();
  r.run(at(12.99, 80.17), 10);
  r.run(at(13.0, 80.2, { gs: 150, onGround: false, altAgl: 3000 }), 10, 150 / 3600 / 60); // flying
  assert.equal(r.g.inFlight(), true);
  // replay: the speed says 132 kt but the position stays put
  r.run(at(12.9865, 80.1592, { gs: 132, onGround: false, altAgl: 140 }), 20);
  assert.equal(r.g.inFlight(), false);
  assert.equal(r.g.why(), "replay");
  assert.ok(!r.kinds().some((k) => k.startsWith("end")));
  // camera 17 = replay too
  r.g.extras({ ...EMPTY_EXTRAS, cameraState: 17 });
  r.run(at(13.0, 80.2), 5);
  assert.equal(r.g.why(), "replay");
});

test("a jump of more than 20 nm ends the flight and a new one starts after settling there", () => {
  const r = rig();
  r.run(at(12.99, 80.17), 10);
  r.run(at(25.26, 51.61), 10); // Doha
  assert.deepEqual(r.kinds(), ["start", "flying:true", "flying:false", "end:teleport", "start", "flying:true"]);
});

test("a small slew keeps the same flight", () => {
  const r = rig();
  r.run(at(12.99, 80.17), 10);
  r.run(at(13.05, 80.17), 10); // 3.6 nm
  assert.deepEqual(r.kinds(), ["start", "flying:true", "flying:false", "flying:true"]);
});

test("back in the menu for a while ends the flight; a new aircraft ends it at once", () => {
  const r = rig();
  r.run(at(12.99, 80.17), 10);
  r.run(at(0, 90), 12);
  assert.deepEqual(r.kinds(), ["start", "flying:true", "flying:false", "end:menu"]);
  const r2 = rig();
  r2.g.aircraft("FenixA320", r2.now());
  r2.run(at(12.99, 80.17), 10);
  r2.g.aircraft("A380", r2.now());
  assert.deepEqual(r2.kinds(), ["start", "flying:true", "flying:false", "end:aircraft"]);
});

test("the sim's Sim event saying it's in the menus is not flying", () => {
  const r = rig();
  r.g.extras({ ...EMPTY_EXTRAS, simRunning: 0 });
  r.run(at(12.99, 80.17), 10);
  assert.equal(r.g.inFlight(), false);
  r.g.extras({ ...EMPTY_EXTRAS, simRunning: 1 });
  r.run(at(12.99, 80.17), 10);
  assert.equal(r.g.inFlight(), true);
});
