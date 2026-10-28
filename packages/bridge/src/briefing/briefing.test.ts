import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseMetar, flightCategory } from "./metar.js";
import { mapOfp, simbriefUrl } from "./simbrief.js";
import { BriefingService } from "./service.js";
import { fetchWeather, type Fetcher } from "./weather.js";
import { IntegrationStore } from "../integrations/store.js";

const NOW = Date.UTC(2026, 9, 13, 12, 0);

test("metar: wind, visibility, clouds, temperature, pressure", () => {
  const m = parseMetar("METAR EGLL 131150Z 24012G24KT 9999 -RA FEW008 BKN014 OVC025 12/10 Q1008 NOSIG", NOW);
  assert.equal(m.station, "EGLL");
  assert.equal(m.observedAt, Date.UTC(2026, 9, 13, 11, 50));
  assert.equal(m.windDir, 240);
  assert.equal(m.windKt, 12);
  assert.equal(m.gustKt, 24);
  assert.equal(m.visM, 9999);
  assert.deepEqual(m.weather, ["-RA"]);
  assert.equal(m.ceilingFt, 1400);
  assert.equal(m.tempC, 12);
  assert.equal(m.dewC, 10);
  assert.equal(m.qnhHpa, 1008);
  assert.equal(m.category, "MVFR");
});

test("metar: US format, fractions, negative temperatures, calm, CAVOK, variable", () => {
  const us = parseMetar("KJFK 131151Z 00000KT 1 1/2SM BR OVC004 M02/M03 A2992 RMK AO2 SLP132", NOW);
  assert.equal(us.windKt, 0);
  assert.equal(us.windDir, null);
  assert.equal(us.visM, Math.round(1.5 * 1609.34));
  assert.equal(us.ceilingFt, 400);
  assert.equal(us.tempC, -2);
  assert.equal(us.dewC, -3);
  assert.equal(us.qnhHpa, 1013);
  assert.equal(us.category, "LIFR");
  const cav = parseMetar("LFPG 131200Z VRB02KT CAVOK 21/09 Q1021", NOW);
  assert.equal(cav.windDir, "VRB");
  assert.equal(cav.visM, 9999);
  assert.equal(cav.category, "VFR");
  const quarter = parseMetar("KSFO 131156Z 28008KT M1/4SM FG VV002 12/12 A3001", NOW);
  assert.equal(quarter.visM, Math.round(1609.34 / 4));
  assert.equal(quarter.ceilingFt, 200);
});

test("metar: trend and remarks don't leak into the report", () => {
  const m = parseMetar("EDDF 131150Z 25005KT 9999 SCT040 15/08 Q1015 TEMPO 3000 RA BKN008", NOW);
  assert.equal(m.ceilingFt, null);
  assert.equal(m.category, "VFR");
  assert.equal(flightCategory(null, null), null);
});

const OFP = {
  general: { icao_airline: "QTR", flight_number: "1", route: "OMDB DCT PEXEM UL425 LAKUM", route_distance: "1170", initial_altitude: "36000", passengers: "0" },
  params: { units: "LBS", time_generated: "1760356800" },
  times: { sched_out: "1760360400", est_time_enroute: "9000" },
  fuel: { plan_ramp: "20000", enroute_burn: "14000" },
  weights: { est_zfw: "100000", est_tow: "120000", pax_count: "150" },
  aircraft: { icaocode: "A320" },
  atc: { callsign: "QTR1" },
  origin: { icao_code: "OMDB", name: "Dubai Intl", elevation: "62", plan_rwy: "30R" },
  destination: { icao_code: "OTHH", name: "Hamad Intl", elevation: "13", plan_rwy: "16R" },
  alternate: { icao_code: "OBBI", name: "Bahrain", plan_rwy: "30L" },
  navlog: { fix: [{ ident: "OMDB", pos_lat: "25.25", pos_long: "55.36", altitude_feet: "62", via_airway: "" }, { ident: "PEXEM", pos_lat: "25.5", pos_long: "54.9", altitude_feet: "10000", via_airway: "DCT" }] },
};

test("simbrief: maps the plan, converts pounds, tolerates one alternate object or none", () => {
  const m = mapOfp(OFP)!;
  assert.equal(m.ofp.callsign, "QTR1");
  assert.equal(m.ofp.eteMin, 150);
  assert.equal(m.ofp.blockFuelKg, 9072);
  assert.equal(m.ofp.units, "lbs");
  assert.equal(m.ofp.departAt, 1760360400000);
  assert.deepEqual(m.airports.map((a) => [a.role, a.icao, a.plannedRunway]), [["origin", "OMDB", "30R"], ["destination", "OTHH", "16R"], ["alternate", "OBBI", "30L"]]);
  assert.equal(m.fixes.length, 2);
  assert.equal(m.fixes[1]!.ident, "PEXEM");
  const bare = mapOfp({ ...OFP, alternate: [] })!;
  assert.equal(bare.airports.length, 2);
  assert.equal(mapOfp({ fetch: { status: "Error" } }), null);
  assert.equal(mapOfp("nope"), null);
  assert.equal(simbriefUrl("123456"), "https://www.simbrief.com/api/xml.fetcher.php?userid=123456&json=v2");
  assert.equal(simbriefUrl("j smith"), "https://www.simbrief.com/api/xml.fetcher.php?username=j%20smith&json=v2");
});

