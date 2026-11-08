import { test } from "node:test";
import assert from "node:assert/strict";
import { checkGate, pathAngle, type Telemetry } from "@vbuddy/protocol";
import { ApproachMonitor } from "./approach.js";

const T = (agl: number, o: Partial<Telemetry> = {}): Telemetry => ({ altAgl: agl, onGround: false, vs: -750, gs: 140, ias: 140, bank: 2, gearDown: true, flapsIndex: 4, ...o } as Telemetry);

test("approach gates: a 3° path at 140 kt is stable; fast sink, gear up and a wobbling speed are not", () => {
  assert.ok(Math.abs(pathAngle(-743, 140)! - 3) < 0.05);
  assert.equal(checkGate(1000, 0, { gearDown: true, flapsIndex: 4, vs: -750, gs: 140, bank: 2, iasRecent: [138, 142] }).stable, true);
  const bad = checkGate(500, 0, { gearDown: false, flapsIndex: 1, vs: -1400, gs: 140, bank: 20, iasRecent: [130, 150] });
  assert.deepEqual(bad.checks.filter((c) => !c.ok).map((c) => c.key), ["gear", "flaps", "sink", "speed", "bank", "path"]);
});

test("approach monitor: one check per gate on the way down, again after a go-around, attached once to the landing", () => {
  const m = new ApproachMonitor();
  const seen: number[] = [];
  m.onGate((g) => seen.push(g.heightFt));
  let at = 0;
  for (const h of [1600, 1200, 1050, 990, 800, 600, 490, 300]) m.update(T(h), (at += 500));
  assert.deepEqual(seen, [1000, 500]);
  // Go around: climb above 1,500 ft, come down again.
  for (const h of [400, 900, 1600, 1100, 950]) m.update(T(h, { vs: h === 950 ? -700 : 1500 }), (at += 500));
  assert.deepEqual(seen, [1000, 500, 1000]);
  const gates = m.take(at);
  assert.deepEqual(gates.map((g) => g.heightFt), [1000, 500]);
  assert.equal(m.take(at).length, 0);
});
