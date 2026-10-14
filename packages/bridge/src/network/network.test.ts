import { test } from "node:test";
import assert from "node:assert/strict";
import { logger } from "../log.js";
import { placeStations } from "./atc.js";
import { AtcWatcher, covering, type OwnPosition } from "./coverage.js";
import { circleArea, destination, distNm, inArea, makeArea } from "./geo.js";
import { emptySectors, parseFirBoundaries, parseTraconBoundaries, parseVatspyDat } from "./sectors.js";
import { detectSelf, filterTraffic } from "./traffic.js";
import { parseVatsimFeed, VatsimFeed, type RawController } from "./vatsim-feed.js";
import { NetworkService } from "./service.js";

const log = logger("test");

/*
 * A made-up region: FIR XXXX covers lon 0..10, lat 40..50; its north split XXXX-N covers lat 45..50.
 * FIR YYYY is next door (lon 10..20). UIR XXUU = both. Airport XAAA at 42N 5E has an approach shape;
 * airport XBBB (LID "BBB") at 48N 8E has none.
 */
const sq = (x0: number, y0: number, x1: number, y1: number) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const DAT = `[Countries]
Testland|XX|Center
[Airports]
;comment
XAAA|Alpha Intl|42.0|5.0|AAA|XXXX|0
XBBB|Bravo|48.0|8.0|BBB|XXXX|0
XPSE|Pseudo|43|6|PSE|XXXX|1
broken|line
[FIRs]
XXXX|Xland||XXXX
XXXX-N|Xland Radar (North)|XXXX_N|XXXX-N
YYYY|Yland Control||YYYY
[UIRs]
XXUU|Xland Upper|XXXX,YYYY
[IDL]
1|2
`;
const FIRS = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "XXXX", label_lat: "45", label_lon: "5" }, geometry: { type: "MultiPolygon", coordinates: [sq(0, 40, 10, 50)] } },
    { type: "Feature", properties: { id: "XXXX-N" }, geometry: { type: "MultiPolygon", coordinates: [sq(0, 45, 10, 50)] } },
    { type: "Feature", properties: { id: "YYYY" }, geometry: { type: "Polygon", coordinates: sq(10, 40, 20, 50) } },
    { type: "Feature", properties: { id: "BAD" }, geometry: { type: "Point", coordinates: [1, 2] } },
  ],
};
const TRACONS = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", properties: { id: "XA", prefix: ["XAAA"], name: "Alpha Approach" }, geometry: { type: "MultiPolygon", coordinates: [sq(4, 41, 6, 43)] } },
    { type: "Feature", properties: { id: "XA", prefix: ["XAAA"], suffix: "DEP", name: "Alpha Departure" }, geometry: { type: "MultiPolygon", coordinates: [sq(4.5, 41.5, 5.5, 42.5)] } },
  ],
};

function sectors() {
  const s = emptySectors();
  parseVatspyDat(DAT, s);
  parseFirBoundaries(FIRS, s);
  parseTraconBoundaries(TRACONS, s);
  return s;
}
const ctl = (callsign: string, freq = "123.450", facility = 0): RawController => ({ callsign, name: "x", freq, facility });
const pos = (over: Partial<OwnPosition> = {}): OwnPosition => ({ lat: 42, lon: 5, altMsl: 5000, altAgl: 4900, onGround: false, gs: 300, track: 90, ...over });

test("geo: distance, destination, point in polygon with holes", () => {
  assert.ok(Math.abs(distNm(0, 0, 1, 0) - 60) < 0.2, "1 degree of latitude is ~60 nm");
  const [la, lo] = destination(0, 0, 90, 60);
  assert.ok(Math.abs(la) < 1e-9 && Math.abs(lo - 1) < 0.01);
  const donut = makeArea([[sq(0, 0, 10, 10)[0]!, sq(4, 4, 6, 6)[0]!]] as never);
  assert.equal(inArea(donut, 2, 2), true);
  assert.equal(inArea(donut, 5, 5), false, "inside the hole");
  assert.equal(inArea(donut, 20, 5), false);
  const c = circleArea(42, 5, 35);
  assert.equal(inArea(c, 42.5, 5), true);
  assert.equal(inArea(c, 43, 5), false, "60 nm away is outside a 35 nm circle");
});

