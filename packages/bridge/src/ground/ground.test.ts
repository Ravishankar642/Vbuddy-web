import assert from "node:assert/strict";
import { test } from "node:test";
import { GE_PARKING, GE_RUNWAY, GN_HOLD, GN_PARKING, LocalFrame, metresBetween, mockGroundChart, planTaxi, type GroundChart } from "@vbuddy/protocol";
import { buildChart, parkingName, pickOrientation, runwayId, type RawLayout } from "./msfs-layout.js";
import { GroundService } from "./service.js";
import { logger } from "../log.js";

/** Turns a chart back into the simulator's raw facility data, with the offsets laid out one of four ways. */
function toRaw(c: GroundChart, orient: number): RawLayout {
  const f = new LocalFrame(c.lat, c.lon);
  const inv = [(e: number, n: number) => [e, n], (e: number, n: number) => [n, e], (e: number, n: number) => [e, -n], (e: number, n: number) => [-e, n]][orient]!;
  const points: RawLayout["points"] = [];
  const parkings: RawLayout["parkings"] = [];
  const idx = new Map<number, { list: "p" | "k"; i: number }>();
  c.nodes.forEach(([lat, lon, kind], n) => {
    const [e, no] = f.xy(lat, lon);
    const [x, z] = inv(e, no) as [number, number];
    if (kind === GN_PARKING) {
      const p = c.parking.find((pp) => pp.node === n)!;
      const num = Number(p.name.slice(1));
      idx.set(n, { list: "k", i: parkings.length });
      parkings.push({ type: 9, name: 12 + (p.name.charCodeAt(0) - 65), suffix: 0, number: num, hdg: p.hdg, radiusM: p.radiusM, biasX: x, biasZ: z });
    } else {
      idx.set(n, { list: "p", i: points.length });
      points.push({ type: kind === GN_HOLD ? 2 : 1, biasX: x, biasZ: z });
    }
  });
  const paths: RawLayout["paths"] = c.edges.map(([a, b, name, kind, w]) => {
    const A = idx.get(a)!;
    const B = idx.get(b)!;
    const park = kind === GE_PARKING;
    // Parking paths run from a point (START) to a parking (END).
    const [s, e] = park ? (A.list === "k" ? [B, A] : [A, B]) : [A, B];
    return { type: kind === GE_RUNWAY ? 2 : park ? 3 : 1, widthM: w, start: s.i, end: e.i, nameIndex: name };
  });
  const runways = c.runways.map((r) => {
    const mid = { lat: (r.ends[0].lat + r.ends[1].lat) / 2, lon: (r.ends[0].lon + r.ends[1].lon) / 2 };
    const id = (s: string) => ({ n: Number(s.slice(0, 2)), d: s[2] === "L" ? 1 : s[2] === "R" ? 2 : s[2] === "C" ? 3 : 0 });
    return { lat: mid.lat, lon: mid.lon, hdg: r.ends[0].hdg, lengthM: r.lengthM, widthM: r.widthM, primaryNumber: id(r.ends[0].id).n, primaryDesignator: id(r.ends[0].id).d, secondaryNumber: id(r.ends[1].id).n, secondaryDesignator: id(r.ends[1].id).d };
  });
  return { lat: c.lat, lon: c.lon, altM: 12, name: c.name, runways, points, parkings, paths, names: c.names };
}

test("names come out as painted and signed: runway 09L, stand C22, Gate 12", () => {
  assert.equal(runwayId(9, 1), "09L");
  assert.equal(runwayId(27, 0), "27");
  assert.equal(runwayId(37, 0), "N");
  assert.equal(parkingName(14, 0, 22), "C22");
  assert.equal(parkingName(10, 0, 12), "Gate 12");
  assert.equal(parkingName(1, 13, 5), "Stand 5B");
});

test("the scenery's offsets are oriented against the real runways, whichever way they're laid out", () => {
  // A real airport's reference point is rarely its centre of symmetry; move it off centre so a mirror image differs.
  const ref = { ...mockGroundChart(), lat: 19.0887 + 0.004, lon: 72.8679 - 0.006 };
  for (let o = 0; o < 4; o++) {
    const raw = toRaw(ref, o);
    assert.equal(pickOrientation(raw), o, `orientation ${o}`);
    const c = buildChart("VBDY", raw, 1);
    // Same stands in the same places.
    for (const p of ref.parking) {
      const q = c.parking.find((x) => x.name === p.name)!;
      assert.ok(q, `stand ${p.name}`);
      const [la, lo] = ref.nodes[p.node]!;
      const [lb, lob] = c.nodes[q.node]!;
      assert.ok(metresBetween(la, lo, lb, lob) < 1, `${p.name} moved`);
    }
    assert.deepEqual(c.runways.map((r) => `${r.ends[0].id}/${r.ends[1].id}`), ["09L/27R", "09R/27L"]);
    // And it routes like the original.
    const g6 = c.parking.findIndex((p) => p.name === "G6");
    const r = planTaxi(c, { kind: "parking", index: g6 }, { kind: "runway", runway: "27R" });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.crossings, ["09R/27L"]);
  }
});

test("charts are cached; a sim with no layout for an airport is remembered as a miss", async () => {
  let asked = 0;
  const svc = new GroundService(
    {
      chart: async (icao) => {
        asked++;
        return icao === "VBDY" ? mockGroundChart() : null;
      },
    },
    logger("test"),
    null,
    () => true,
  );
  assert.ok((await svc.get("vbdy")).chart);
  assert.ok((await svc.get("VBDY")).chart);
  assert.equal(asked, 1);
  const miss = await svc.get("ZZZZ");
  assert.equal(miss.chart, null);
  assert.match(miss.error ?? "", /no taxiway layout/);
  await svc.get("ZZZZ");
  assert.equal(asked, 2);
  assert.match((await svc.get("not an icao")).error ?? "", /airport code/);
  const off = new GroundService({ chart: async () => mockGroundChart() }, logger("test"), null, () => false);
  assert.match((await off.get("VBDY")).error ?? "", /Start the simulator/);
});
