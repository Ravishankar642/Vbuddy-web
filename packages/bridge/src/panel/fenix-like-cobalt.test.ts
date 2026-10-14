import { test } from "node:test";
import assert from "node:assert/strict";
import { addonOf, comFrequencyMatches, rmpChannelIndex, rmpTuneClicks, STUDY_NOTE } from "./addons.js";
import { LVarChannel } from "../sim/lvars.js";
import { FakeHandle, fakeSim } from "../sim/fake-handle.js";
import { SimPanel } from "./sim-panel.js";
import { SimRadios } from "../comms/sim-radios.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("aircraft are sorted the way Cobalt sorts them", () => {
  assert.equal(addonOf("FenixA320 Easyjet G-EZOA"), "fenix");
  assert.equal(addonOf("FNX320 British Airways"), "fenix");
  assert.equal(addonOf("FlyByWire A320neo (LEAP)"), "fbw");
  assert.equal(addonOf("PMDG 737-800 BW SC"), "pmdg737");
  assert.equal(addonOf("Airbus A320neo Asobo"), "none", "the default A320neo follows the standard events");
  assert.equal(addonOf("iniBuilds A320neo V2"), "none", "iniBuilds' default A320neo for Asobo too");
  assert.equal(addonOf("iFly 737 MAX 8"), "ifly");
  assert.equal(addonOf("iniBuilds A300-600R"), "study");
  assert.equal(addonOf("ToLiss A321"), "study");
  assert.equal(addonOf("Cessna 172"), "none");
});

test("Fenix radio panel arithmetic matches Cobalt", () => {
  assert.equal(rmpChannelIndex(118.0), 0);
  assert.equal(rmpChannelIndex(121.025), 4);
  assert.equal(rmpChannelIndex(121.805), 129);
  assert.deepEqual(rmpTuneClicks(118.0, 121.8, 1), { outer: 3, inner: 128 });
  assert.deepEqual(rmpTuneClicks(121.025, 121.8, 4), { outer: 0, inner: 31 });
  assert.equal(comFrequencyMatches(121.8, 121.8029), true);
  assert.equal(comFrequencyMatches(121.8, 121.805), false);
});

test("L:var channel: probe, read, write, press (two counts) and confirm", async () => {
  const h = new FakeHandle();
  const lv = new LVarChannel(h.asHandle(), 3000);
  assert.equal(await lv.ready(), true);
  h.lvars.set("S_FCU_AP1", 4);
  await lv.press("S_FCU_AP1");
  assert.equal(h.lvars.get("S_FCU_AP1"), 6);
  lv.write("S_OH_SIGNS", 1);
  assert.equal(await lv.confirm("S_OH_SIGNS", 1, 600), true);
  h.onWrite = (n) => n === "STUCK" && h.lvars.set("STUCK", 0);
  lv.write("STUCK", 1);
  assert.equal(await lv.confirm("STUCK", 1, 600), false);
});

function fenixPanel(title = "FenixA320 Easyjet") {
  const f = fakeSim(title);
  const panel = new SimPanel(f.sim as never);
  f.connect();
  f.h.emitData(70, []); // first panel frame: everything off
  return { ...f, panel };
}

test("Fenix lights go through its overhead switches, not the standard events", async () => {
  const { h, panel } = fenixPanel();
  await wait(20);
  assert.equal((await panel.setLight("beacon", true)).ok, true);
  assert.equal(h.lvars.get("S_OH_EXT_LT_BEACON"), 1);
  assert.equal((await panel.setLight("strobe", true)).ok, true);
  assert.equal(h.lvars.get("S_OH_EXT_LT_STROBE"), 2, "strobe ON is position 2");
  assert.equal((await panel.setLight("landing", true)).ok, true);
  assert.equal(h.lvars.get("S_OH_EXT_LT_LANDING_L"), 2);
  assert.equal(h.lvars.get("S_OH_EXT_LT_LANDING_R"), 2);
  assert.equal((await panel.setLight("taxi", true)).ok, true);
  assert.equal(h.lvars.get("S_OH_EXT_LT_NOSE"), 1);
  assert.ok(!h.events.some((e) => /LIGHT/.test(e.name)), `no standard light events: ${h.events.map((e) => e.name)}`);
});

test("Fenix switches: seat belts, probe heat, parking brake, speed brake arm, APU start", async () => {
  const { h, panel } = fenixPanel();
  await wait(20);
  assert.equal((await panel.sys("seatbelts", 1)).ok, true);
  assert.equal(h.lvars.get("S_OH_SIGNS"), 1);
  assert.equal((await panel.sys("pitotHeat", 1)).ok, true);
  assert.equal(h.lvars.get("S_OH_PROBE_HEAT"), 1);
  assert.equal((await panel.sys("parkingBrake", 1)).ok, true);
  assert.equal(h.lvars.get("S_MIP_PARKING_BRAKE"), 1);
  h.lvars.set("A_FC_SPEEDBRAKE", 1);
  assert.equal((await panel.sys("spoilersArm", 1)).ok, true);
  assert.equal(h.lvars.get("A_FC_SPEEDBRAKE"), 0, "armed is lever position 0");
  h.lvars.set("S_OH_ELEC_APU_START", 0);
  assert.equal((await panel.sys("apu", 1)).ok, true);
  assert.equal(h.lvars.get("S_OH_ELEC_APU_MASTER"), 1);
  assert.equal(h.lvars.get("S_OH_ELEC_APU_START"), 2, "START pressed once (press + release)");
});