test("sector data parses tolerantly", () => {
  const s = sectors();
  assert.equal(s.airports.get("XAAA")?.name, "Alpha Intl");
  assert.equal(s.airports.get("BBB")?.icao, "XBBB", "LID lookup");
  assert.equal(s.airports.has("XPSE"), false, "pseudo airports aren't real airports");
  assert.equal(s.airports.get("PSE")?.icao, "XPSE", "...but their LID still maps (used as callsign prefixes)");
  assert.equal(s.firByPrefix.get("XXXX_N")?.boundary, "XXXX-N");
  assert.equal(s.firByPrefix.get("XXXX")?.boundary, "XXXX");
  assert.deepEqual(s.uirs.get("XXUU")?.firs, ["XXXX", "YYYY"]);
  assert.equal(s.firShapes.size, 3, "non-polygon features skipped");
  assert.equal(s.tracons.length, 2);
  assert.equal(s.tracons[0]!.suffix, "APP", "missing suffix means APP");
});

test("stations are matched to the right shapes", () => {
  const { placed, areas } = placeStations(
    [
      ctl("XXXX_N_CTR", "132.100"),
      ctl("XXXX__CTR"), // relief callsign with a double underscore
      ctl("XXXX_W_CTR"), // unknown split: falls back to the whole FIR
      ctl("XXUU_FSS"),
      ctl("XAAA_APP"),
      ctl("XAAA_DEP"),
      ctl("BBB_APP"), // no approach shape: circle round the airport (found by LID)
      ctl("XAAA_TWR"),
      ctl("XAAA_GND", "121.9", 3),
      ctl("XAAA_OBS"),
      ctl("ZZZZ_CTR"), // unknown everywhere
      ctl("XBBB_SUP", "199.998", 0),
    ],
    [{ callsign: "XAAA_ATIS", freq: "128.000", code: "K", text: ["ALPHA INFO K"] }],
    sectors(),
  );
  const by = Object.fromEntries(placed.map((p) => [p.station.callsign, p]));
  assert.equal(by["XXXX_N_CTR"]!.station.boundaryId, "fir:XXXX-N");
  assert.equal(by["XXXX_N_CTR"]!.station.name, "Xland Radar (North)");
  assert.equal(by["XXXX_N_CTR"]!.station.freq, "132.100");
  assert.equal(by["XXXX__CTR"]!.station.boundaryId, "fir:XXXX");
  assert.equal(by["XXXX__CTR"]!.station.name, "Xland Control", "a bare place name gets a role word");
  assert.equal(by["XXXX_W_CTR"]!.station.boundaryId, "fir:XXXX");
  assert.equal(by["XXUU_FSS"]!.station.boundaryId, "uir:XXUU");
  assert.equal(by["XXUU_FSS"]!.area?.polys.length, 2, "UIR = its FIRs");
  assert.equal(by["XAAA_APP"]!.station.name, "Alpha Approach");
  assert.equal(by["XAAA_DEP"]!.station.name, "Alpha Departure");
  assert.equal(by["BBB_APP"]!.station.boundaryId, "circle:XBBB");
  assert.equal(by["BBB_APP"]!.station.name, "Bravo Approach");
  assert.equal(by["XAAA_TWR"]!.station.boundaryId, null, "no tower shape: airport point");
  assert.equal(by["XAAA_TWR"]!.station.lat, 42);
  assert.equal(by["XAAA_TWR"]!.station.atisCode, "K");
  assert.equal(by["XAAA_GND"]!.station.facility, "gnd");
  assert.equal(by["XAAA_GND"]!.station.freq, "121.900");
  assert.equal(by["ZZZZ_CTR"]!.station.boundaryId, null);
  assert.ok(!by["XAAA_OBS"] && !by["XBBB_SUP"], "observers and supervisors aren't stations");
  assert.ok(areas.has("fir:XXXX-N") && areas.has("circle:XBBB"));
});

