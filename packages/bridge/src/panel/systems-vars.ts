import type { EngineKind, SystemsSnapshot } from "@vbuddy/protocol";

/**
 * The simulator variables behind the Systems page, ported from Cobalt's SimVarMap: the same names, units, data
 * types, transforms and group split. Every one of these exists for every aircraft (indexed engine variables read 0
 * when the engine is absent), which is what lets one positional read per group work on any aircraft.
 * Order inside a group matters: a group is read back in exactly this order.
 */
export type VarType = "f64" | "i32" | "s32";
export interface VarDef {
  name: string;
  unit: string;
  type: VarType;
  /** Dot path into the systems snapshot. */
  path: string;
  isBool?: boolean;
  transform?: (v: number) => number;
  /** Custom applier for values that touch several fields. */
  apply?: (s: SystemsSnapshot, raw: number) => void;
}

export const roundTo = (v: number, d: number) => {
  const f = 10 ** d;
  return Math.round(v * f) / f;
};
const round1 = (v: number) => roundTo(v, 1);
const round2 = (v: number) => roundTo(v, 2);
const round3 = (v: number) => roundTo(v, 3);
const round6 = (v: number) => roundTo(v, 6);
const toInt = (v: number) => Math.round(v);
export const rankineToCelsius = (r: number) => (r - 491.67) * (5 / 9);
const egtC = (v: number) => roundTo(rankineToCelsius(v), 0);
/** AUTOPILOT * SLOT INDEX: 1 when the FCU window is selected, 2 when managed. */
export const slotSelected = (v: number) => (Math.round(v) === 2 ? 0 : 1);
const normDegInt = (v: number) => ((Math.round(v) % 360) + 360) % 360;
/** The sim stores the squawk as binary-coded octal (0x4521 for 4521). */
export function squawkFromBcd16(bcd: number): number {
  return ((bcd >> 12) & 0xf) * 1000 + ((bcd >> 8) & 0xf) * 100 + ((bcd >> 4) & 0xf) * 10 + (bcd & 0xf);
}
const metersToNm = (m: number) => m / 1852;

/** Time compression; also keeps the highest rate used while airborne (reset on the ground). Ignores misreads. */
export function applySimRate(s: SystemsSnapshot, raw: number) {
  const rate = roundTo(raw, 2);
  if (!Number.isFinite(rate) || rate < 0.05 || rate > 32) return;
  s.meta.simRate = rate;
  s.meta.maxSimRate = s.meta.onGround ? Math.max(1, rate) : Math.max(s.meta.maxSimRate, rate);
}

/**
 * LIGHT ON STATES: many airliners (Airbus especially) drive lights through circuits or potentiometers, so the plain
 * switch variables can read 0 while the light is on. OR the real on-states over the switch reads (which come first
 * in the same group). Bits: 0x01 nav, 0x02 beacon, 0x04 landing, 0x08 taxi, 0x10 strobe, 0x100 logo, 0x200 cabin.
 */
export function applyLightOnStates(s: SystemsSnapshot, raw: number) {
  const bits = Math.round(raw);
  const l = s.lights;
  l.nav ||= (bits & 0x0001) !== 0;
  l.beacon ||= (bits & 0x0002) !== 0;
  l.landing ||= (bits & 0x0004) !== 0;
  l.taxi ||= (bits & 0x0008) !== 0;
  l.strobe ||= (bits & 0x0010) !== 0;
  l.logo ||= (bits & 0x0100) !== 0;
  l.cabin ||= (bits & 0x0200) !== 0;
}

/** ENGINE TYPE: 0 piston, 1 jet, 2 none, 3 helicopter turbine, 4 unsupported, 5 turboprop. */
export function engineKind(raw: number): EngineKind {
  switch (Math.round(raw)) {
    case 0:
      return "piston";
    case 1:
      return "jet";
    case 2:
      return "none";
    case 5:
      return "turboprop";
    default:
      return "unknown";
  }
}

