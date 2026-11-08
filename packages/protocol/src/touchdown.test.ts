import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalFrame, touchdownOnRunway, type GroundChart } from "./index.js";

// A 3,000 m runway 09/27 along the equator, 45 m wide.
const f = new LocalFrame(0, 0);
const [eLat, eLon] = f.ll(3000, 0);
const runways: GroundChart["runways"] = [{ ends: [{ id: "09", lat: 0, lon: 0, hdg: 90 }, { id: "27", lat: eLat, lon: eLon, hdg: 270 }], widthM: 45, lengthM: 3000 }];

test("touchdown point: distance from the threshold, centreline offset, the right runway end", () => {
  const [lat, lon] = f.ll(450, -3); // 450 m in, 3 m south = right of an eastbound centreline
  const r = touchdownOnRunway(runways, lat, lon, 91)!;
  assert.equal(r.runway, "09");
  assert.equal(r.fromThresholdM, 450);
  assert.equal(r.offsetM, 3);
  assert.equal(r.remainingM, 2550);
  const w = touchdownOnRunway(runways, lat, lon, 271)!;
  assert.equal(w.runway, "27");
  assert.equal(w.fromThresholdM, 2550);
  assert.equal(w.offsetM, -3);
  assert.equal(touchdownOnRunway(runways, lat, lon, 180), null, "crossing the runway isn't landing on it");
  const [farLat, farLon] = f.ll(450, 400);
  assert.equal(touchdownOnRunway(runways, farLat, farLon, 90), null, "a parallel taxiway or field isn't the runway");
});