test("a study airliner says to use the cockpit instead of pretending", async () => {
  const f = fakeSim("iniBuilds A310-300");
  const panel = new SimPanel(f.sim as never);
  f.connect();
  f.h.emitData(70, []);
  await wait(20);
  const r = await panel.set("alt", 12000);
  assert.deepEqual(r, { ok: false, error: STUDY_NOTE });
});

test("Fenix COM: tunes standby with the RMP knobs (learning 25 kHz spacing), then transfers", async () => {
  const f = fakeSim("FenixA320");
  const radios = new SimRadios(f.sim as never);
  // The radio as the aircraft has it (MHz); every knob move updates the simulator's COM variables.
  let active = 122.8;
  let standby = 118.0;
  const frame = () => f.h.emitData(50, [active * 1e6, standby * 1e6, 121.5e6, 121.5e6, 0x1200, 4, 0, 1, 0]);
  f.h.onWrite = (name, value, before) => {
    const d = value - before;
    if (name === "E_PED_RMP1_OUTER") standby = Math.round((standby + d) * 1000) / 1000;
    if (name === "E_PED_RMP1_INNER") standby = Math.round((standby + d * 0.025) * 1000) / 1000; // 25 kHz spacing
    if (name === "S_PED_RMP1_XFER" && Math.round(value) % 2 === 0) [active, standby] = [standby, active];
    setTimeout(frame, 5);
  };
  f.connect();
  frame();
  await wait(20);
  assert.equal(radios.setCom(1, "active", 121_800_000), true);
  for (let i = 0; i < 80 && Math.abs(active - 121.8) > 0.001; i++) await wait(100);
  assert.equal(active, 121.8);
  assert.equal(standby, 122.8, "the old active frequency moved to standby");
  assert.ok(!f.h.events.some((e) => /COM/.test(e.name)), `no standard COM events: ${f.h.events.map((e) => e.name)}`);
});

/** A panel frame: 10 lights, then the autopilot variables (index 17-20 = Airbus slot indexes), then systems. */
function panelFrame(ap: Record<number, number> = {}) {
  const v = new Array(10 + 21 + 30).fill(0);
  for (const [i, x] of Object.entries(ap)) v[10 + Number(i)] = x;
  return v;
}

test("negative values are sent the way SimConnect takes them, after selecting the knob (as Cobalt)", async () => {
  const f = fakeSim("Cessna Skyhawk Asobo");
  const panel = new SimPanel(f.sim as never);
  f.connect();
  f.h.emitData(70, panelFrame());
  await wait(20);
  await panel.set("vs", -1500);
  const names = f.h.events.map((e) => e.name);
  assert.ok(names.indexOf("VS_SLOT_INDEX_SET") < names.indexOf("AP_VS_VAR_SET_ENGLISH"), names.join(","));
  assert.equal(f.h.events.find((e) => e.name === "AP_VS_VAR_SET_ENGLISH")!.data, 4294965796, "-1500 as an unsigned 32-bit number");
});

test("FlyByWire: push the SPD knob with its own event, confirmed by its managed dot", async () => {
  const f = fakeSim("FlyByWire A320neo (LEAP)");
  const panel = new SimPanel(f.sim as never);
  f.connect();
  f.h.emitData(70, panelFrame());
  f.h.emitData(74, [0, 0, 0, 0, 0, 0, 0]);
  await wait(20);
  f.h.onEvent = (name) => {
    if (name === "A32NX.FCU_SPD_PUSH") setTimeout(() => f.h.emitData(74, [0, 0, 0, 0, 1, 0, 0]), 50);
    if (name === "A32NX.FCU_AP_1_PUSH") setTimeout(() => f.h.emitData(74, [1, 0, 0, 0, 1, 0, 0]), 50);
  };
  assert.deepEqual(await panel.fcu("spd", "push"), { ok: true });
  assert.equal(panel.state()!.ap!.managed!.spd, true);
  assert.deepEqual(await panel.press("cmd"), { ok: true }, "AP1 confirmed by FlyByWire's own AP1 light");
  assert.equal(panel.state()!.ap!.master, true);
});