test("works without sector data: stations listed, no shapes", () => {
  const { placed } = placeStations([ctl("XXXX_CTR"), ctl("XAAA_TWR")], [], null);
  assert.equal(placed.length, 2);
  assert.ok(placed.every((p) => p.area === null && p.station.boundaryId === null));
});

test("coverage picks the lowest online unit whose airspace you're in", () => {
  const all = placeStations([ctl("XXXX_CTR"), ctl("XXXX_N_CTR"), ctl("XAAA_APP"), ctl("XAAA_TWR"), ctl("XAAA_GND")], [], sectors()).placed;
  const cs = (p: OwnPosition, list = all) => covering(list, p)?.callsign ?? null;
  assert.equal(cs(pos({ onGround: true, altAgl: 0, gs: 10 })), "XAAA_GND");
  assert.equal(cs(pos({ altAgl: 1500, altMsl: 1600 })), "XAAA_TWR", "low and close: tower");
  assert.equal(cs(pos({ altAgl: 4900 })), "XAAA_APP", "above the tower's ceiling: approach");
  assert.equal(cs(pos({ altMsl: 30000, altAgl: 29900 })), "XXXX_CTR", "above the approach ceiling: centre");
  assert.equal(cs(pos({ lat: 47, lon: 5, altMsl: 30000 })), "XXXX_N_CTR", "the split sector is more specific");
  assert.equal(cs(pos({ lat: 47, lon: 15 })), null, "YYYY is offline: UNICOM");
  const noTwr = all.filter((p) => p.station.facility !== "twr" && p.station.facility !== "gnd");
  assert.equal(cs(pos({ onGround: true, altAgl: 0 }), noTwr), "XAAA_APP", "approach covers the airport when the tower is offline");
});

test("watcher: alerts only after a change holds, then looks ahead along the track", () => {
  const list = placeStations([ctl("XXXX_CTR", "130.000"), ctl("YYYY_CTR", "135.000")], [], sectors()).placed;
  const w = new AtcWatcher({ stableMs: 5000, lookAheadSec: 600, stepSec: 20 });
  const cruise = (lon: number) => pos({ lat: 45, lon, altMsl: 35000, altAgl: 35000, gs: 480, track: 90 });

  // first fix: no alert; 8 nm/min at 480 kt, the boundary at 10E is ~42 nm ahead from 9E -> ~5 min
  let r = w.update(list, cruise(9), 0);
  assert.equal(r.position?.current?.callsign, "XXXX_CTR");
  assert.equal(r.position?.ahead?.station?.callsign, "YYYY_CTR");
  assert.ok(r.position!.ahead!.etaSec >= 260 && r.position!.ahead!.etaSec <= 340, `eta ${r.position!.ahead!.etaSec}`);
  assert.deepEqual(r.alerts.map((a) => a.kind), ["ahead"], "a boundary within 10 min is announced once");
  assert.match(r.alerts[0]!.text, /Yland Control in about 5 min: 135\.000/);
  assert.equal(w.update(list, cruise(9.05), 1000).alerts.length, 0, "not repeated");

  // cross the boundary: nothing for 5 s (could be a wobble), then "contact"
  assert.equal(w.update(list, cruise(10.01), 2000).alerts.length, 0);
  assert.equal(w.update(list, cruise(9.99), 3000).alerts.length, 0, "back across: candidate cleared");
  assert.equal(w.update(list, cruise(10.02), 4000).alerts.length, 0);
  r = w.update(list, cruise(10.1), 9500);
  assert.deepEqual(r.alerts.map((a) => a.kind), ["contact"]);
  assert.equal(r.alerts[0]!.text, "Contact Yland Control on 135.000 (YYYY_CTR).");
  assert.equal(r.position?.current?.callsign, "YYYY_CTR");

  // heading for the edge of everything: "leaving coverage", then UNICOM
  r = w.update(list, cruise(19.5), 20000);
  assert.equal(r.alerts[0]?.kind, "ahead");
  assert.match(r.alerts[0]!.text, /Leaving ATC coverage in about \d+ min\. Then UNICOM 122\.800/);
  w.update(list, cruise(20.5), 30000);
  r = w.update(list, cruise(20.6), 36000);
  assert.deepEqual(r.alerts.map((a) => a.kind), ["unicom"]);

  // sim gone: everything clears
  w.update(list, null, 40000);
  assert.deepEqual(w.position(), { current: null, ahead: null });
});

