import { test } from "node:test";
import assert from "node:assert/strict";
import { FlightAlerts } from "./engine.js";
import { PushService, withDefaults, type PushSender } from "../push/service.js";
import { EMPTY_EXTRAS, type SimExtras } from "../sim/source.js";
import { sampleTelemetry } from "../test-helpers.js";
import { logger } from "../log.js";
import type { AtcPosition, AtcStation } from "@vbuddy/protocol";

const ex = (o: Partial<SimExtras> = {}): SimExtras => ({ ...EMPTY_EXTRAS, engineCount: 2, eng1: 1, eng2: 1, stallWarning: 0, overspeedWarning: 0, fuelLbs: 20000, ...o });
const cruise = (o = {}) => sampleTelemetry({ altAgl: 30000, altMsl: 30000, vs: 0, gearDown: false, ...o });

test("alerts: stall warning needs to hold a moment, then fires once per minute", () => {
  const a = new FlightAlerts();
  let now = 0;
  assert.equal(a.update(cruise(), ex({ stallWarning: 1 }), now).length, 0);
  now += 500;
  assert.equal(a.update(cruise(), ex({ stallWarning: 1 }), now).length, 0, "a blip is ignored");
  now += 600;
  const r = a.update(cruise({ ias: 110 }), ex({ stallWarning: 1 }), now);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.kind, "stall");
  assert.match(r[0]!.text, /110 kt/);
  now += 5000;
  assert.equal(a.update(cruise(), ex({ stallWarning: 1 }), now).length, 0, "no repeat inside the cooldown");
  now += 61_000;
  assert.equal(a.update(cruise(), ex({ stallWarning: 1 }), now).length, 1, "but a warning that never stopped is worth repeating");
  // not on the ground
  const g = new FlightAlerts();
  g.update(cruise({ onGround: true }), ex({ stallWarning: 1 }), 0);
  assert.equal(g.update(cruise({ onGround: true }), ex({ stallWarning: 1 }), 5000).length, 0);
});

test("alerts: an engine that stops in flight is reported; shutting down on the ground is not", () => {
  const a = new FlightAlerts();
  let now = 0;
  for (; now < 20_000; now += 1000) assert.equal(a.update(cruise(), ex(), now).length, 0);
  assert.equal(a.update(cruise(), ex({ eng2: 0 }), now).length, 0);
  now += 3500;
  const r = a.update(cruise(), ex({ eng2: 0 }), now);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.title, "Engine 2 stopped");
  now += 1000;
  assert.equal(a.update(cruise(), ex({ eng2: 0 }), now).length, 0, "reported once");
  // both gone
  now += 1000;
  a.update(cruise(), ex({ eng1: 0, eng2: 0 }), now);
  now += 3500;
  const all = a.update(cruise(), ex({ eng1: 0, eng2: 0 }), now);
  assert.equal(all[0]?.title, "All engines stopped");
  // taxi-in shutdown
  const g = new FlightAlerts();
  for (let t = 0; t < 20_000; t += 1000) g.update(cruise({ onGround: true }), ex(), t);
  for (let t = 20_000; t < 30_000; t += 1000) assert.equal(g.update(cruise({ onGround: true }), ex({ eng1: 0, eng2: 0 }), t).length, 0);
  // a sim that doesn't report engines never alerts
  const n = new FlightAlerts();
  for (let t = 0; t < 30_000; t += 1000) assert.equal(n.update(cruise(), { ...EMPTY_EXTRAS }, t).length, 0);
});

test("alerts: gear up low and high sink rate once per approach, re-armed by a climb", () => {
  const a = new FlightAlerts();
  const low = (o = {}) => sampleTelemetry({ onGround: false, altAgl: 600, vs: -2400, gearDown: false, ...o });
  const r = a.update(low(), ex(), 0);
  assert.deepEqual(r.map((x) => x.kind).sort(), ["gear", "sink"]);
  assert.equal(a.update(low(), ex(), 1000).length, 0);
  // gear down: no gear alert; slow descent: no sink alert
  const ok = new FlightAlerts();
  assert.equal(ok.update(low({ gearDown: true, vs: -700 }), ex(), 0).length, 0);
  // climbs away, comes back (after the cooldown)
  a.update(sampleTelemetry({ altAgl: 3000, vs: 500 }), ex(), 2000);
  assert.equal(a.update(low(), ex(), 70_000).length, 2);
});

