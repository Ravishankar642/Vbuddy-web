import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlightAlert } from "@vbuddy/protocol";
import { parseMetar } from "./metar.js";
import { DestinationWeather, weatherChange } from "./dest-weather.js";

const NOW = Date.UTC(2026, 10, 8, 12, 0);

test("destination weather: category down, gusts and thunderstorms are news; the same or better isn't", () => {
  const vfr = parseMetar("OMDB 081150Z 30010KT 9999 FEW040 30/10 Q1012", NOW);
  const ifr = parseMetar("OMDB 081220Z 30018G30KT 1500 TSRA BKN004 25/20 Q1010", NOW);
  const t = weatherChange("OMDB", vfr, ifr)!;
  assert.match(t, /now LIFR \(was VFR\): vis 1500 m, ceiling 400 ft/);
  assert.match(t, /gusting 30 kt/);
  assert.match(t, /thunderstorms/);
  assert.equal(weatherChange("OMDB", ifr, vfr), null);
});

test("destination weather: first report is the baseline, then one fetch per 10 minutes", async () => {
  const reports = ["OMDB 081150Z 30010KT 9999 FEW040 30/10 Q1012", "OMDB 081220Z 30010KT 2000 BR OVC003 25/20 Q1010"];
  let calls = 0;
  const fetcher = async () => ({ ok: true, status: 200, text: async () => (calls++ % 2 === 0 ? reports[Math.min(calls - 1, 1)]! : ""), json: async () => null });
  const alerts: FlightAlert[] = [];
  const w = new DestinationWeather(fetcher, (a) => alerts.push(a));
  w.update("OMDB", true, 0);
  await new Promise((r) => setTimeout(r, 10));
  w.update("OMDB", true, 60_000); // too soon
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(alerts.length, 0);
  w.update("OMDB", true, 10 * 60_000 + 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]!.kind, "weather");
  assert.match(alerts[0]!.text, /LIFR/);
});

test("sigmets: polygons become [lat, lon] rings, the map gets only what it shows", async () => {
  const { mapSigmets } = await import("./sigmets.js");
  const a = mapSigmets({
    features: [
      { properties: { hazard: "TS", qualifier: "EMBD", base: 0, top: 41000, validTimeTo: "2026-11-08T14:00:00Z", firName: "MUMBAI", rawSigmet: "VABF SIGMET 3 ..." }, geometry: { type: "Polygon", coordinates: [[[72.123, 19.456], [73, 20], [74, 19], [72.123, 19.456]]] } },
      { properties: { hazard: "TURB" }, geometry: { type: "Point", coordinates: [1, 2] } },
    ],
  });
  assert.equal(a.length, 1);
  assert.deepEqual(a[0]!.rings[0]![0], [19.46, 72.12]);
  assert.equal(a[0]!.topFt, 41000);
  assert.equal(a[0]!.validTo, Date.UTC(2026, 10, 8, 14));
});

test("sigmets: valid-until as seconds since 1970 works too", async () => {
  const { mapSigmets } = await import("./sigmets.js");
  const a = mapSigmets({ features: [{ properties: { hazard: "ICE", validTimeTo: 1762610400 }, geometry: { type: "Polygon", coordinates: [[[1, 1], [2, 2], [3, 1], [1, 1]]] } }] });
  assert.equal(a[0]!.validTo, 1762610400000);
});
