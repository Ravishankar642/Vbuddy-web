import { test } from "node:test";
import assert from "node:assert/strict";
import { GroundChartSchema, isTaxiClearance, LocalFrame, mockGroundChart, normRunway, parseTaxiClearance, planTaxi, taxiProgress } from "./index.js";

const chart = mockGroundChart();
const f = new LocalFrame(chart.lat, chart.lon);
const gate = (name: string) => chart.parking.findIndex((p) => p.name === name);

test("the test airport is a valid chart, and its holding points know their runways", () => {
  assert.ok(GroundChartSchema.safeParse(chart).success);
  assert.equal(chart.holds.length, 7);
  // N1-N3 holds protect the northern runway (index 0); the C1/C2 holds the southern one.
  const north = chart.holds.filter(([, r]) => r === 0).length;
  assert.equal(north, 3);
});

test("from a gate to the far runway: via B and a C link, crossing the near runway, holding short of 27R", () => {
  const r = planTaxi(chart, { kind: "parking", index: gate("G6") }, { kind: "runway", runway: "27R" });
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.equal(r.runway, "27R");
  assert.deepEqual(r.crossings, ["09R/27L"]);
  assert.ok(r.via.includes("A"), `via ${r.via.join(",")}`);
  // Ends at the N3 hold (nearest the 27R threshold at x = 1500).
  const [x, y] = f.xy(...r.points[r.points.length - 1]!);
  assert.ok(Math.abs(x - 1500) < 1 && Math.abs(y + 90) < 1, `ended at ${x.toFixed(0)},${y.toFixed(0)}`);
  assert.match(r.text, /^Taxi to holding point runway 27R via .*A.*\. Cross runway 09R\/27L\.$/);
});

test("a via list is followed in order: B, C1, A, N2", () => {
  const r = planTaxi(chart, { kind: "parking", index: gate("G6") }, { kind: "runway", runway: "27R" }, ["b", "c 1", "A", "N2"]);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.via, ["B", "C1", "A", "N2"]);
  assert.deepEqual(r.unmatched, []);
  // N2 isn't the nearest hold to 27R, but the clearance said N2.
  const [x] = f.xy(...r.points[r.points.length - 1]!);
  assert.ok(Math.abs(x) < 1);
});

test("a taxiway name that doesn't exist is reported, and a route is still given", () => {
  const r = planTaxi(chart, { kind: "parking", index: gate("G1") }, { kind: "runway", runway: "09L" }, ["B", "Z9"]);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.unmatched, ["Z9"]);
});

test("from a position on a taxiway to a gate; unknown runways are refused politely", () => {
  const [lat, lon] = f.ll(-150, -300); // on A, between nodes
  const r = planTaxi(chart, { kind: "position", lat, lon, hdg: 90 }, { kind: "parking", index: gate("G3") });
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.destination, "stand G3");
    assert.deepEqual(r.crossings, ["09R/27L"]);
    assert.ok(r.distanceM > 500 && r.distanceM < 1500, `${r.distanceM}`);
  }
  const bad = planTaxi(chart, { kind: "parking", index: 0 }, { kind: "runway", runway: "33" });
  assert.equal(bad.ok, false);
});

test("guidance: what's next and how far, along the route", () => {
  const r = planTaxi(chart, { kind: "parking", index: gate("G6") }, { kind: "runway", runway: "27R" }, ["B", "C2", "A", "N3"]);
  assert.ok(r.ok);
  if (!r.ok) return;
  // Just out of the gate, on B heading for C2.
  const [lat, lon] = f.ll(600, -800);
  const p = taxiProgress(r, lat, lon);
  assert.ok(p.offRouteM < 2);
  assert.ok(p.next);
  assert.equal(p.next!.what, "turn");
  // On C2 short of the southern runway: crossing comes next.
  const [la2, lo2] = f.ll(600, -720);
  const p2 = taxiProgress(r, la2, lo2);
  assert.equal(p2.next!.what, "cross");
  assert.equal(p2.next!.name, "09R/27L");
  // On N3 short of the end: hold short.
  const [la3, lo3] = f.ll(1500, -200);
  const p3 = taxiProgress(r, la3, lo3);
  assert.equal(p3.next!.what, "hold");
  assert.ok(p3.remainingM < 120);
});

test("taxi clearances are read as ATC says them", () => {
  const c = parseTaxiClearance("Speedbird one two three, taxi to holding point runway two seven right via Bravo, Charlie two, Alpha, November three, hold short runway two seven left.");
  assert.equal(c.runway, "27R");
  assert.deepEqual(c.via, ["B", "C2", "A", "N3"]);
  assert.deepEqual(c.holdShort, ["27L"]);
  const d = parseTaxiClearance("QTR7 taxi rwy 09L via A N1");
  assert.equal(d.runway, "09L");
  assert.deepEqual(d.via, ["A", "N1"]);
  const e = parseTaxiClearance("Taxi to stand Golf four via Alpha and Bravo");
  assert.equal(e.stand, "G4");
  assert.deepEqual(e.via, ["A", "B"]);
  assert.ok(isTaxiClearance("taxi to holding point runway 27 via A"));
  assert.ok(!isTaxiClearance("climb and maintain flight level three five zero"));
  assert.equal(normRunway("rwy 9l"), "09L");
});