test("alerts: fuel endurance comes from the burn over the last minutes, in sim time", () => {
  const a = new FlightAlerts();
  // 100 lb per minute, 5000 lb left at the end -> 50 minutes
  for (let m = 0; m <= 3; m++) a.update(cruise(), ex({ fuelLbs: 5300 - m * 100 }), m * 60_000);
  assert.ok(Math.abs(a.enduranceMin! - 50) < 0.5, String(a.enduranceMin));
  const fast = new FlightAlerts();
  for (let m = 0; m <= 3; m++) fast.update(cruise({ simRate: 2 }), ex({ fuelLbs: 5300 - m * 100 }), m * 60_000);
  assert.ok(Math.abs(fast.enduranceMin! - 100) < 1, "twice the sim time for the same real burn");
  const idle = new FlightAlerts();
  for (let m = 0; m <= 3; m++) idle.update(cruise(), ex({ fuelLbs: 5000 }), m * 60_000);
  assert.equal(idle.enduranceMin, null, "not burning: no estimate");
  const early = new FlightAlerts();
  early.update(cruise(), ex(), 0);
  assert.equal(early.enduranceMin, null);
});

const sub = { endpoint: "https://push.example/", keys: { p256dh: "a", auth: "b" } };
function rig() {
  const sent: Array<{ endpoint: string; p: { title: string; body: string; kind: string } }> = [];
  const sender: PushSender = async (s, payload) => {
    sent.push({ endpoint: s.endpoint, p: JSON.parse(payload) });
    return { statusCode: 201 };
  };
  const svc = new PushService(null, null, "mailto:t@example.com", logger("test"), sender);
  const add = (id: string, prefs: object = {}) => svc.subscribe(id, { ...sub, endpoint: sub.endpoint + id }, prefs);
  return { svc, sent, add };
}
const station = (callsign: string): AtcStation => ({ callsign, name: callsign, freq: "127.900" }) as unknown as AtcStation;
const ahead = (distNm: number, cs = "VABB_APP", etaSec = 300): AtcPosition => ({ current: null, ahead: { station: station(cs), etaSec, distNm } });

test("push: older saved choices get the new defaults", () => {
  const p = withDefaults({ atc: false, landing: true, chat: true } as never);
  assert.deepEqual(p, { atc: false, landing: true, chat: true, vatsim: true, alerts: true, todMin: 10, fuelMin: 30, atcAheadNm: 40, atcPerHour: 0, apOff: false, takeoff: true, toc: true, tenK: false, approachMin: 0, gate: true, simLost: true, planLoaded: true, paused: true });
  assert.equal(withDefaults({ fuelMin: 9999 } as never).fuelMin, 30, "out-of-range falls back");
});

test("push: each device hears about a boundary at its own distance, once", async () => {
  const { svc, sent, add } = rig();
  add("near", { atcAheadNm: 10 });
  add("far", { atcAheadNm: 80 });
  add("off", { atcAheadNm: 80, atc: false });
  await svc.notifyAtcAhead(ahead(60), 0);
  assert.deepEqual(sent.map((s) => s.endpoint.split("/").pop()), ["far"]);
  await svc.notifyAtcAhead(ahead(8), 1000);
  assert.deepEqual(sent.map((s) => s.endpoint.split("/").pop()), ["far", "near"], "far isn't told again for the same boundary");
  await svc.notifyAtcAhead(ahead(7), 2000);
  assert.equal(sent.length, 2);
  await svc.notifyAtcAhead(ahead(5, "VABB_CTR"), 3000);
  assert.equal(sent.length, 4, "a different boundary is announced");
  await svc.notifyAtc({ id: "1", kind: "ahead", station: station("X"), text: "x" });
  assert.equal(sent.length, 4, "the generic ahead alert is not pushed twice");
});

