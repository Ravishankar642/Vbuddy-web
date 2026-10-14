import assert from "node:assert/strict";
import { test } from "node:test";
import { logger } from "../log.js";
import { MockPanel } from "./mock-panel.js";
import { PanelService } from "./service.js";

const make = () => {
  const b = new MockPanel();
  let t = 1000;
  const svc = new PanelService(b, logger("test"), () => t);
  return { b, svc, tick: (ms: number) => (t += ms) };
};

test("lights switch and report back", async () => {
  const { b, svc } = make();
  assert.equal((await svc.run({ op: "light", id: "landing", on: true })).ok, true);
  assert.equal(b.state()!.lights.landing, true);
  assert.equal((await svc.run({ op: "light", id: "landing", on: false })).ok, true);
  assert.equal(b.state()!.lights.landing, false);
});

test("a light the aircraft ignores gives an error", async () => {
  const { b, svc } = make();
  b.ignore.add("taxi");
  const r = await svc.run({ op: "light", id: "taxi", on: true });
  assert.equal(r.ok, false);
});

test("buttons toggle like the real ones", async () => {
  const { b, svc } = make();
  await svc.run({ op: "press", ctl: "cmd" });
  assert.equal(b.state()!.ap!.master, true);
  await svc.run({ op: "press", ctl: "cmd" });
  assert.equal(b.state()!.ap!.master, false);
});

test("knobs turn by detents and wrap", async () => {
  const { b, svc, tick } = make();
  await svc.run({ op: "turn", ctl: "hdg", steps: 3 });
  assert.equal(b.state()!.ap!.hdg, 93);
  tick(5000);
  await svc.run({ op: "turn", ctl: "hdg", steps: -100 });
  assert.equal(b.state()!.ap!.hdg, 353);
  await svc.run({ op: "turn", ctl: "alt", steps: 5 });
  assert.equal(b.state()!.ap!.alt, 10500);
  tick(5000);
  await svc.run({ op: "turn", ctl: "vs", steps: -15 });
  assert.equal(b.state()!.ap!.vsFpm, -1500);
  tick(5000);
  await svc.run({ op: "turn", ctl: "spd", steps: -10 });
  assert.equal(b.state()!.ap!.spd, 240);
});

test("quick turns build on the value just asked for, not on a stale reading", async () => {
  const { b, svc } = make();
  // Pretend the simulator is slow to report: state stays at 90 while three turns arrive.
  const slow = b.state();
  b.state = () => slow;
  const set = b.set.bind(b);
  b.set = async () => ({ ok: true });
  void set;
  await svc.run({ op: "turn", ctl: "hdg", steps: 1 });
  const asked: number[] = [];
  b.set = async (_c, v) => (asked.push(v), { ok: true });
  await svc.run({ op: "turn", ctl: "hdg", steps: 1 });
  await svc.run({ op: "turn", ctl: "hdg", steps: 1 });
  assert.deepEqual(asked, [92, 93]);
});

test("no aircraft means no commands", async () => {
  const svc = new PanelService(null, logger("test"));
  assert.equal((await svc.run({ op: "press", ctl: "cmd" })).ok, false);
  assert.equal(svc.state().aircraft, "");
});

test("extra controls: absolute flaps stay within the detents, doors toggle, slew and the wing leveler switch, camera moves are accepted", async () => {
  const { MockPanel } = await import("./mock-panel.js");
  const m = new MockPanel("fenix");
  await m.sys("flapsSet", 3);
  assert.equal(m.state()!.sys!.flapsIndex, 3);
  await m.sys("flapsSet", 99);
  assert.equal(m.state()!.sys!.flapsIndex, m.state()!.sys!.flapsCount, "clamped to the last detent");
  await m.sys("flapsSet", 0);
  assert.equal(m.state()!.sys!.flapsIndex, 0);
  await m.sys("doorToggle", 2);
  assert.deepEqual(m.state()!.sys!.doors, [0, 100, 0, 0]);
  await m.sys("doorToggle", 2);
  assert.equal(m.state()!.sys!.doors![1], 0);
  await m.sys("slew", 1);
  await m.sys("wingLeveler", 1);
  assert.deepEqual([m.state()!.sys!.slew, m.state()!.sys!.wingLeveler], [true, true]);
  assert.deepEqual(await m.sys("panLeft", 3), { ok: true });
  assert.ok((await import("@vbuddy/protocol")).SYS_IDS.includes("viewReset"));
});