type Slot = "eng1" | "eng2" | "eng3" | "eng4";
const slot = (n: number) => `eng${n}` as Slot;

/**
 * Engine type, then RPM and torque. RPM source depends on the engine: pistons use GENERAL ENG RPM (the cockpit tach),
 * turboprops PROP RPM (Np); jets keep 0 so no fake gauge is drawn. ENGINE TYPE comes first so the kind is current
 * when the RPM values of the same read are applied.
 */
function engineTypeAndRpmVars(n: number): VarDef[] {
  const e = slot(n);
  return [
    { name: `ENGINE TYPE:${n}`, unit: "enum", type: "i32", path: `engines.${e}.engineType`, apply: (s, raw) => void (s.engines[e].engineType = engineKind(raw)) },
    {
      name: `GENERAL ENG RPM:${n}`,
      unit: "rpm",
      type: "f64",
      path: `engines.${e}.rpm`,
      apply: (s, raw) => {
        const eng = s.engines[e];
        if (eng.engineType === "piston") eng.rpm = Math.round(raw);
        else if (eng.engineType !== "turboprop") eng.rpm = 0;
      },
    },
    {
      name: `PROP RPM:${n}`,
      unit: "rpm",
      type: "f64",
      path: `engines.${e}.rpm`,
      apply: (s, raw) => {
        const eng = s.engines[e];
        if (eng.engineType === "turboprop") eng.rpm = Math.round(raw);
      },
    },
    { name: `TURB ENG MAX TORQUE PERCENT:${n}`, unit: "percent", type: "f64", path: `engines.${e}.torquePct`, transform: round1 },
  ];
}

const fastEngine = (n: number): VarDef[] => {
  const e = slot(n);
  return [
    { name: `TURB ENG N1:${n}`, unit: "percent", type: "f64", path: `engines.${e}.n1`, transform: round1 },
    { name: `TURB ENG N2:${n}`, unit: "percent", type: "f64", path: `engines.${e}.n2`, transform: round1 },
    { name: `ENG COMBUSTION:${n}`, unit: "bool", type: "i32", path: `engines.${e}.running`, isBool: true },
    { name: `ENG EXHAUST GAS TEMPERATURE:${n}`, unit: "rankine", type: "f64", path: `engines.${e}.egt`, transform: egtC },
    { name: `ENG FUEL FLOW GPH:${n}`, unit: "gallons per hour", type: "f64", path: `engines.${e}.fuelFlow`, transform: round1 },
  ];
};
const slowEngine = (n: number): VarDef[] => {
  const e = slot(n);
  return [
    { name: `ENG OIL TEMPERATURE:${n}`, unit: "rankine", type: "f64", path: `engines.${e}.oilTemp`, transform: egtC },
    { name: `ENG OIL PRESSURE:${n}`, unit: "psi", type: "f64", path: `engines.${e}.oilPressure`, transform: round1 },
    { name: `TURB ENG VIBRATION:${n}`, unit: "number", type: "f64", path: `engines.${e}.vibration`, transform: round2 },
    { name: `ENG ANTI ICE:${n}`, unit: "bool", type: "i32", path: `engines.${e}.antiIce`, isBool: true },
  ];
};

/** Engines spool fast: read every few frames. */
export const HIGH_VARS: VarDef[] = [
  { name: "SIM ON GROUND", unit: "bool", type: "i32", path: "meta.onGround", isBool: true },
  ...[1, 2, 3, 4].flatMap(fastEngine),
];

