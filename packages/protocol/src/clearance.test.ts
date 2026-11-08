import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAtis, parseClearance, readback } from "./index.js";

test("clearance: picks out levels, headings, speeds, frequencies, squawk and directs", () => {
  const items = parseClearance("BAW123 climb flight level 350, turn left heading 270, reduce speed 250 knots, contact Dubai Radar 124.35, squawk 4721, proceed direct BUSBO");
  assert.deepEqual(items.map((i) => i.label), ["FL350", "HDG 270", "250 kt", "124.350", "Squawk 4721", "DCT BUSBO"]);
  assert.equal(items.find((i) => i.kind === "frequency")!.hz, 124_350_000);
  assert.deepEqual(parseClearance("descend 5000 feet QNH 1013").map((i) => i.label), ["5,000 ft", "QNH 1013"]);
  assert.deepEqual(parseClearance("good day"), []);
});

test("atis: letter, runways and QNH", () => {
  const a = parseAtis(["DUBAI INFORMATION K TIME 1200", "ILS APPROACH RWY 30L AND 30R IN USE", "WIND 300/12 Q1012"]);
  assert.deepEqual(a, { code: "K", runways: ["30L", "30R"], qnh: "1012" });
  assert.equal(parseAtis(["KJFK ATIS INFO B", "LANDING RUNWAY 22L", "ALTIMETER 2992"], "B").qnh, "2992");
});

test("clearance: spoken numbers from voice to text", () => {
  const items = parseClearance("speedbird one two three climb flight level three five zero contact dubai radar one two four decimal three five squawk four seven two one");
  assert.ok(items.some((i) => i.label === "FL350"), JSON.stringify(items));
  assert.ok(items.some((i) => i.label === "124.350"), JSON.stringify(items));
  assert.ok(items.some((i) => i.label === "Squawk 4721"), JSON.stringify(items));
});

test("readback: the instructions in order, then the callsign", () => {
  assert.equal(readback(parseClearance("descend flight level 240 turn left heading 270 contact radar 124.9"), "BAW123"), "FL240, heading 270, 124.900, BAW123");
  assert.equal(readback([], "BAW123"), "");
});
