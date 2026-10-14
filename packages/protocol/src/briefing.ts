/** Airport briefing: the SimBrief flight plan plus current weather, as the bridge sends it to the app. */

export type FlightCategory = "VFR" | "MVFR" | "IFR" | "LIFR";

export interface DecodedMetar {
  raw: string;
  station: string;
  /** Epoch ms of the observation (taken from the day/time group; null when it can't be worked out). */
  observedAt: number | null;
  /** Wind direction in degrees; "VRB" when variable; null when calm/missing. */
  windDir: number | "VRB" | null;
  windKt: number | null;
  gustKt: number | null;
  /** Visibility in metres (9999 = 10 km or more); null when missing. */
  visM: number | null;
  /** Lowest broken/overcast/vertical-visibility layer, in feet above the airport. */
  ceilingFt: number | null;
  clouds: Array<{ cover: "FEW" | "SCT" | "BKN" | "OVC" | "VV"; baseFt: number | null; type?: string }>;
  tempC: number | null;
  dewC: number | null;
  /** Pressure in hPa (QNH). Inches of mercury are converted. */
  qnhHpa: number | null;
  weather: string[];
  category: FlightCategory | null;
}

export interface AirportBrief {
  role: "origin" | "destination" | "alternate" | "other";
  icao: string;
  name: string | null;
  elevationFt: number | null;
  plannedRunway: string | null;
  metar: DecodedMetar | null;
  taf: string | null;
  /** Why the weather is missing, in words the pilot can act on. */
  weatherError: string | null;
}

export interface OfpSummary {
  airline: string | null;
  flightNumber: string | null;
  callsign: string | null;
  aircraft: string | null;
  route: string | null;
  distanceNm: number | null;
  /** Estimated time en route, minutes. */
  eteMin: number | null;
  cruiseFt: number | null;
  /** Planned off-blocks time, epoch ms. */
  departAt: number | null;
  generatedAt: number | null;
  blockFuelKg: number | null;
  tripFuelKg: number | null;
  zeroFuelWeightKg: number | null;
  takeoffWeightKg: number | null;
  pax: number | null;
  /** Fuel and weights are in this unit as SimBrief printed them (kg or lbs); the numbers above are converted to kg. */
  units: "kg" | "lbs";
}

export interface RouteFix {
  ident: string;
  lat: number | null;
  lon: number | null;
  altFt: number | null;
  via: string | null;
}

export interface Briefing {
  /** Where the flight plan came from. */
  source: "simbrief" | "none";
  fetchedAt: number;
  ofp: OfpSummary | null;
  airports: AirportBrief[];
  fixes: RouteFix[];
  /** Set when the plan couldn't be loaded; airports may still carry a manually looked-up airport. */
  error: string | null;
  /** "no-id" when the pilot hasn't entered a SimBrief name yet. */
  problem: "no-id" | "not-found" | "unreachable" | null;
}
