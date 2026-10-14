import assert from "node:assert/strict";
import { test } from "node:test";
import { emptySystems } from "@vbuddy/protocol";
import { detectAircraftProfile, HIGH_VARS, LOW_VARS, MED_VARS, readGroup, squawkFromBcd16, type ReadBuf, type VarDef } from "./systems-vars.js";

/** A buffer that hands back the given values in order, as SimConnect does for a group. */
function buf(values: Array<number | string>): ReadBuf {
  let i = 0;
  const next = () => values[i++]!;
  return { readFloat64: () => next() as number, readInt32: () => next() as number, readString32: () => next() as string };
}
/** Values for a whole group, defaulting to 0 (or "" for text), with some set by variable name. */
function groupValues(defs: VarDef[], set: Record<string, number | string>) {
  return defs.map((d) => set[d.name] ?? (d.type === "s32" ? "" : 0));
}

test("systems: squawk is decoded from binary-coded octal", () => {
  assert.equal(squawkFromBcd16(0x4521), 4521);
  assert.equal(squawkFromBcd16(0x1200), 1200);
  assert.equal(squawkFromBcd16(0x7700), 7700);
});

test("systems: engine type picks the RPM gauge (piston tach, turboprop prop RPM, jets none)", () => {
  const s = emptySystems();
  readGroup(s, buf(groupValues(MED_VARS, { "ENGINE TYPE:1": 0, "GENERAL ENG RPM:1": 2400.4, "PROP RPM:1": 2100, "ENGINE TYPE:2": 5, "GENERAL ENG RPM:2": 30000, "PROP RPM:2": 1020.2, "TURB ENG MAX TORQUE PERCENT:2": 78.34, "ENGINE TYPE:3": 1, "GENERAL ENG RPM:3": 9000 })), MED_VARS, new Set());
  assert.equal(s.engines.eng1.engineType, "piston");
  assert.equal(s.engines.eng1.rpm, 2400);
  assert.equal(s.engines.eng2.engineType, "turboprop");
  assert.equal(s.engines.eng2.rpm, 1020);
  assert.equal(s.engines.eng2.torquePct, 78.3);
  assert.equal(s.engines.eng3.engineType, "jet");
  assert.equal(s.engines.eng3.rpm, 0);
});

test("systems: lights that read off on their switch but are on in LIGHT ON STATES count as on", () => {
  const s = emptySystems();
  readGroup(s, buf(groupValues(MED_VARS, { "LIGHT NAV": 1, "LIGHT ON STATES": 0x0002 | 0x0004 | 0x0010 })), MED_VARS, new Set());
  assert.equal(s.lights.nav, true);
  assert.equal(s.lights.beacon, true);
  assert.equal(s.lights.landing, true);
  assert.equal(s.lights.strobe, true);
  assert.equal(s.lights.taxi, false);
});

test("systems: units, text and doors are read in group order", () => {
  const s = emptySystems();
  readGroup(s, buf(groupValues(HIGH_VARS, { "SIM ON GROUND": 0, "TURB ENG N1:1": 84.04, "ENG COMBUSTION:1": 1, "ENG EXHAUST GAS TEMPERATURE:1": 1491.67 })), HIGH_VARS, new Set());
  assert.equal(s.meta.onGround, false);
  assert.equal(s.engines.eng1.n1, 84);
  assert.equal(s.engines.eng1.running, true);
  assert.equal(s.engines.eng1.egt, 556);
  readGroup(s, buf(groupValues(MED_VARS, { "GPS WP NEXT ID": "BUBIM ", "GPS WP DISTANCE": 18520, "TRANSPONDER CODE:1": 0x2764, "NUMBER OF ENGINES": 4, "AUTOPILOT SPEED SLOT INDEX": 2 })), MED_VARS, new Set());
  assert.equal(s.navigation.wpNextId, "BUBIM");
  assert.equal(s.navigation.wpDistanceNm, 10);
  assert.equal(s.navigation.xpdrCode, 2764);
  assert.equal(s.engines.count, 4);
  assert.equal(s.autopilot.fcuSpeedSelected, false);
  readGroup(s, buf(groupValues(LOW_VARS, { "EXIT OPEN:2": 0.6, "EXIT OPEN:3": 0.02, "MASTER WARNING ACTIVE": 1 })), LOW_VARS, new Set());
  assert.deepEqual(s.doors, { door1: false, door2: true, door3: false, door4: false });
  assert.equal(s.warnings.masterWarning, true);
});

test("systems: paths owned by a study aircraft's own variables keep the overlay value", () => {
  const s = emptySystems();
  s.autopilot.apAltTarget = 36000;
  readGroup(s, buf(groupValues(MED_VARS, { "AUTOPILOT ALTITUDE LOCK VAR": 0 })), MED_VARS, new Set(["autopilot.apAltTarget"]));
  assert.equal(s.autopilot.apAltTarget, 36000);
});

test("systems: aircraft profiles from the title", () => {
  assert.equal(detectAircraftProfile("FenixA320 IAE SL"), "fenixA320");
  assert.equal(detectAircraftProfile("FlyByWire A320neo (LEAP)"), "fbwA32nx");
  assert.equal(detectAircraftProfile("PMDG 737-800"), "pmdg737");
  assert.equal(detectAircraftProfile("Airbus A320neo Asobo"), "stock");
  assert.equal(detectAircraftProfile("iFly 737 MAX 8"), "iFly737Max");
  assert.equal(detectAircraftProfile("FSLabs A321"), "studyCustom");
  assert.equal(detectAircraftProfile("Cessna Skyhawk"), "stock");
});