test("push: the hourly limit caps boundary and no-coverage notices but never 'contact'", async () => {
  const { svc, sent, add } = rig();
  add("a", { atcPerHour: 2, atcAheadNm: 100 });
  await svc.notifyAtcAhead(ahead(50, "S1"), 0);
  await svc.notifyAtcAhead(ahead(50, "S2"), 1000);
  await svc.notifyAtcAhead(ahead(50, "S3"), 2000);
  assert.equal(sent.length, 2);
  await svc.notifyAtc({ id: "u", kind: "unicom", station: null, text: "No ATC" }, 3000);
  assert.equal(sent.length, 2, "over the limit");
  await svc.notifyAtc({ id: "c", kind: "contact", station: station("S9"), text: "Contact S9" }, 4000);
  assert.equal(sent.length, 3, "contact always goes out");
  await svc.notifyAtcAhead(ahead(50, "S4"), 3_700_000);
  assert.equal(sent.length, 4, "an hour later the allowance is back");
});

test("push: fuel warning uses each device's own limit and re-arms after a refuel", async () => {
  const { svc, sent, add } = rig();
  add("early", { fuelMin: 60 });
  add("late", { fuelMin: 20 });
  add("none", { fuelMin: 0 });
  add("muted", { fuelMin: 60, alerts: false });
  await svc.notifyFuel(70, "");
  assert.equal(sent.length, 0);
  await svc.notifyFuel(55, "4,000 kg");
  assert.deepEqual(sent.map((s) => s.endpoint.split("/").pop()), ["early"]);
  assert.match(sent[0]!.p.body, /55 min/);
  await svc.notifyFuel(50, "");
  assert.equal(sent.length, 1, "no repeat");
  await svc.notifyFuel(15, "");
  assert.deepEqual(sent.map((s) => s.endpoint.split("/").pop()), ["early", "late"]);
  await svc.notifyFuel(90, ""); // refuelled
  await svc.notifyFuel(30, "");
  assert.equal(sent.length, 3, "early again");
  assert.equal(await svc.notifyFuel(null, ""), 0);
});

test("push: VATSIM connect and disconnect, and the aircraft-alerts switch", async () => {
  const { svc, sent, add } = rig();
  add("on");
  add("off", { vatsim: false, alerts: false });
  await svc.notifyVatsim(true, "QTR1", true);
  await svc.notifyVatsim(false, null, true);
  await svc.notifyVatsim(false, null, false);
  assert.deepEqual(sent.map((s) => s.p.title), ["VATSIM connected", "VATSIM disconnected", "VATSIM disconnected"]);
  assert.match(sent[0]!.p.body, /QTR1/);
  assert.match(sent[2]!.p.body, /vPilot closed/);
  assert.ok(sent.every((s) => s.endpoint.endsWith("/on")));
  await svc.notifyAlert({ id: "1", kind: "stall", severity: "warning", title: "Stall warning", text: "x" });
  assert.equal(sent.length, 4);
});

const ap = (master: boolean, o = {}) => cruise({ ap: { master, altSel: 0, hdgSel: 0, spdSel: 0, vsSel: 0 }, ...o });

test("alerts: autopilot dropping out in the cruise is reported; a quick blip, the approach and the ground are not", () => {
  const a = new FlightAlerts();
  let now = 0;
  for (; now < 40_000; now += 1000) a.update(ap(true), ex(), now);
  assert.equal(a.update(ap(false), ex(), now).length, 0, "waits to be sure");
  now += 2500;
  const r = a.update(ap(false), ex(), now);
  assert.equal(r.length, 1);
  assert.equal(r[0]!.kind, "autopilot");
  now += 5000;
  assert.equal(a.update(ap(false), ex(), now).length, 0, "once");
  // on only briefly, then off: not a disconnect
  const b = new FlightAlerts();
  for (let t = 0; t < 10_000; t += 1000) b.update(ap(true), ex(), t);
  for (let t = 10_000; t < 20_000; t += 1000) assert.equal(b.update(ap(false), ex(), t).length, 0);
  // approach: below 3,000 ft above ground
  const c = new FlightAlerts();
  for (let t = 0; t < 40_000; t += 1000) c.update(ap(true, { altAgl: 2000 }), ex(), t);
  for (let t = 40_000; t < 50_000; t += 1000) assert.equal(c.update(ap(false, { altAgl: 2000 }), ex(), t).length, 0);
  // a blip of one second does not count
  const d = new FlightAlerts();
  for (let t = 0; t < 40_000; t += 1000) d.update(ap(true), ex(), t);
  assert.equal(d.update(ap(false), ex(), 40_000).length, 0);
  assert.equal(d.update(ap(true), ex(), 41_000).length, 0);
  for (let t = 42_000; t < 50_000; t += 1000) assert.equal(d.update(ap(true), ex(), t).length, 0);
});

