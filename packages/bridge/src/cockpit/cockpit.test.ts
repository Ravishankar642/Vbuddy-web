import { test } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../log.js";
import { Pairing, isLocalAddress } from "../control/pairing.js";
import { CockpitDriver } from "./driver.js";
import { MockCockpit } from "./mock-cockpit.js";
import type { CockpitBackend, ControlPath } from "./backend.js";
import { toFcuState, emptyValues } from "./fenix-vars.js";

const log = logger("test");
const fast = { clickMs: 2, verifyMs: 150 };

test("pairing: one-time code, token works, wrong codes are limited, revoke", () => {
  let now = 1_000_000;
  const p = new Pairing(null, log, () => now);
  const { code } = p.current();
  assert.match(code, /^\d{6}$/);
  const wrong = code === "000000" ? "111111" : "000000";
  assert.equal(p.pair(wrong, "Tab", "10.0.0.5").ok, false);
  const r = p.pair(code, "Tablet", "10.0.0.5");
  assert.ok(r.ok);
  assert.notEqual(p.current().code, code, "a code works for one device only");
  assert.equal(p.pair(code, "Other", "10.0.0.6").ok, false, "old code is dead");
  assert.equal(p.verify(r.token)?.name, "Tablet");
  assert.equal(p.verify("forged"), null);
  assert.equal(p.verify(undefined), null);

  for (let i = 0; i < 5; i++) p.pair(wrong === p.current().code ? "222222" : wrong, "x", "10.0.0.9");
  const locked = p.pair(p.current().code, "x", "10.0.0.9");
  assert.ok(!locked.ok && /Too many/.test(locked.error), "locked after 5 wrong codes, even with the right one");
  now += 61_000;
  assert.ok(p.pair(p.current().code, "x", "10.0.0.9").ok, "unlocked after a minute");

  now += 11 * 60_000;
  const before = p.current().code;
  assert.ok(p.current().expiresAt > now, "expired code replaced");
  void before;

  assert.equal(p.revoke(r.device.id), true);
  assert.equal(p.verify(r.token), null, "revoked token stops working");
  assert.ok(isLocalAddress("127.0.0.1") && isLocalAddress("::1") && isLocalAddress("::ffff:127.0.0.1"));
  assert.ok(!isLocalAddress("192.168.1.20"));
});

test("driver: turns, push/pull and buttons change the mock FCU and are confirmed", async () => {
  const m = new MockCockpit(5);
  const d = new CockpitDriver(m, log, fast);
  assert.deepEqual(await d.run({ op: "turn", ctl: "hdg", clicks: 5 }), { ok: true });
  assert.equal(d.state()!.hdg, 275);
  await d.run({ op: "turn", ctl: "hdg", clicks: -10 });
  assert.equal(d.state()!.hdg, 265);
  assert.equal(m.values().E_FCU_HEADING, -5, "the counter is what was really sent");

  assert.ok((await d.run({ op: "push", ctl: "spd" })).ok);
  assert.equal(d.state()!.spdManaged, true);
  assert.equal(m.values().S_FCU_SPEED, 2, "push = -1");
  await d.run({ op: "pull", ctl: "spd" });
  assert.equal(d.state()!.spdManaged, false);

  assert.ok((await d.run({ op: "press", ctl: "ap1" })).ok);
  assert.equal(d.state()!.lights.ap1, true);
  assert.equal(m.values().S_FCU_AP1, 2, "press + release");
  await d.run({ op: "press", ctl: "ap1" });
  assert.equal(d.state()!.lights.ap1, false);

  assert.ok((await d.run({ op: "ndMode", efis: 1, value: 3 })).ok);
  assert.equal(d.state()!.efis1.ndMode, 3);
  assert.deepEqual(d.link(), { path: "mock", working: true });
});