test("default A320neo: pull HDG with the slot-index event, confirmed by the slot index", async () => {
  const f = fakeSim("Airbus A320neo Asobo");
  const panel = new SimPanel(f.sim as never);
  f.connect();
  f.h.emitData(70, panelFrame({ 17: 2, 18: 2, 19: 2, 20: 2 }));
  await wait(20);
  assert.equal(panel.state()!.ap!.managed!.hdg, true);
  f.h.onEvent = (name, data) => {
    if (name === "HEADING_SLOT_INDEX_SET") setTimeout(() => f.h.emitData(70, panelFrame({ 17: 2, 18: data, 19: 2, 20: 2 })), 50);
  };
  assert.deepEqual(await panel.fcu("hdg", "pull"), { ok: true });
  assert.equal(panel.state()!.ap!.managed!.hdg, false);
  const pmdg = fakeSim("PMDG 737-800");
  const p2 = new SimPanel(pmdg.sim as never);
  pmdg.connect();
  pmdg.h.emitData(70, panelFrame());
  await wait(20);
  assert.equal((await p2.fcu("hdg", "push")).ok, false, "a Boeing has no FCU knobs to push");
});

test("iniBuilds A350: FCU buttons, knobs and lights go through its input events, and the list is asked for again until it comes", async () => {
  assert.equal(addonOf("A350-900 (Default Cabin)"), "airliner");
  assert.equal(addonOf("A340-300 VIP EIS1"), "airliner");
  assert.equal(addonOf("A380-800 RR Basic"), "airliner");
  assert.equal(addonOf("FlyByWire A380X"), "fbw");
  const f = fakeSim("A350-900 (Default Cabin)");
  f.h.inputNames = ["AIRLINER_FCU_AP_1", "AIRLINER_FCU_APPR", "AIRLINER_FCU_HDG_KNOB", "AIRLINER_FCU_HDG_KNOB_PULL", "AIRLINER_LIGHTS_EXT_STROBE"];
  f.h.inputValues.set("AIRLINER_FCU_APPR", 1); // this button rests at 1
  f.h.inputsReadyAfter = 1; // the first ask fails: the aircraft is still loading
  const panel = new SimPanel(f.sim as never);
  let hdg = 100;
  let lights = 0;
  const frame = () => {
    const v = panelFrame({ 13: hdg });
    v[2] = lights; // strobe is the third light
    return v;
  };
  f.connect();
  f.h.emitData(70, frame());
  await wait(3200); // the retry
  assert.ok(f.h.enumerations >= 2);
  // a press is one change of value from where the button rests: AP 1 rests at 0, APPR at 1
  assert.equal((await panel.press("cmd")).ok, true);
  assert.deepEqual(f.h.inputWrites.filter((w) => w.name === "AIRLINER_FCU_AP_1").map((w) => w.value), [1]);
  assert.equal((await panel.press("app")).ok, true);
  assert.deepEqual(f.h.inputWrites.filter((w) => w.name === "AIRLINER_FCU_APPR").map((w) => w.value), [0]);
  // heading: +1 is one degree up (learned), then counted out
  f.h.onInput = (name, value) => {
    if (name === "AIRLINER_FCU_HDG_KNOB") hdg = (hdg + value + 360) % 360;
    if (name === "AIRLINER_LIGHTS_EXT_STROBE") lights = value === 2 ? 1 : 0;
    setTimeout(() => f.h.emitData(70, frame()), 5);
  };
  assert.equal((await panel.set("hdg", 90)).ok, true);
  assert.equal(hdg, 90);
  // strobe: ON is position 2
  assert.equal((await panel.setLight("strobe", true)).ok, true);
  assert.deepEqual(f.h.inputWrites.filter((w) => w.name === "AIRLINER_LIGHTS_EXT_STROBE").map((w) => w.value), [2]);
  // pull: one press of the pull event
  assert.equal((await panel.fcu("hdg", "pull")).ok, true);
  assert.deepEqual(f.h.inputWrites.filter((w) => w.name === "AIRLINER_FCU_HDG_KNOB_PULL").map((w) => w.value), [1]);
  // the FCU screen (the Fenix one) gets this aircraft's FCU, and its knob turns go straight to the input event
  const fcu = panel.airlinerFcu()!;
  assert.equal(fcu.aircraft, "inibuilds");
  assert.equal(fcu.hdg, 90);
  assert.equal((await panel.airlinerCommand({ op: "turn", ctl: "hdg", clicks: 3 })).ok, true);
  assert.equal(hdg, 93);
});

test("iniBuilds V/S window: the slot variable that moves is the one shown", async () => {
  const f = fakeSim("A350-1000 (No Cabin)");
  const panel = new SimPanel(f.sim as never);
  f.connect();
  const frame = (vs: number, vs1: number) => panelFrame({ 15: vs, 21: 0, 22: vs1, 23: 0 });
  f.h.emitData(70, frame(0, 0));
  await wait(10);
  f.h.emitData(70, frame(0, 1200));
  await wait(10);
  assert.equal(panel.state()!.ap!.vsFpm, 1200);
  f.h.emitData(70, frame(0, -800));
  await wait(10);
  assert.equal(panel.state()!.ap!.vsFpm, -800);
});