test("push: the autopilot alert goes only to devices that chose it", async () => {
  const { svc, sent, add } = rig();
  add("on", { apOff: true });
  add("default", {});
  add("alertsOnly", { alerts: true });
  await svc.notifyAlert({ id: "1", kind: "autopilot", severity: "caution", title: "Autopilot off", text: "x" });
  assert.deepEqual(sent.map((s) => s.endpoint.split("/").pop()), ["on"]);
  await svc.notifyAlert({ id: "2", kind: "stall", severity: "warning", title: "Stall warning", text: "x" });
  assert.equal(sent.length, 4, "the other alerts still go to everyone with alerts on");
});

test("alerts: top of descent from the plan's TOD fix, in minutes at the current ground speed", () => {
  const a = new FlightAlerts();
  a.setTodPlan({ kind: "fix", lat: 10, lon: 0 });
  // 1 degree of latitude = 60 nm; at 360 kt that is 10 minutes per 60 nm
  a.update(cruise({ lat: 9, lon: 0, gs: 360 }), ex(), 0);
  assert.equal(Math.round(a.todNm!), 60);
  assert.equal(Math.round(a.todMinAway!), 10);
  // descending already, or on the ground, or too low: no estimate
  a.update(cruise({ lat: 9, lon: 0, gs: 360, vs: -1500 }), ex(), 1000);
  assert.equal(a.todMinAway, null);
  a.update(cruise({ lat: 9, lon: 0, gs: 360, altMsl: 5000 }), ex(), 2000);
  assert.equal(a.todMinAway, null);
  // once it is reached it is over for this flight
  a.update(cruise({ lat: 9.99, lon: 0, gs: 360 }), ex(), 3000);
  assert.equal(a.todMinAway, null);
  a.update(cruise({ lat: 9, lon: 0, gs: 360 }), ex(), 4000);
  assert.equal(a.todMinAway, null, "a passed TOD is not announced again");
});

test("alerts: with no TOD fix, the descent point is 3 nm per 1,000 ft before the destination", () => {
  const a = new FlightAlerts();
  a.setTodPlan({ kind: "dest", lat: 10, lon: 0, elevFt: 0 });
  // 30,000 ft = 90 nm before the destination; the aircraft is 150 nm out
  a.update(cruise({ lat: 7.5, lon: 0, gs: 450 }), ex(), 0);
  assert.equal(Math.round(a.todNm!), 60);
  assert.equal(Math.round(a.todMinAway!), 8);
  a.update(cruise({ lat: 7.5, lon: 0, gs: 450, vs: 800 }), ex(), 1000);
  assert.equal(a.todMinAway, null, "not judged while climbing");
});

test("push: top of descent goes once per device at its own lead time, never when joining near it", async () => {
  const { svc, sent, add } = rig();
  add("ten", { todMin: 10 });
  add("off", { todMin: 0 });
  add("twenty", { todMin: 20 });
  await svc.notifyTod(30, 150);
  assert.equal(sent.length, 0);
  await svc.notifyTod(18, 90);
  assert.deepEqual(sent.map((s) => s.endpoint.split("/").pop()), ["twenty"]);
  await svc.notifyTod(15, 75);
  assert.equal(sent.length, 1, "not again for the same device");
  await svc.notifyTod(9, 45);
  assert.deepEqual(sent.map((s) => s.endpoint.split("/").pop()), ["twenty", "ten"]);
  assert.equal((await svc.notifyTod(null, null)), 0);
  // a device that first sees the point already inside its lead time stays quiet
  add("late", { todMin: 15 });
  await svc.notifyTod(8, 40);
  assert.equal(sent.length, 2);
});