test("driver: dial an exact value (wraps heading the short way, big altitude changes use the 1000 ft setting)", async () => {
  const m = new MockCockpit(3);
  const d = new CockpitDriver(m, log, fast);
  assert.deepEqual(await d.run({ op: "target", ctl: "hdg", value: 10 }), { ok: true });
  assert.equal(d.state()!.hdg, 10);
  assert.ok(Math.abs(m.values().E_FCU_HEADING) < 120, "270 -> 010 goes right, through north (100 clicks), not 260 left");

  assert.deepEqual(await d.run({ op: "target", ctl: "alt", value: 37000 }), { ok: true });
  assert.equal(d.state()!.alt, 37000);
  assert.ok(Math.abs(m.values().E_FCU_ALTITUDE) < 60, `used the 1000 ft setting (${m.values().E_FCU_ALTITUDE} clicks)`);
  assert.equal(m.values().S_FCU_ALTITUDE_SCALE, 0, "the 100/1000 switch is put back");

  assert.deepEqual(await d.run({ op: "target", ctl: "vs", value: -1500 }), { ok: true });
  assert.equal(d.state()!.vs, -1500);
  assert.deepEqual(await d.run({ op: "target", ctl: "spd", value: 180 }), { ok: true });
  assert.equal(d.state()!.spd, 180);

  await d.run({ op: "press", ctl: "spdMach" });
  const r = await d.run({ op: "target", ctl: "spd", value: 250 });
  assert.ok(!r.ok && /Mach/.test(r.error), "knots entered while the FCU shows Mach");
  assert.deepEqual(await d.run({ op: "target", ctl: "spd", value: 0.8 }), { ok: true });
  assert.equal(d.state()!.spd, 0.8);
});

/** A backend that ignores writes on some paths, to test switching. */
class PickyBackend implements CockpitBackend {
  readonly aircraft = "fenix-a320" as const;
  inner = new MockCockpit(2);
  paths: ControlPath[] = ["mobiflight", "simconnect"];
  idx = 0;
  works: ControlPath[] = [];
  values() {
    return this.inner.values();
  }
  onValues(cb: () => void) {
    this.inner.onValues(cb);
  }
  add(v: Parameters<CockpitBackend["add"]>[0], d: number) {
    return this.works.includes(this.path()) ? this.inner.add(v, d) : true;
  }
  set(v: Parameters<CockpitBackend["set"]>[0], x: number) {
    return this.works.includes(this.path()) ? this.inner.set(v, x) : true;
  }
  path() {
    return this.paths[this.idx] ?? "none";
  }
  nextPath() {
    this.idx++;
    return this.idx < this.paths.length;
  }
  resetPath() {
    this.idx = 0;
  }
  paused() {
    return false;
  }
}

test("driver: when MobiFlight doesn't answer, tries SimConnect; when nothing does, says so", async () => {
  const b = new PickyBackend();
  b.works = ["simconnect"];
  const d = new CockpitDriver(b, log, fast);
  assert.equal((await d.run({ op: "turn", ctl: "hdg", clicks: 1 })).ok, false);
  assert.equal(d.link().path, "mobiflight");
  assert.equal((await d.run({ op: "turn", ctl: "hdg", clicks: 1 })).ok, false);
  assert.equal(d.link().path, "simconnect", "switched after two silent commands");
  assert.equal((await d.run({ op: "turn", ctl: "hdg", clicks: 1 })).ok, true);
  assert.equal(d.link().working, true);

  const none = new PickyBackend();
  const d2 = new CockpitDriver(none, log, fast);
  for (let i = 0; i < 4; i++) await d2.run({ op: "press", ctl: "ap1" });
  assert.equal(d2.link().working, false);
  assert.match(d2.link().detail ?? "", /MobiFlight WASM/);
  none.works = ["mobiflight"];
  d2.reset();
  assert.equal(d2.link().path, "mobiflight");
  assert.equal((await d2.run({ op: "press", ctl: "ap1" })).ok, true, "Retry starts over");
});

test("no aircraft: commands are refused politely", async () => {
  const b = new MockCockpit(1);
  (b as unknown as { values: () => null }).values = () => null;
  const d = new CockpitDriver(b, log, fast);
  assert.deepEqual(await d.run({ op: "press", ctl: "ap1" }), { ok: false, error: "No Fenix A320 is loaded." });
  assert.equal(d.state(), null);
});

test("FCU state: Mach shown when the speed window holds a Mach number", () => {
  const v = emptyValues();
  v.N_FCU_SPEED = 0.78;
  v.B_FCU_POWER = 1;
  assert.equal(toFcuState(v, null).spdIsMach, true);
  v.N_FCU_SPEED = 250;
  assert.equal(toFcuState(v, 100).spdIsMach, false);
});
