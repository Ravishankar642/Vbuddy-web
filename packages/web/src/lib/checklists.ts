import type { Telemetry } from "@vbuddy/protocol";

/** What an item can be ticked from automatically: the sim's own state. */
export interface AutoCtx {
  t: Telemetry;
  xpdrAlt: boolean | null;
  enginesRunning: number | null;
}

export interface CheckItem {
  id: string;
  /** "Parking brake" */
  item: string;
  /** "SET" */
  state: string;
  /** Ticks itself when true (and unticks when false again, until you tick it by hand). */
  auto?: (c: AutoCtx) => boolean | null;
}

export interface Checklist {
  id: string;
  title: string;
  items: CheckItem[];
}

export type Family = "airbus" | "boeing" | "generic";

export function familyOf(title: string | null | undefined, model: string | null | undefined): Family {
  const s = `${title ?? ""} ${model ?? ""}`.toUpperCase();
  if (/AIRBUS|FENIX|A3[0-9]{2}|A20N|A21N|FBW|INIBUILDS A3/.test(s)) return "airbus";
  if (/BOEING|PMDG|B7[0-9]{2}|737|747|777|787|B38M|B39M/.test(s)) return "boeing";
  return "generic";
}

const pbSet = (c: AutoCtx) => c.t.parkingBrake;
const pbOff = (c: AutoCtx) => !c.t.parkingBrake;
const gearDown = (c: AutoCtx) => c.t.gearDown;
const gearUp = (c: AutoCtx) => !c.t.gearDown;
const flapsSet = (c: AutoCtx) => c.t.flapsIndex > 0;
const flapsUp = (c: AutoCtx) => c.t.flapsIndex === 0;
const xpdrOn = (c: AutoCtx) => c.xpdrAlt;
const enginesOn = (c: AutoCtx) => (c.enginesRunning === null ? null : c.enginesRunning >= 2);
const enginesOff = (c: AutoCtx) => (c.enginesRunning === null ? null : c.enginesRunning === 0);
const apOff = (c: AutoCtx) => !c.t.ap.master;

/** Normal checklists, short and in the common airline style. Not any manufacturer's or operator's document. */
const COMMON: Record<string, CheckItem[]> = {
  before_start: [
    { id: "brief", item: "Departure briefing", state: "COMPLETE" },
    { id: "fuel", item: "Fuel quantity", state: "CHECKED" },
    { id: "pb", item: "Parking brake", state: "SET", auto: pbSet },
    { id: "doors", item: "Doors", state: "CLOSED" },
    { id: "beacon", item: "Beacon", state: "ON" },
  ],
  before_taxi: [
    { id: "eng", item: "Engines", state: "RUNNING", auto: enginesOn },
    { id: "flaps", item: "Flaps", state: "SET", auto: flapsSet },
    { id: "trim", item: "Trim", state: "SET" },
    { id: "ctl", item: "Flight controls", state: "CHECKED" },
    { id: "taxi", item: "Taxi clearance", state: "RECEIVED" },
  ],
  before_takeoff: [
    { id: "xpdr", item: "Transponder", state: "TA/RA (ALT)", auto: xpdrOn },
    { id: "lights", item: "Landing and strobe lights", state: "ON" },
    { id: "flaps", item: "Flaps", state: "CHECKED", auto: flapsSet },
    { id: "pb", item: "Parking brake", state: "RELEASED", auto: pbOff },
    { id: "clr", item: "Takeoff clearance", state: "RECEIVED" },
  ],
  after_takeoff: [
    { id: "gear", item: "Gear", state: "UP", auto: gearUp },
    { id: "flaps", item: "Flaps", state: "UP", auto: flapsUp },
    { id: "baro", item: "Altimeters", state: "STD (above transition)" },
  ],
  approach: [
    { id: "brief", item: "Approach briefing", state: "COMPLETE" },
    { id: "baro", item: "Altimeters", state: "QNH SET" },
    { id: "atis", item: "ATIS", state: "RECEIVED" },
    { id: "abrk", item: "Autobrake", state: "SET" },
  ],
  landing: [
    { id: "gear", item: "Gear", state: "DOWN", auto: gearDown },
    { id: "flaps", item: "Flaps", state: "LANDING", auto: (c) => c.t.flapsIndex >= 3 },
    { id: "spoilers", item: "Speed brakes", state: "ARMED" },
    { id: "clr", item: "Landing clearance", state: "RECEIVED" },
  ],
  after_landing: [
    { id: "flaps", item: "Flaps", state: "UP", auto: flapsUp },
    { id: "spoilers", item: "Speed brakes", state: "RETRACTED" },
    { id: "xpdr", item: "Transponder", state: "STBY" },
    { id: "lights", item: "Strobe and landing lights", state: "OFF" },
    { id: "ap", item: "Autopilot", state: "OFF", auto: apOff },
  ],
  parking: [
    { id: "pb", item: "Parking brake", state: "SET", auto: pbSet },
    { id: "eng", item: "Engines", state: "OFF", auto: enginesOff },
    { id: "beacon", item: "Beacon", state: "OFF" },
    { id: "fuel", item: "Fuel pumps", state: "OFF" },
  ],
};

const TITLES: Array<[string, string]> = [
  ["before_start", "Before start"],
  ["before_taxi", "Before taxi"],
  ["before_takeoff", "Before takeoff"],
  ["after_takeoff", "After takeoff"],
  ["approach", "Approach"],
  ["landing", "Landing"],
  ["after_landing", "After landing"],
  ["parking", "Parking"],
];

/** Small differences in wording between the two big families. */
function tweak(f: Family, id: string, items: CheckItem[]): CheckItem[] {
  if (f === "airbus") {
    return items.map((i) =>
      i.id === "spoilers" && id === "landing" ? { ...i, item: "Ground spoilers", state: "ARMED" } : i.id === "abrk" ? { ...i, item: "Autobrake", state: "LO / MED" } : i.id === "flaps" && id === "landing" ? { ...i, state: "CONF 3 / FULL" } : i,
    );
  }
  if (f === "boeing") {
    return items.map((i) => (i.id === "flaps" && id === "landing" ? { ...i, state: "30 / 40" } : i.id === "abrk" ? { ...i, state: "1 / 2 / 3" } : i));
  }
  return items.map((i) => (i.id === "xpdr" && id === "before_takeoff" ? { ...i, state: "ALT" } : i));
}

export function checklistsFor(f: Family): Checklist[] {
  return TITLES.map(([id, title]) => ({ id, title, items: tweak(f, id, COMMON[id]!) }));
}

/** Which checklist fits now, from the sim state and whether the flight has taken off. */
export function currentChecklist(t: Telemetry, tookOff: boolean, enginesRunning: number | null): string {
  if (t.onGround) {
    if (tookOff) return t.gs > 3 ? "after_landing" : "parking";
    if (enginesRunning === 0 || (t.gs < 1 && t.parkingBrake && enginesRunning === null)) return "before_start";
    return t.gs > 3 ? "before_takeoff" : "before_taxi";
  }
  if (t.altAgl < 2500 && t.vs < -200) return t.altAgl < 1500 || t.gearDown ? "landing" : "approach";
  if (t.vs < -500 && t.altAgl < 12_000) return "approach";
  return "after_takeoff";
}