/** Autopilot, fuel, pressurization, electrical, surfaces, navigation, lights: a few times a second. */
export const MED_VARS: VarDef[] = [
  { name: "NUMBER OF ENGINES", unit: "number", type: "i32", path: "engines.count", transform: (v) => Math.min(4, Math.max(1, Math.round(v))) },
  ...[1, 2, 3, 4].flatMap(slowEngine),
  ...[1, 2, 3, 4].flatMap(engineTypeAndRpmVars),
  // Autopilot
  { name: "AUTOPILOT MASTER", unit: "bool", type: "i32", path: "autopilot.apMaster", isBool: true },
  { name: "AUTOPILOT FLIGHT DIRECTOR ACTIVE", unit: "bool", type: "i32", path: "autopilot.fdActive", isBool: true },
  { name: "AUTOPILOT ALTITUDE LOCK", unit: "bool", type: "i32", path: "autopilot.apAltHold", isBool: true },
  { name: "AUTOPILOT ALTITUDE LOCK VAR", unit: "feet", type: "f64", path: "autopilot.apAltTarget", transform: toInt },
  { name: "AUTOPILOT HEADING LOCK", unit: "bool", type: "i32", path: "autopilot.apHDGHold", isBool: true },
  { name: "AUTOPILOT HEADING LOCK DIR", unit: "degrees", type: "f64", path: "autopilot.apHDGTarget", transform: normDegInt },
  { name: "AUTOPILOT AIRSPEED HOLD", unit: "bool", type: "i32", path: "autopilot.apSpdHold", isBool: true },
  { name: "AUTOPILOT AIRSPEED HOLD VAR", unit: "knots", type: "f64", path: "autopilot.apSpdTarget", transform: toInt },
  { name: "AUTOPILOT MACH HOLD", unit: "bool", type: "i32", path: "autopilot.apMachHold", isBool: true },
  { name: "AUTOPILOT MACH HOLD VAR", unit: "mach", type: "f64", path: "autopilot.apMachTarget", transform: round3 },
  { name: "AUTOPILOT VERTICAL HOLD", unit: "bool", type: "i32", path: "autopilot.apVSHold", isBool: true },
  { name: "AUTOPILOT VERTICAL HOLD VAR", unit: "feet per minute", type: "f64", path: "autopilot.apVSTarget", transform: toInt },
  { name: "AUTOPILOT NAV1 LOCK", unit: "bool", type: "i32", path: "autopilot.apNAVHold", isBool: true },
  { name: "AUTOPILOT APPROACH HOLD", unit: "bool", type: "i32", path: "autopilot.apAPRHold", isBool: true },
  { name: "AUTOPILOT GLIDESLOPE HOLD", unit: "bool", type: "i32", path: "autopilot.apGSHold", isBool: true },
  { name: "AUTOPILOT WING LEVELER", unit: "bool", type: "i32", path: "autopilot.apWingLeveler", isBool: true },
  { name: "AUTOPILOT FLIGHT LEVEL CHANGE", unit: "bool", type: "i32", path: "autopilot.apFLCActive", isBool: true },
  { name: "AUTOTHROTTLE ACTIVE", unit: "bool", type: "i32", path: "autopilot.autothrottleActive", isBool: true },
  { name: "AUTOPILOT THROTTLE ARM", unit: "bool", type: "i32", path: "autopilot.autothrottleArmed", isBool: true },
  // Stock Airbus FCU managed/selected (Fenix and FlyByWire overlay their own).
  { name: "AUTOPILOT SPEED SLOT INDEX", unit: "number", type: "f64", path: "autopilot.fcuSpeedSelected", transform: slotSelected, isBool: true },
  { name: "AUTOPILOT HEADING SLOT INDEX", unit: "number", type: "f64", path: "autopilot.fcuHeadingSelected", transform: slotSelected, isBool: true },
  { name: "AUTOPILOT ALTITUDE SLOT INDEX", unit: "number", type: "f64", path: "autopilot.fcuAltSelected", transform: slotSelected, isBool: true },
  { name: "AUTOPILOT VS SLOT INDEX", unit: "number", type: "f64", path: "autopilot.fcuVSSelected", transform: slotSelected, isBool: true },
  // Fuel: LEFT/RIGHT QUANTITY add up every tank on that side, which works on any aircraft.
  { name: "FUEL TOTAL QUANTITY", unit: "gallons", type: "f64", path: "fuel.totalGal", transform: round1 },
  { name: "FUEL TOTAL QUANTITY WEIGHT", unit: "pounds", type: "f64", path: "fuel.totalLbs", transform: toInt },
  { name: "FUEL LEFT QUANTITY", unit: "gallons", type: "f64", path: "fuel.left", transform: round1 },
  { name: "FUEL RIGHT QUANTITY", unit: "gallons", type: "f64", path: "fuel.right", transform: round1 },
  { name: "FUEL TANK CENTER QUANTITY", unit: "gallons", type: "f64", path: "fuel.center", transform: round1 },
  { name: "FUEL TOTAL CAPACITY", unit: "gallons", type: "f64", path: "fuel.capacity", transform: round1 },
  { name: "FUEL WEIGHT PER GALLON", unit: "pounds", type: "f64", path: "fuel.weightPerGal", transform: round2 },
  // Pressurization
  { name: "PRESSURIZATION CABIN ALTITUDE", unit: "feet", type: "f64", path: "pressurization.cabinAlt", transform: toInt },
  { name: "PRESSURIZATION PRESSURE DIFFERENTIAL", unit: "psi", type: "f64", path: "pressurization.diffPressure", transform: round2 },
  { name: "PRESSURIZATION CABIN ALTITUDE RATE", unit: "feet per minute", type: "f64", path: "pressurization.cabinRate", transform: toInt },
  // Electrical and hydraulics
  { name: "ELECTRICAL MAIN BUS VOLTAGE", unit: "volts", type: "f64", path: "electrical.busVoltage", transform: round1 },
  { name: "ELECTRICAL BATTERY VOLTAGE", unit: "volts", type: "f64", path: "electrical.batteryVoltage", transform: round1 },
  { name: "EXTERNAL POWER ON", unit: "bool", type: "i32", path: "electrical.extPower", isBool: true },
  { name: "APU SWITCH", unit: "bool", type: "i32", path: "electrical.apuSwitch", isBool: true },
  { name: "APU GENERATOR SWITCH:1", unit: "bool", type: "i32", path: "electrical.apuGenActive", isBool: true },
  { name: "HYDRAULIC PRESSURE:1", unit: "psi", type: "f64", path: "electrical.hydPressure1", transform: toInt },
  { name: "HYDRAULIC PRESSURE:2", unit: "psi", type: "f64", path: "electrical.hydPressure2", transform: toInt },
  // Surfaces
  { name: "FLAPS HANDLE INDEX", unit: "number", type: "i32", path: "surfaces.flapsHandle", transform: toInt },
  { name: "FLAPS NUM HANDLE POSITIONS", unit: "number", type: "i32", path: "surfaces.flapsDetents", transform: toInt },
  { name: "TRAILING EDGE FLAPS LEFT PERCENT", unit: "percent", type: "f64", path: "surfaces.flapsLeft", transform: round1 },
  { name: "SPOILERS HANDLE POSITION", unit: "percent", type: "f64", path: "surfaces.spoilers", transform: round1 },
  { name: "SPOILERS ARMED", unit: "bool", type: "i32", path: "surfaces.spoilersArmed", isBool: true },
  { name: "GEAR HANDLE POSITION", unit: "bool", type: "i32", path: "surfaces.gearHandle", isBool: true },
  { name: "GEAR TOTAL PCT EXTENDED", unit: "percent", type: "f64", path: "surfaces.gearExtended", transform: round1 },
  { name: "GEAR LEFT POSITION", unit: "percent over 100", type: "f64", path: "surfaces.gearLeft", transform: (v) => roundTo(v * 100, 0) },
  { name: "GEAR RIGHT POSITION", unit: "percent over 100", type: "f64", path: "surfaces.gearRight", transform: (v) => roundTo(v * 100, 0) },
  { name: "GEAR CENTER POSITION", unit: "percent over 100", type: "f64", path: "surfaces.gearNose", transform: (v) => roundTo(v * 100, 0) },
  // Navigation, GPS and radios
  { name: "GPS WP NEXT LAT", unit: "degrees", type: "f64", path: "navigation.wpNextLat", transform: round6 },
  { name: "GPS WP NEXT LON", unit: "degrees", type: "f64", path: "navigation.wpNextLon", transform: round6 },
  { name: "GPS WP NEXT ID", unit: "", type: "s32", path: "navigation.wpNextId" },
  { name: "GPS WP DISTANCE", unit: "meters", type: "f64", path: "navigation.wpDistanceNm", transform: (v) => roundTo(metersToNm(v), 1) },
  { name: "GPS WP ETE", unit: "seconds", type: "f64", path: "navigation.wpEteSec", transform: toInt },
  { name: "GPS ETE", unit: "seconds", type: "f64", path: "navigation.destEteSec", transform: toInt },
  { name: "GPS FLIGHT PLAN WP COUNT", unit: "number", type: "i32", path: "navigation.wpCount", transform: toInt },
  { name: "GPS FLIGHT PLAN WP INDEX", unit: "number", type: "i32", path: "navigation.wpIndex", transform: toInt },
  { name: "NAV ACTIVE FREQUENCY:1", unit: "MHz", type: "f64", path: "navigation.nav1Active", transform: round3 },
  { name: "COM ACTIVE FREQUENCY:1", unit: "MHz", type: "f64", path: "navigation.com1Active", transform: round3 },
  { name: "COM STANDBY FREQUENCY:1", unit: "MHz", type: "f64", path: "navigation.com1Standby", transform: round3 },
  { name: "COM ACTIVE FREQUENCY:2", unit: "MHz", type: "f64", path: "navigation.com2Active", transform: round3 },
  { name: "COM STANDBY FREQUENCY:2", unit: "MHz", type: "f64", path: "navigation.com2Standby", transform: round3 },
  { name: "KOHLSMAN SETTING MB:1", unit: "millibars", type: "f64", path: "navigation.baroMb", transform: round1 },
  { name: "TRANSPONDER CODE:1", unit: "BCO16", type: "i32", path: "navigation.xpdrCode", transform: squawkFromBcd16 },
  { name: "TRANSPONDER STATE:1", unit: "number", type: "i32", path: "navigation.xpdrState", transform: toInt },
  // Lights (switch variables first; LIGHT ON STATES is ORed over them)
  { name: "LIGHT BEACON", unit: "bool", type: "i32", path: "lights.beacon", isBool: true },
  { name: "LIGHT NAV", unit: "bool", type: "i32", path: "lights.nav", isBool: true },
  { name: "LIGHT STROBE", unit: "bool", type: "i32", path: "lights.strobe", isBool: true },
  { name: "LIGHT LANDING", unit: "bool", type: "i32", path: "lights.landing", isBool: true },
  { name: "LIGHT TAXI", unit: "bool", type: "i32", path: "lights.taxi", isBool: true },
  { name: "LIGHT LOGO", unit: "bool", type: "i32", path: "lights.logo", isBool: true },
  { name: "LIGHT CABIN", unit: "bool", type: "i32", path: "lights.cabin", isBool: true },
  { name: "LIGHT ON STATES", unit: "mask", type: "i32", path: "lights.beacon", apply: applyLightOnStates },
  { name: "SIMULATION RATE", unit: "number", type: "f64", path: "meta.simRate", apply: applySimRate },
  { name: "CABIN SEATBELTS ALERT SWITCH", unit: "bool", type: "i32", path: "systems.seatbeltSign", isBool: true },
  { name: "PITOT HEAT", unit: "bool", type: "i32", path: "systems.pitotHeat", isBool: true },
];

