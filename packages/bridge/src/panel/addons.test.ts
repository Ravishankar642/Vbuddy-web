import { test } from "node:test";
import assert from "node:assert/strict";
import { addonOf, fbwValue, incDecClicks, matchName, pmdgPlan, PMDG_WHEEL_DOWN, PMDG_WHEEL_UP } from "./addons.js";
import { studyName, studyReadOnly } from "./addons.js";

test("addons: the aircraft is recognised from its title, liveries and all", () => {
  assert.equal(addonOf("PMDG 737-800 NGXu Air India (VT-RXA)"), "pmdg737");
  assert.equal(addonOf("PMDG 777-300ER"), "none", "the 777 is handled elsewhere");
  assert.equal(addonOf("737-800 PAX BW SC"), "pmdg737", "a livery titled without the maker");
  assert.equal(addonOf("FlyByWire A320neo (LEAP)"), "fbw");
  assert.equal(addonOf("A380-842 FlyByWire"), "fbw");
  assert.equal(addonOf("iFly 737 MAX 8"), "ifly");
  assert.equal(addonOf("Asobo Boeing 747-8"), "none");
});

test("addons: PMDG knobs become wheel clicks on the SDK event numbers", () => {
  assert.deepEqual(pmdgPlan("spd", 250, 270, false), { event: "#70016", flag: PMDG_WHEEL_UP, count: 20 });
  assert.deepEqual(pmdgPlan("hdg", 90, 80), { event: "#70022", flag: PMDG_WHEEL_DOWN, count: 10 });
  assert.deepEqual(pmdgPlan("alt", 10000, 12000), { event: "#70032", flag: PMDG_WHEEL_UP, count: 20 });
  assert.deepEqual(pmdgPlan("vs", 0, -1500), { event: "#70033", flag: PMDG_WHEEL_DOWN, count: 15 });
  assert.equal(pmdgPlan("alt", 5000, 5000), null);
});

test("addons: PMDG heading takes the short way round; Mach clicks are hundredths; clicks are capped", () => {
  assert.deepEqual(pmdgPlan("hdg", 350, 10), { event: "#70022", flag: PMDG_WHEEL_UP, count: 20 });
  assert.deepEqual(pmdgPlan("hdg", 10, 350), { event: "#70022", flag: PMDG_WHEEL_DOWN, count: 20 });
  assert.deepEqual(pmdgPlan("spd", 0.78, 0.8, true), { event: "#70016", flag: PMDG_WHEEL_UP, count: 2 });
  assert.equal(pmdgPlan("alt", 0, 60000)!.count, 500);
});

test("addons: FlyByWire values are rounded the way the FCU takes them", () => {
  assert.equal(fbwValue("hdg", 360, false), 0);
  assert.equal(fbwValue("hdg", -10, false), 350);
  assert.equal(fbwValue("alt", 12340, false), 12300);
  assert.equal(fbwValue("vs", -1480, false), -1500);
  assert.equal(fbwValue("spd", 0.78, true), 78);
  assert.equal(fbwValue("spd", 250.4, false), 250);
});

test("addons: iFly input events are found by name, and detents counted", () => {
  const names = ["MCP_ALT_KNOB_INC", "MCP_ALT_KNOB_DEC", "OTHER"];
  assert.equal(matchName(names, [/(mcp|ap).*alt.*(inc|up)/]), "MCP_ALT_KNOB_INC");
  assert.equal(matchName(names, [/nothing/]), null);
  assert.equal(incDecClicks("alt", 10000, 11000), 10);
  assert.equal(incDecClicks("hdg", 350, 10), 20);
});

test("an FSLabs A321neo is a study airliner: the app is told it can't be operated from outside", () => {
  const t = "FSLabs A321-252NX - IndiGo VT-ICF";
  assert.equal(addonOf(t), "study");
  assert.equal(studyName(t), "FSLabs A321neo");
  assert.match(studyReadOnly(t), /^FSLabs A321neo keeps its cockpit private/);
});