function fakeFetch(opts: { ofp?: unknown; ofpStatus?: number; metars?: string; tafs?: string; wxFail?: boolean; fail?: boolean }) {
  const urls: string[] = [];
  const f: Fetcher = async (url) => {
    urls.push(url);
    if (opts.fail) throw new Error("offline");
    if (url.includes("simbrief.com")) return { ok: (opts.ofpStatus ?? 200) < 400, status: opts.ofpStatus ?? 200, text: async () => "", json: async () => opts.ofp };
    if (opts.wxFail) return { ok: false, status: 503, text: async () => "", json: async () => ({}) };
    const body = url.includes("/metar") ? opts.metars ?? "" : opts.tafs ?? "";
    return { ok: true, status: 200, text: async () => body, json: async () => ({}) };
  };
  return { f, urls };
}

const METARS = "OMDB 131200Z 30008KT 6000 NSC 33/12 Q1002\nOTHH 131200Z 36010KT 9999 FEW040 31/08 Q1003\n";
const TAFS = "TAF OTHH 131100Z 1312/1418 36010KT 9999 FEW040\n      BECMG 1314/1316 30015KT\nTAF OMDB 131100Z 1312/1418 30008KT 6000 NSC\n";

test("weather: pairs reports with airports and joins wrapped TAF lines", async () => {
  const { f } = fakeFetch({ metars: METARS, tafs: TAFS });
  const w = await fetchWeather(f, ["OMDB", "OTHH", "OBBI"]);
  assert.equal(w.metar.size, 2);
  assert.match(w.taf.get("OTHH")!, /BECMG/);
  assert.ok(!w.taf.get("OMDB")!.includes("BECMG"));
});

test("briefing: no SimBrief name gives a clear prompt, but an ICAO lookup still works", async () => {
  const { f, urls } = fakeFetch({ metars: METARS, tafs: TAFS });
  const svc = new BriefingService(f, () => "", () => NOW);
  const b = await svc.get({ extra: "othh" });
  assert.equal(b.problem, "no-id");
  assert.equal(b.ofp, null);
  assert.equal(b.airports.length, 1);
  assert.equal(b.airports[0]!.role, "other");
  assert.equal(b.airports[0]!.metar!.windKt, 10);
  assert.ok(!urls.some((u) => u.includes("simbrief")));
});

test("briefing: plan + weather, cached between calls, a missing report is explained", async () => {
  const { f, urls } = fakeFetch({ ofp: OFP, metars: METARS, tafs: TAFS });
  let t = NOW;
  const svc = new BriefingService(f, () => "jsmith", () => t);
  const b = await svc.get();
  assert.equal(b.source, "simbrief");
  assert.equal(b.airports.length, 3);
  assert.equal(b.airports[0]!.metar!.category, "MVFR");
  assert.equal(b.airports[1]!.metar!.category, "VFR");
  assert.equal(b.airports[2]!.metar, null);
  assert.match(b.airports[2]!.weatherError!, /No report/);
  const n = urls.length;
  await svc.get();
  assert.equal(urls.length, n, "second call within the cache window makes no requests");
  t += 6 * 60_000;
  await svc.get();
  assert.ok(urls.length > n, "stale cache refetches");
  const before = urls.length;
  await svc.get({ refresh: true });
  assert.ok(urls.length > before);
});

test("briefing: SimBrief says no plan / is unreachable / weather is down", async () => {
  const nf = new BriefingService(fakeFetch({ ofpStatus: 400 }).f, () => "ghost", () => NOW);
  assert.equal((await nf.get()).problem, "not-found");
  const empty = new BriefingService(fakeFetch({ ofp: { fetch: { status: "Error: Unknown UserID" } } }).f, () => "ghost", () => NOW);
  assert.equal((await empty.get()).problem, "not-found");
  const off = new BriefingService(fakeFetch({ fail: true }).f, () => "jsmith", () => NOW);
  const b = await off.get();
  assert.equal(b.problem, "unreachable");
  const wx = new BriefingService(fakeFetch({ ofp: OFP, wxFail: true }).f, () => "jsmith", () => NOW);
  const w = await wx.get();
  assert.equal(w.source, "simbrief");
  assert.match(w.airports[0]!.weatherError!, /weather service/);
});

test("integrations: validates, saves privately, reloads, changes only what is sent", () => {
  const file = join(mkdtempSync(join(tmpdir(), "vb-int-")), "integrations.json");
  const s = new IntegrationStore(file);
  assert.deepEqual(s.get(), { simbrief: "", hoppie: "", owm: "", sayintentions: "", beyondatc: true });
  assert.equal(s.set({ simbrief: "  jsmith " }), null);
  assert.equal(s.set({ hoppie: "AbC123xyz9" }), null);
  assert.ok(s.set({ simbrief: "bad/name?" })!.includes("SimBrief"));
  assert.ok(s.set({ hoppie: "short" })!.includes("Hoppie"));
  assert.equal(s.get().simbrief, "jsmith");
  assert.equal(new IntegrationStore(file).get().hoppie, "AbC123xyz9");
  assert.equal(s.set({ simbrief: "123456" }), null);
  assert.equal(new IntegrationStore(file).get().hoppie, "AbC123xyz9", "untouched field kept");
  assert.equal(s.set({ hoppie: "" }), null);
  assert.equal(new IntegrationStore(file).get().hoppie, "");
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o077, 0);
  assert.ok(readFileSync(file, "utf8").includes("123456"));
  // The AI ATC settings: a developer key, and BeyondATC's log on or off.
  assert.ok(s.set({ sayintentions: "no spaces allowed" })!.includes("SayIntentions"));
  assert.equal(s.set({ sayintentions: " si-dev-1234567 ", beyondatc: false }), null);
  const back = new IntegrationStore(file).get();
  assert.equal(back.sayintentions, "si-dev-1234567");
  assert.equal(back.beyondatc, false);
});