/** Weight, doors, brakes, warnings and the weather: once a second. */
export const LOW_VARS: VarDef[] = [
  { name: "TOTAL WEIGHT", unit: "pounds", type: "f64", path: "weight.grossWeight", transform: toInt },
  // EXIT OPEN is a fraction; more than 5% counts as open.
  ...[1, 2, 3, 4].map((i): VarDef => ({ name: `EXIT OPEN:${i}`, unit: "percent over 100", type: "f64", path: `doors.door${i}`, isBool: true, transform: (v) => (v > 0.05 ? 1 : 0) })),
  { name: "BRAKE PARKING INDICATOR", unit: "bool", type: "i32", path: "surfaces.parkingBrake", isBool: true },
  { name: "STALL WARNING", unit: "bool", type: "i32", path: "warnings.stallWarning", isBool: true },
  { name: "OVERSPEED WARNING", unit: "bool", type: "i32", path: "warnings.overspeedWarning", isBool: true },
  { name: "MASTER CAUTION ACTIVE", unit: "bool", type: "i32", path: "warnings.masterCaution", isBool: true },
  { name: "MASTER WARNING ACTIVE", unit: "bool", type: "i32", path: "warnings.masterWarning", isBool: true },
  { name: "AMBIENT TEMPERATURE", unit: "celsius", type: "f64", path: "environment.oat", transform: round1 },
  { name: "AMBIENT WIND VELOCITY", unit: "knots", type: "f64", path: "environment.windSpeed", transform: round1 },
  { name: "AMBIENT WIND DIRECTION", unit: "degrees", type: "f64", path: "environment.windDir", transform: toInt },
  // Sea-level pressure (QNH), not the static pressure at the aircraft.
  { name: "SEA LEVEL PRESSURE", unit: "millibars", type: "f64", path: "environment.qnh", transform: round1 },
];