test("watcher: a controller logging on above you is a contact alert; no look-ahead on the ground", () => {
  const w = new AtcWatcher({ stableMs: 0 });
  const p = pos({ lat: 47, lon: 5, altMsl: 30000, altAgl: 30000 });
  w.update([], p, 0);
  const r = w.update(placeStations([ctl("XXXX_N_CTR", "128.250")], [], sectors()).placed, p, 1000);
  assert.equal(r.alerts[0]?.kind, "contact");
  const g = new AtcWatcher();
  assert.equal(g.update([], pos({ onGround: true, gs: 20 }), 0).position?.ahead ?? null, null);
});

test("traffic is filtered by distance, nearest first, without you", () => {
  const pilots = [
    { callsign: "FAR", lat: 50, lon: 5, alt: 30000, gs: 450, hdg: 0 },
    { callsign: "NEAR", lat: 42.1, lon: 5, alt: 3000, gs: 200, hdg: 90 },
    { callsign: "ME", lat: 42, lon: 5, alt: 5000, gs: 300, hdg: 90 },
    { callsign: "MID", lat: 43, lon: 5, alt: 8000, gs: 250, hdg: 90 },
  ];
  const out = filterTraffic(pilots, 42, 5, 100, "ME");
  assert.deepEqual(out.map((p) => p.callsign), ["NEAR", "MID"]);
  assert.equal(out[0]!.distNm, 6);
  assert.equal(filterTraffic(pilots, 42, 5, 1000, null, 2).length, 2, "capped");
});

test("finds you on the network, and stays sure while it still fits", () => {
  const me = pos({ lat: 42, lon: 5, altMsl: 5000, gs: 300, track: 90 });
  const feed = [
    { callsign: "ME123", lat: 42.02, lon: 4.95, alt: 4900, gs: 300, hdg: 92 }, // ~2.5 nm behind (feed lag)
    { callsign: "OTHER", lat: 42.02, lon: 5.0, alt: 9000, gs: 300, hdg: 90 }, // right altitude? no: 4000 ft off
    { callsign: "HEAD", lat: 42.0, lon: 5.01, alt: 5000, gs: 300, hdg: 270 }, // opposite direction
  ];
  assert.equal(detectSelf(feed, me, null), "ME123");
  const twins = [...feed, { callsign: "TWIN", lat: 42.0, lon: 4.99, alt: 5000, gs: 300, hdg: 90 }];
  assert.equal(detectSelf(twins, me, null), null, "two candidates: don't guess");
  assert.equal(detectSelf(twins, me, "ME123"), "ME123", "...unless we already knew");
});

