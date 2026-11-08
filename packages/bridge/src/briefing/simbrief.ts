import type { AirportBrief, FuelPlan, OfpSummary, ProfilePoint, RouteFix } from "@vbuddy/protocol";

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() === "" ? null : v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

/** SimBrief returns one object where a list could be, and sometimes an empty array/object for "none". */
function list(v: unknown): Json[] {
  if (Array.isArray(v)) return v.filter(isObj);
  return isObj(v) && Object.keys(v).length ? [v] : [];
}

export function simbriefUrl(id: string): string {
  const q = /^\d+$/.test(id) ? `userid=${encodeURIComponent(id)}` : `username=${encodeURIComponent(id)}`;
  return `https://www.simbrief.com/api/xml.fetcher.php?${q}&json=v2`;
}

export interface MappedOfp {
  ofp: OfpSummary;
  airports: AirportBrief[];
  fixes: RouteFix[];
  /** The planned vertical profile and fuel along the route (departure first), for flight progress. */
  profile: ProfilePoint[];
  fuelPlan: FuelPlan;
}

/** Picks what the app shows out of SimBrief's big OFP document. Anything missing becomes null. */
export function mapOfp(j: unknown): MappedOfp | null {
  if (!isObj(j)) return null;
  const general = isObj(j.general) ? j.general : {};
  const params = isObj(j.params) ? j.params : {};
  const times = isObj(j.times) ? j.times : {};
  const fuel = isObj(j.fuel) ? j.fuel : {};
  const weights = isObj(j.weights) ? j.weights : {};
  const aircraft = isObj(j.aircraft) ? j.aircraft : {};
  const atc = isObj(j.atc) ? j.atc : {};
  const origin = isObj(j.origin) ? j.origin : null;
  const dest = isObj(j.destination) ? j.destination : null;
  if (!origin || !dest) return null;

  const lbs = String(params.units ?? "").toUpperCase().startsWith("LB");
  const kg = (v: unknown) => {
    const n = num(v);
    return n === null ? null : Math.round(lbs ? n * 0.45359237 : n);
  };
  const secs = (v: unknown) => {
    const n = num(v);
    return n === null || n <= 0 ? null : n * 1000;
  };

  const airline = str(general.icao_airline);
  const flightNo = str(general.flight_number);
  const eteS = num(times.est_time_enroute);
  const ofp: OfpSummary = {
    airline,
    flightNumber: flightNo,
    callsign: str(atc.callsign) ?? (airline && flightNo ? airline + flightNo : null),
    aircraft: str(aircraft.icaocode) ?? str(aircraft.base_type),
    route: str(general.route),
    distanceNm: num(general.route_distance) ?? num(general.air_distance),
    eteMin: eteS === null ? null : Math.round(eteS / 60),
    cruiseFt: num(general.initial_altitude) ?? num(general.cruise_altitude),
    departAt: secs(times.sched_out),
    generatedAt: secs(params.time_generated),
    blockFuelKg: kg(fuel.plan_ramp),
    tripFuelKg: kg(fuel.enroute_burn),
    zeroFuelWeightKg: kg(weights.est_zfw),
    takeoffWeightKg: kg(weights.est_tow),
    pax: num(weights.pax_count) ?? num(general.passengers),
    units: lbs ? "lbs" : "kg",
    reg: str(aircraft.reg),
    ofpId: str(params.request_id) ?? str(params.sequence_id) ?? (params.time_generated !== undefined ? `t${str(params.time_generated)}` : null),
  };

  const airport = (a: Json, role: AirportBrief["role"]): AirportBrief => ({
    role,
    icao: (str(a.icao_code) ?? "").toUpperCase(),
    name: str(a.name),
    lat: num(a.pos_lat),
    lon: num(a.pos_long),
    elevationFt: num(a.elevation),
    plannedRunway: str(a.plan_rwy),
    metar: null,
    taf: null,
    weatherError: null,
  });
  const airports: AirportBrief[] = [airport(origin, "origin"), airport(dest, "destination")];
  for (const a of list(j.alternate)) airports.push(airport(a, "alternate"));
  const seen = new Set<string>();
  const uniq = airports.filter((a) => a.icao.length === 4 && !seen.has(a.icao) && !!seen.add(a.icao));
  if (uniq.length < 2) return null;

  const nav = isObj(j.navlog) ? j.navlog : {};
  const fixes: RouteFix[] = list(nav.fix)
    .map((f) => ({ ident: str(f.ident) ?? "", lat: num(f.pos_lat), lon: num(f.pos_long), altFt: num(f.altitude_feet), via: str(f.via_airway) }))
    .filter((f) => f.ident !== "");

  // The vertical profile: SimBrief gives each fix's leg distance, planned altitude, fuel on board and time so far.
  const stageOf = (v: unknown): ProfilePoint["stage"] => {
    const t = String(v ?? "").toUpperCase();
    return t === "CLB" || t === "CRZ" || t === "DSC" ? t : null;
  };
  const profile: ProfilePoint[] = [];
  const oLat = num(origin.pos_lat);
  const oLon = num(origin.pos_long);
  if (oLat !== null && oLon !== null)
    profile.push({ ident: uniq[0]!.icao, lat: oLat, lon: oLon, distNm: 0, altFt: num(origin.elevation) ?? 0, fuelKg: kg(fuel.plan_takeoff), timeMin: 0, stage: "CLB" });
  let dist = 0;
  for (const f of list(nav.fix)) {
    const lat = num(f.pos_lat);
    const lon = num(f.pos_long);
    const ident = str(f.ident);
    if (lat === null || lon === null || ident === null) continue;
    dist += num(f.distance) ?? 0;
    const t = num(f.time_total);
    profile.push({ ident, lat, lon, distNm: dist, altFt: num(f.altitude_feet) ?? profile[profile.length - 1]?.altFt ?? 0, fuelKg: kg(f.fuel_plan_onboard), timeMin: t === null ? null : Math.round(t / 60), stage: stageOf(f.stage), windDeg: num(f.wind_dir), windKt: num(f.wind_spd) });
  }
  const reserveKg = kg(fuel.reserve);
  const alternateKg = kg(fuel.alternate_burn);
  const fuelPlan: FuelPlan = {
    takeoffKg: kg(fuel.plan_takeoff),
    landingKg: kg(fuel.plan_landing),
    reserveKg,
    alternateKg,
    minLandingKg: reserveKg === null ? null : reserveKg + (alternateKg ?? 0),
  };

  return { ofp, airports: uniq, fixes, profile: profile.slice(0, 1500), fuelPlan };
}