/* ------------------------------------------------------------------ aircraft profiles */

export type SystemsProfile = "stock" | "fenixA320" | "fbwA32nx" | "pmdg737" | "iFly737Max" | "studyCustom";

/** Which profile an aircraft title belongs to (Cobalt's detectAircraftProfile). */
export function detectAircraftProfile(title: string): SystemsProfile {
  const t = (title || "").toLowerCase();
  if (t.includes("fenix") || t.includes("fnx")) return "fenixA320";
  if (t.includes("flybywire") || t.includes("fbw") || t.includes("a32nx") || t.includes("a380x")) return "fbwA32nx";
  if (t.includes("pmdg") && /73\d/.test(t)) return "pmdg737";
  if (t.includes("asobo") || /a320\s?neo/.test(t)) return "stock";
  if (t.includes("ifly") && (/73\d/.test(t) || t.includes("max"))) return "iFly737Max";
  if (["inibuilds", "ini builds", "a300", "a310", "toliss", "flightsimlabs", "fslabs"].some((k) => t.includes(k))) return "studyCustom";
  return "stock";
}

export interface Overlay {
  lvar: string;
  path: string;
  /** Owns the path: the stock variable is read but not applied. */
  always: boolean;
  boolean?: boolean;
  invert?: boolean;
}