test("feed parsing keeps what's usable", () => {
  const s = parseVatsimFeed({
    general: { update_timestamp: "2026-10-10T23:17:27.2596666Z" },
    pilots: [
      { callsign: "ABC1", latitude: 1, longitude: 2, altitude: 3000, groundspeed: 200, heading: 90, flight_plan: { aircraft_short: "A20N", departure: "VABB", arrival: "VIDP" } },
      { callsign: "NOPOS", latitude: null, longitude: 2 },
      { latitude: 1, longitude: 2 },
      { callsign: "NOFP", latitude: 1, longitude: 2, flight_plan: null },
    ],
    controllers: [{ callsign: "vabb_twr", frequency: "118.700", facility: 4, name: "A" }],
    atis: [{ callsign: "VABB_ATIS", frequency: "126.400", atis_code: "D", text_atis: ["MUMBAI", 3] }],
  });
  assert.equal(s.updatedAt, Date.parse("2026-10-10T23:17:27.259Z"));
  assert.deepEqual(s.pilots.map((p) => p.callsign), ["ABC1", "NOFP"]);
  assert.equal(s.pilots[0]!.type, "A20N");
  assert.equal(s.controllers[0]!.callsign, "VABB_TWR");
  assert.deepEqual(s.atis[0]!.text, ["MUMBAI"]);
  assert.equal(parseVatsimFeed(null).pilots.length, 0, "garbage in, empty out");
});

/** A fetch stand-in that serves a sequence of responses. */
function fakeFetch(responses: Array<() => Response>) {
  const calls: string[] = [];
  const fn = (async (url: string | URL) => {
    calls.push(String(url));
    const r = responses.shift();
    if (!r) throw new Error("no more responses");
    return r();
  }) as unknown as typeof fetch;
  return { fn, calls };
}
const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

test("feed poller: idles when unwanted, reports errors without crashing, recovers", async () => {
  let wanted = false;
  const f = fakeFetch([
    () => {
      throw new Error("ECONNREFUSED");
    },
    json({ general: { update_timestamp: "2026-10-10T00:00:00Z" }, pilots: [], controllers: [] }),
  ]);
  const feed = new VatsimFeed({ log, fetch: f.fn, feedUrl: "http://feed/x.json", wanted: () => wanted });
  const states: string[] = [];
  let got = 0;
  feed.onState((s) => states.push(s.state));
  feed.onData(() => got++);
  await feed.tick();
  assert.equal(f.calls.length, 0, "nobody needs data: no request");
  wanted = true;
  await feed.tick();
  assert.deepEqual(states, ["error"]);
  await feed.tick();
  assert.deepEqual(states, ["error", "ok"]);
  assert.equal(got, 1);
  feed.stop();
});

test("network service: traffic per area, alerts, and boundary shapes for the map", () => {
  const f = fakeFetch([]);
  const feed = new VatsimFeed({ log, fetch: f.fn, wanted: () => false });
  const svc = new NetworkService(feed, sectors(), log);
  const alerts: string[] = [];
  svc.onAlert((a) => alerts.push(a.kind));
  // hand the service a snapshot as if the feed had delivered it
  (feed as unknown as { dataCbs: Array<(s: unknown) => void> }).dataCbs.forEach((cb) =>
    cb({
      updatedAt: 1,
      pilots: [
        { callsign: "ME1", lat: 45, lon: 9, alt: 35000, gs: 480, hdg: 90 },
        { callsign: "OTH", lat: 45.5, lon: 9, alt: 33000, gs: 450, hdg: 270 },
      ],
      controllers: [ctl("XXXX_CTR"), ctl("YYYY_CTR")],
      atis: [],
    }),
  );
  svc.setOwn({ lat: 45, lon: 9, altMsl: 35000, altAgl: 35000, onGround: false, gs: 480, track: 90, vs: 0 } as never);
  svc.evaluate(0);
  const tr = svc.traffic(null)!;
  assert.equal(tr.you, "ME1");
  assert.deepEqual(tr.pilots.map((p) => p.callsign), ["OTH"]);
  assert.deepEqual(svc.traffic({ lat: 0, lon: 0, radiusNm: 50 })!.pilots, [], "the client's own area wins");
  assert.equal(svc.position().current?.callsign, "XXXX_CTR");
  assert.deepEqual(alerts, ["ahead"]);
  const geo = svc.boundaries(["fir:XXXX", "nope"]) as { features: unknown[] };
  assert.equal(geo.features.length, 1);
  svc.setOwn(null);
  assert.equal(svc.position().current, null);
});