/**
 * Study aircraft whose stock variables are wrong: their own cockpit variables (LVars) are read about once a second
 * and laid over the stock values. Fenix: the FCU windows, managed dots, button lights and switches.
 * FlyByWire: the managed dots and button lights (it mirrors its targets into the stock variables).
 */
export function profileOverlays(p: SystemsProfile): Overlay[] {
  if (p === "fenixA320")
    return [
      { lvar: "N_FCU_ALTITUDE", path: "autopilot.apAltTarget", always: true },
      { lvar: "N_FCU_HEADING", path: "autopilot.apHDGTarget", always: true },
      { lvar: "N_FCU_SPEED", path: "autopilot.apSpdTarget", always: true },
      { lvar: "N_FCU_VS", path: "autopilot.apVSTarget", always: true },
      { lvar: "I_FCU_HEADING_MANAGED", path: "autopilot.fcuHeadingSelected", always: true, boolean: true, invert: true },
      { lvar: "I_FCU_SPEED_MANAGED", path: "autopilot.fcuSpeedSelected", always: true, boolean: true, invert: true },
      { lvar: "I_FCU_ALTITUDE_MANAGED", path: "autopilot.fcuAltSelected", always: true, boolean: true, invert: true },
      { lvar: "I_FCU_AP1", path: "autopilot.apMaster", always: true, boolean: true },
      { lvar: "I_FCU_ATHR", path: "autopilot.autothrottleArmed", always: true, boolean: true },
      { lvar: "I_FCU_APPR", path: "autopilot.apAPRHold", always: true, boolean: true },
      // Speedbrake lever: 0 = ARM, so "armed" is the lever NOT above 0.5.
      { lvar: "A_FC_SPEEDBRAKE", path: "surfaces.spoilersArmed", always: true, boolean: true, invert: true },
      { lvar: "S_MIP_PARKING_BRAKE", path: "surfaces.parkingBrake", always: true, boolean: true },
      { lvar: "S_OH_SIGNS", path: "systems.seatbeltSign", always: true, boolean: true },
      { lvar: "S_OH_PROBE_HEAT", path: "systems.pitotHeat", always: true, boolean: true },
      { lvar: "S_OH_ELEC_APU_MASTER", path: "electrical.apuSwitch", always: true, boolean: true },
    ];
  if (p === "fbwA32nx")
    return [
      { lvar: "A32NX_FCU_AFS_DISPLAY_SPD_MACH_MANAGED", path: "autopilot.fcuSpeedSelected", always: true, boolean: true, invert: true },
      { lvar: "A32NX_FCU_AFS_DISPLAY_HDG_TRK_MANAGED", path: "autopilot.fcuHeadingSelected", always: true, boolean: true, invert: true },
      { lvar: "A32NX_FCU_AFS_DISPLAY_LVL_CH_MANAGED", path: "autopilot.fcuAltSelected", always: true, boolean: true, invert: true },
      { lvar: "A32NX_FCU_AP_1_LIGHT_ON", path: "autopilot.apMaster", always: true, boolean: true },
      { lvar: "A32NX_FCU_ATHR_LIGHT_ON", path: "autopilot.autothrottleArmed", always: true, boolean: true },
      { lvar: "A32NX_FCU_LOC_LIGHT_ON", path: "autopilot.apNAVHold", always: true, boolean: true },
      { lvar: "A32NX_FCU_APPR_LIGHT_ON", path: "autopilot.apAPRHold", always: true, boolean: true },
    ];
  return [];
}

/** Same rounding as the stock variables, for overlay numbers. */
export function displayTransform(path: string, raw: number): number {
  if (path === "autopilot.apHDGTarget") return ((Math.round(raw) % 360) + 360) % 360;
  if (path === "autopilot.apMachTarget") return roundTo(raw, 3);
  return Math.round(raw);
}

/* ------------------------------------------------------------------ dot paths */

export function assignPath(state: object, path: string, value: unknown) {
  const seg = path.split(".");
  let t = state as Record<string, unknown>;
  for (let i = 0; i < seg.length - 1; i++) {
    const next = t[seg[i]!];
    if (typeof next !== "object" || next === null) return;
    t = next as Record<string, unknown>;
  }
  const leaf = seg[seg.length - 1]!;
  if (leaf in t) t[leaf] = value;
}

/** The part of a raw data buffer the reader needs. */
export interface ReadBuf {
  readFloat64(): number;
  readInt32(): number;
  readString32(): string;
}

/** Read one group back in definition order and apply it (Cobalt's readGroup). */
export function readGroup(s: SystemsSnapshot, data: ReadBuf, defs: VarDef[], overlaid: Set<string>) {
  for (const d of defs) {
    if (d.type === "s32") {
      assignPath(s, d.path, data.readString32().trim());
      continue;
    }
    const raw = d.type === "i32" ? data.readInt32() : data.readFloat64();
    if (d.apply) {
      d.apply(s, raw);
      continue;
    }
    if (overlaid.has(d.path)) continue;
    const v = d.transform ? d.transform(raw) : raw;
    assignPath(s, d.path, d.isBool ? v !== 0 : v);
  }
}
