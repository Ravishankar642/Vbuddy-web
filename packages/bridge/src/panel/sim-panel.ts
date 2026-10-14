import { familyOf, LIGHT_IDS, type ApButton, type ApKnob, type LightId, type PanelState, type SimStatus, type SysId } from "@vbuddy/protocol";
import { DataRequestFlag, EventFlag, RawBuffer, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type ConnectionHandle } from "node-simconnect";
import type { PanelBackend, PanelResult } from "./backend.js";
import { addonOf, FBW_ALT_INCREMENT, FBW_BUTTON, FBW_SET, fbwValue, IFLY_BUTTON, IFLY_KNOB, incDecClicks, isSelectorKnob, matchName, pmdgPlan } from "./addons.js";

const DEF_PANEL = 70;
const REQ_PANEL = 70;
const EVENT_BASE = 400;
/** A real notification group: SimConnect rejects a group it was never told about. */
const GROUP_PANEL = 62;
const GROUP_PRIORITY_HIGHEST = 1;
const VERIFY_MS = 1200;

/** [simulator variable, unit] in the order they are read. */
const LIGHT_VARS: Record<LightId, string> = {
  nav: "LIGHT NAV ON",
  beacon: "LIGHT BEACON ON",
  strobe: "LIGHT STROBE ON",
  landing: "LIGHT LANDING ON",
  taxi: "LIGHT TAXI ON",
  wing: "LIGHT WING ON",
  logo: "LIGHT LOGO ON",
  recognition: "LIGHT RECOGNITION ON",
  cabin: "LIGHT CABIN ON",
  panel: "LIGHT PANEL ON",
};
const AP_VARS: Array<[string, string]> = [
  ["AUTOPILOT MASTER", "Bool"],
  ["AUTOPILOT FLIGHT DIRECTOR ACTIVE", "Bool"],
  ["AUTOPILOT THROTTLE ARM", "Bool"],
  ["AUTOPILOT AIRSPEED HOLD", "Bool"],
  ["AUTOPILOT FLIGHT LEVEL CHANGE", "Bool"],
  ["AUTOPILOT HEADING LOCK", "Bool"],
  ["AUTOPILOT NAV1 LOCK", "Bool"],
  ["AUTOPILOT APPROACH HOLD", "Bool"],
  ["AUTOPILOT ALTITUDE LOCK", "Bool"],
  ["AUTOPILOT VERTICAL HOLD", "Bool"],
  ["AUTOPILOT MANAGED SPEED IN MACH", "Bool"],
  ["AUTOPILOT AIRSPEED HOLD VAR", "Knots"],
  ["AUTOPILOT MACH HOLD VAR", "Number"],
  ["AUTOPILOT HEADING LOCK DIR", "Degrees"],
  ["AUTOPILOT ALTITUDE LOCK VAR", "Feet"],
  ["AUTOPILOT VERTICAL HOLD VAR", "Feet per minute"],
  ["NAV OBS:1", "Degrees"],
];

/** Aircraft systems and simulator state, read after the autopilot variables. */
const SYS_VARS: Array<[string, string]> = [
  ["FLAPS HANDLE INDEX", "Number"],
  ["FLAPS NUM HANDLE POSITIONS", "Number"],
  ["SPOILERS ARMED", "Bool"],
  ["GEAR HANDLE POSITION", "Bool"],
  ["BRAKE PARKING POSITION", "Bool"],
  ["GENERAL ENG COMBUSTION:1", "Bool"],
  ["GENERAL ENG COMBUSTION:2", "Bool"],
  ["GENERAL ENG COMBUSTION:3", "Bool"],
  ["GENERAL ENG COMBUSTION:4", "Bool"],
  ["NUMBER OF ENGINES", "Number"],
  ["APU SWITCH", "Bool"],
  ["PITOT HEAT", "Bool"],
  ["CABIN SEATBELTS ALERT SWITCH", "Bool"],
  ["KOHLSMAN SETTING MB", "Millibars"],
  ["SIMULATION RATE", "Number"],
  ["CAMERA STATE", "Enum"],
  ["IS SLEW ACTIVE", "Bool"],
  ["AUTOPILOT WING LEVELER", "Bool"],
  ["EXIT OPEN:1", "Percent"],
  ["EXIT OPEN:2", "Percent"],
  ["EXIT OPEN:3", "Percent"],
  ["EXIT OPEN:4", "Percent"],
];
const DEF_CAMERA = 71;
const DEF_FLAPS = 72;
/** Camera moves and the stock events behind them. */
const CAMERA_MOVES: Partial<Record<SysId, string>> = {
  panLeft: "PAN_LEFT",
  panRight: "PAN_RIGHT",
  panUp: "PAN_UP",
  panDown: "PAN_DOWN",
  zoomIn: "ZOOM_IN",
  zoomOut: "ZOOM_OUT",
  viewReset: "VIEW_RESET",
};
const RATE_STEPS = [0.25, 0.5, 1, 2, 4, 8, 16];

const LIGHT_EVENTS: Record<LightId, string> = {
  nav: "TOGGLE_NAV_LIGHTS",
  beacon: "TOGGLE_BEACON_LIGHTS",
  strobe: "STROBES_TOGGLE",
  landing: "LANDING_LIGHTS_TOGGLE",
  taxi: "TOGGLE_TAXI_LIGHTS",
  wing: "TOGGLE_WING_LIGHTS",
  logo: "TOGGLE_LOGO_LIGHTS",
  recognition: "TOGGLE_RECOGNITION_LIGHTS",
  cabin: "TOGGLE_CABIN_LIGHTS",
  panel: "PANEL_LIGHTS_TOGGLE",
};
/** Some add-ons (iniBuilds) only react to their own switch events. Value for "on"; off is 0. Taken from the discovery reports; not all confirmed. */
const INPUT_EVENT_LIGHTS: Partial<Record<LightId, { names: string[]; on: number }>> = {
  nav: { names: ["AIRLINER_LIGHTS_EXT_NAV"], on: 1 },
  beacon: { names: ["AIRLINER_LIGHTS_EXT_BEACON"], on: 1 },
  strobe: { names: ["AIRLINER_LIGHTS_EXT_STROBE"], on: 2 },
  landing: { names: ["AIRLINER_LIGHTS_EXT_LANDING"], on: 1 },
  taxi: { names: ["AIRLINER_LIGHTS_EXT_NOSE"], on: 1 },
  wing: { names: ["AIRLINER_LIGHTS_EXT_WING"], on: 1 },
};
const LABELS: Record<LightId, string> = {
  nav: "Navigation",
  beacon: "Beacon",
  strobe: "Strobe",
  landing: "Landing",
  taxi: "Taxi",
  wing: "Wing",
  logo: "Logo",
  recognition: "Recognition",
  cabin: "Cabin",
  panel: "Panel",
};

const BUTTON_EVENTS: Record<ApButton, { event: string; flag: keyof NonNullable<PanelState["ap"]> }> = {
  cmd: { event: "AP_MASTER", flag: "master" },
  fd: { event: "TOGGLE_FLIGHT_DIRECTOR", flag: "fd" },
  athr: { event: "AUTO_THROTTLE_ARM", flag: "athr" },
  speed: { event: "AP_PANEL_SPEED_HOLD", flag: "speed" },
  lvlChg: { event: "FLIGHT_LEVEL_CHANGE", flag: "lvlChg" },
  hdgSel: { event: "AP_HDG_HOLD", flag: "hdgSel" },
  lnav: { event: "AP_NAV1_HOLD", flag: "lnav" },
  app: { event: "AP_APR_HOLD", flag: "app" },
  altHld: { event: "AP_ALT_HOLD", flag: "altHld" },
  vs: { event: "AP_VS_HOLD", flag: "vs" },
};
const SET_EVENTS: Record<ApKnob, string> = {
  spd: "AP_SPD_VAR_SET",
  hdg: "HEADING_BUG_SET",
  alt: "AP_ALT_VAR_SET_ENGLISH",
  vs: "AP_VS_VAR_SET_ENGLISH",
  crs: "VOR1_SET",
};

interface SimLike {
  onHandle(cb: (h: ConnectionHandle | null) => void): void;
  onStatus(cb: (s: SimStatus) => void): void;
  status(): SimStatus;
  labelSend?(sendId: number, what: string): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const angleDiff = (a: number, b: number) => Math.abs((((a - b) % 360) + 540) % 360 - 180);

/**
 * Lights and the standard autopilot, read from and sent to the simulator with its ordinary variables and events.
 * Every command is checked by watching the matching variable change, so the app can say when an add-on aircraft
 * (PMDG, iFly, ...) ignores the standard commands instead of pretending it worked.
 */
export class SimPanel implements PanelBackend {
  private h: ConnectionHandle | null = null;
  private s: PanelState | null = null;
  private cbs: Array<() => void> = [];
  private ids = new Map<string, number>();
  private inputs = new Map<string, bigint>();
  private inputsFor = "";
  private title = "";
  private note: string | null = null;
  private lastJson = "";

  constructor(private sim: SimLike) {
    sim.onHandle((h) => this.attach(h));
    sim.onStatus((st) => {
      if (st.connected && this.s?.sys && this.s.sys.paused !== st.paused) this.publish({ ...this.s, sys: { ...this.s.sys, paused: st.paused } });
      if (!st.connected) this.publish(null);
      else if (st.aircraftTitle !== this.title) {
        this.title = st.aircraftTitle;
        this.note = null;
        this.refreshInputEvents();
        if (this.s) this.publish({ ...this.s, aircraft: this.title, family: familyOf(this.title) });
      }
    });
  }

  state() {
    return this.s;
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
  private publish(s: PanelState | null) {
    const json = JSON.stringify(s);
    if (json === this.lastJson) return;
    this.lastJson = json;
    this.s = s;
    for (const cb of this.cbs) cb();
  }

  private attach(h: ConnectionHandle | null) {
    this.h = h;
    this.ids.clear();
    this.inputs.clear();
    this.inputsFor = "";
    this.publish(null);
    if (!h) return;
    for (const l of LIGHT_IDS) this.sim.labelSend?.(h.addToDataDefinition(DEF_PANEL, LIGHT_VARS[l], "Bool", SimConnectDataType.FLOAT64), LIGHT_VARS[l]);
    for (const [name, unit] of AP_VARS) this.sim.labelSend?.(h.addToDataDefinition(DEF_PANEL, name, unit, SimConnectDataType.FLOAT64), name);
    for (const [name, unit] of SYS_VARS) this.sim.labelSend?.(h.addToDataDefinition(DEF_PANEL, name, unit, SimConnectDataType.FLOAT64), name);
    h.addToDataDefinition(DEF_CAMERA, "CAMERA STATE", "Enum", SimConnectDataType.FLOAT64);
    h.addToDataDefinition(DEF_FLAPS, "FLAPS HANDLE INDEX", "Number", SimConnectDataType.FLOAT64);
    h.on("simObjectData", (r) => {
      if (r.requestID !== REQ_PANEL || h !== this.h) return;
      const n = [...LIGHT_IDS, ...AP_VARS, ...SYS_VARS].map(() => r.data.readFloat64());
      const lights = Object.fromEntries(LIGHT_IDS.map((l, i) => [l, n[i]! > 0])) as PanelState["lights"];
      const a = n.slice(LIGHT_IDS.length, LIGHT_IDS.length + AP_VARS.length);
      const x = n.slice(LIGHT_IDS.length + AP_VARS.length);
      const title = this.sim.status().aircraftTitle || this.title;
      this.title = title;
      const mach = a[10]! > 0;
      this.publish({
        aircraft: title,
        family: familyOf(title),
        lights,
        ap: {
          master: a[0]! > 0,
          fd: a[1]! > 0,
          athr: a[2]! > 0,
          speed: a[3]! > 0,
          lvlChg: a[4]! > 0,
          hdgSel: a[5]! > 0,
          lnav: a[6]! > 0,
          app: a[7]! > 0,
          altHld: a[8]! > 0,
          vs: a[9]! > 0,
          machMode: mach,
          spd: mach ? Math.round(a[12]! * 100) / 100 : Math.round(a[11]!),
          hdg: Math.round(a[13]!) % 360,
          alt: Math.round(a[14]!),
          vsFpm: Math.round(a[15]!),
          crs: Math.round(a[16]!) % 360,
        },
        note: this.note,
        sys: this.sysFrom(x),
      });
    });
    h.on("inputEventsList", (r) => {
      for (const d of r.inputEventDescriptors) this.inputs.set(d.name, d.inputEventIdHash);
    });
    this.sim.labelSend?.(h.requestDataOnSimObject(REQ_PANEL, DEF_PANEL, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED), "lights and autopilot request");
    this.refreshInputEvents();
  }

  private lastSys: number[] = [];
  /** Camera numbering differs between the two simulators; the generation comes from the simulator's name. */
  private cameraStates(): { cockpit: number; outside: number; drone: number } {
    const major = Number(/\b(\d+)\./.exec(this.sim.status().simName ?? "")?.[1] ?? 12);
    return { cockpit: 2, outside: 3, drone: major >= 12 ? 8 : 4 };
  }

  private sysFrom(x: number[]): NonNullable<PanelState["sys"]> {
    this.lastSys = x;
    const cam = this.cameraStates();
    const state = x[15] ?? 2;
    return {
      flapsIndex: Math.round(x[0] ?? 0),
      flapsCount: Math.round(x[1] ?? 0),
      spoilersArmed: (x[2] ?? 0) > 0,
      gearDown: (x[3] ?? 0) > 0,
      parkingBrake: (x[4] ?? 0) > 0,
      enginesRunning: [x[5], x[6], x[7], x[8]].slice(0, Math.max(0, Math.round(x[9] ?? 0))).filter((v) => (v ?? 0) > 0).length,
      engineCount: Math.round(x[9] ?? 0),
      apuOn: (x[10] ?? 0) > 0,
      pitotHeat: (x[11] ?? 0) > 0,
      seatbelts: (x[12] ?? 0) > 0,
      baroHpa: Math.round((x[13] ?? 0) * 10) / 10,
      paused: this.sim.status().paused,
      simRate: Math.round((x[14] ?? 1) * 100) / 100,
      camera: state === cam.drone ? 2 : state === cam.outside || (state >= 3 && state !== cam.cockpit) ? 1 : 0,
      slew: (x[16] ?? 0) > 0,
      wingLeveler: (x[17] ?? 0) > 0,
      doors: [x[18], x[19], x[20], x[21]].map((v) => Math.round(v ?? 0)),
    };
  }

  /** The simulator's own list of cockpit controls changes with the aircraft. */
  private refreshInputEvents() {
    if (!this.h || this.inputsFor === this.title) return;
    this.inputsFor = this.title;
    this.inputs.clear();
    try {
      this.sim.labelSend?.(this.h.enumerateInputEvents(60), "list of the aircraft's input events");
    } catch {
      /* older simulator: the standard events are all there is */
    }
  }

  private fire(event: string, data: number) {
    const h = this.h;
    if (!h) return false;
    let id = this.ids.get(event);
    if (id === undefined) {
      id = EVENT_BASE + this.ids.size;
      h.mapClientEventToSimEvent(id, event);
      h.addClientEventToNotificationGroup(GROUP_PANEL, id, false);
      h.setNotificationGroupPriority(GROUP_PANEL, GROUP_PRIORITY_HIGHEST);
      this.ids.set(event, id);
    }
    h.transmitClientEvent(SimConnectConstants.OBJECT_ID_USER, id, data, GROUP_PANEL, EventFlag.EVENT_FLAG_DEFAULT);
    return true;
  }

  private async until(test: () => boolean, ms = VERIFY_MS): Promise<boolean> {
    for (let t = 0; t < ms; t += 80) {
      if (test()) return true;
      await sleep(80);
    }
    return test();
  }

  private worked(): PanelResult {
    if (this.note) {
      this.note = null;
      if (this.s) this.publish({ ...this.s, note: null });
    }
    return { ok: true };
  }

  private ignored(what: string): PanelResult {
    const boeing = this.s?.family === "boeing";
    const error = `${what} didn't respond. ${boeing ? "PMDG, iFly and some other add-on aircraft ignore the simulator's standard commands." : "This aircraft may handle it internally."}`;
    this.note = error;
    if (this.s) this.publish({ ...this.s, note: error });
    return { ok: false, error };
  }

  async setLight(id: LightId, on: boolean): Promise<PanelResult> {
    if (!this.h || !this.s) return { ok: false, error: "Simulator not connected." };
    if (this.s.lights[id] === on) return { ok: true };
    this.fire(LIGHT_EVENTS[id], 0);
    if (await this.until(() => this.s?.lights[id] === on)) return this.worked();
    // Add-on switches: try the aircraft's own input event if it has one.
    const alt = INPUT_EVENT_LIGHTS[id];
    const hash = alt?.names.map((n) => this.inputs.get(n)).find((x) => x !== undefined);
    if (alt && hash !== undefined) {
      this.h.setInputEvent(hash, on ? alt.on : 0);
      if (await this.until(() => this.s?.lights[id] === on)) return this.worked();
    }
    return this.ignored(`The ${LABELS[id].toLowerCase()} light`);
  }

  async press(ctl: ApButton): Promise<PanelResult> {
    if (!this.h || !this.s?.ap) return { ok: false, error: "This aircraft isn't reporting its autopilot." };
    const { event, flag } = BUTTON_EVENTS[ctl];
    const before = this.s.ap[flag];
    const kind = addonOf(this.title);
    if (kind === "fbw" && FBW_BUTTON[ctl]) {
      this.fire(FBW_BUTTON[ctl]!, 0);
      if (await this.until(() => this.s?.ap?.[flag] !== before, 1500)) return this.worked();
      // FlyByWire doesn't mirror every light into the standard variables, so a quiet button isn't proof it failed.
      return this.sentUnchecked("Sent to the FCU, but this aircraft doesn't report the result.");
    }
    if (kind === "ifly") {
      const name = matchName(this.inputs.keys(), IFLY_BUTTON[ctl]);
      const hash = name ? this.inputs.get(name) : undefined;
      if (hash !== undefined) {
        // A momentary button: pressed (1), then released (0).
        this.h.setInputEvent(hash, 1);
        await sleep(80);
        this.h.setInputEvent(hash, 0);
        if (await this.until(() => this.s?.ap?.[flag] !== before, 1500)) return this.worked();
      }
    }
    this.fire(event, 0);
    if (await this.until(() => this.s?.ap?.[flag] !== before)) return this.worked();
    return this.ignored("That button");
  }

  private sentUnchecked(note: string): PanelResult {
    this.note = note;
    if (this.s) this.publish({ ...this.s, note });
    return { ok: true };
  }

  /** Has the window reached this value, as the simulator reports it? */
  private reached(ctl: ApKnob, value: number): boolean {
    const ap = this.s?.ap;
    if (!ap) return false;
    switch (ctl) {
      case "spd":
        return Math.abs(ap.spd - value) <= (ap.machMode ? 0.006 : 1);
      case "hdg":
        return angleDiff(ap.hdg, value) <= 1;
      case "crs":
        return angleDiff(ap.crs, value) <= 1;
      case "alt":
        return Math.abs(ap.alt - value) <= 50;
      default:
        return Math.abs(ap.vsFpm - value) <= 50;
    }
  }

  private current(ctl: ApKnob): number {
    const ap = this.s!.ap!;
    return ctl === "spd" ? ap.spd : ctl === "hdg" ? ap.hdg : ctl === "alt" ? ap.alt : ctl === "vs" ? ap.vsFpm : ap.crs;
  }

  /** Sends a PMDG knob as wheel clicks, in small bursts so the aircraft keeps up. */
  private async wheelClicks(event: string, flag: number, count: number) {
    for (let i = 0; i < count; i++) {
      this.fire(event, flag);
      if ((i + 1) % 25 === 0) await sleep(25);
    }
  }

  /** The aircraft's own way of setting a window, when it has one; null when the standard events should be tried. */
  private async addonSet(ctl: ApKnob, value: number): Promise<PanelResult | null> {
    const kind = addonOf(this.title);
    if (kind === "none" || !isSelectorKnob(ctl)) return null;
    const mach = !!this.s?.ap?.machMode;
    if (kind === "pmdg737") {
      const plan = pmdgPlan(ctl, this.current(ctl), value, ctl === "spd" && mach);
      if (!plan) return this.reached(ctl, value) ? this.worked() : null;
      await this.wheelClicks(plan.event, plan.flag, plan.count);
    } else if (kind === "fbw") {
      if (ctl === "alt") this.fire(FBW_ALT_INCREMENT, 100);
      this.fire(FBW_SET[ctl], fbwValue(ctl, value, ctl === "spd" && mach));
    } else {
      const k = IFLY_KNOB[ctl];
      const setName = matchName(this.inputs.keys(), k.set);
      const setHash = setName ? this.inputs.get(setName) : undefined;
      if (setHash !== undefined && this.h) {
        this.h.setInputEvent(setHash, value);
        if (await this.until(() => this.reached(ctl, value), 1200)) return this.worked();
      }
      const n = incDecClicks(ctl, this.current(ctl), value);
      if (n === 0) return this.reached(ctl, value) ? this.worked() : null;
      const name = matchName(this.inputs.keys(), n > 0 ? k.inc : k.dec);
      const hash = name ? this.inputs.get(name) : undefined;
      if (hash === undefined || !this.h) return null;
      for (let i = 0; i < Math.abs(n); i++) {
        this.h.setInputEvent(hash, 1);
        if ((i + 1) % 25 === 0) await sleep(25);
      }
    }
    return (await this.until(() => this.reached(ctl, value), 2500)) ? this.worked() : this.ignored("That window");
  }

  async set(ctl: ApKnob, value: number): Promise<PanelResult> {
    if (!this.h || !this.s?.ap) return { ok: false, error: "This aircraft isn't reporting its autopilot." };
    const viaAddon = await this.addonSet(ctl, value);
    if (viaAddon) return viaAddon;
    const mach = ctl === "spd" && this.s.ap.machMode;
    this.fire(SET_EVENTS[ctl] === "AP_SPD_VAR_SET" && mach ? "AP_MACH_VAR_SET" : SET_EVENTS[ctl], mach ? Math.round(value * 100) : Math.round(value));
    if (await this.until(() => this.reached(ctl, value))) return this.worked();
    return this.ignored("That window");
  }

  /** What the simulator reports now, for checking a command. */
  private sysNow(): NonNullable<PanelState["sys"]> | null {
    return this.s?.sys ?? null;
  }

  async sys(id: SysId, value?: number): Promise<PanelResult> {
    if (!this.h || !this.s?.sys) return { ok: false, error: "Simulator not connected." };
    const on = (value ?? 1) > 0;
    const check = (fn: (x: NonNullable<PanelState["sys"]>) => boolean, ms = VERIFY_MS) => this.until(() => { const x = this.sysNow(); return !!x && fn(x); }, ms);
    const done = async (ok: Promise<boolean>, what: string) => ((await ok) ? this.worked() : this.ignored(what));
    const x = this.s.sys;
    switch (id) {
      case "flapsUp":
      case "flapsDown": {
        const before = x.flapsIndex;
        this.fire(id === "flapsUp" ? "FLAPS_DECR" : "FLAPS_INCR", 0);
        if (await check((s) => s.flapsIndex !== before)) return this.worked();
        const edge = id === "flapsUp" ? before <= 0 : before >= x.flapsCount && x.flapsCount > 0;
        return edge ? { ok: false, error: id === "flapsUp" ? "The flaps are already up." : "The flaps are already fully down." } : this.ignored("The flaps");
      }
      case "spoilersArm":
        if (x.spoilersArmed === on) return { ok: true };
        this.fire(on ? "SPOILERS_ARM_ON" : "SPOILERS_ARM_OFF", 0);
        return done(check((s) => s.spoilersArmed === on), "The spoilers");
      case "gear":
        if (x.gearDown === on) return { ok: true };
        this.fire(on ? "GEAR_DOWN" : "GEAR_UP", 0);
        return done(check((s) => s.gearDown === on), "The landing gear");
      case "parkingBrake":
        if (x.parkingBrake === on) return { ok: true };
        this.fire("PARKING_BRAKES", 0);
        return done(check((s) => s.parkingBrake === on), "The parking brake");
      case "engines":
        this.fire(on ? "ENGINE_AUTO_START" : "ENGINE_AUTO_SHUTDOWN", 0);
        return done(check((s) => (on ? s.enginesRunning > 0 : s.enginesRunning === 0), 15_000), on ? "Engine start" : "Engine shutdown");
      case "apu":
        if (x.apuOn === on) return { ok: true };
        this.fire(on ? "APU_STARTER" : "APU_OFF_SWITCH", 1);
        return done(check((s) => s.apuOn === on, 3000), "The APU");
      case "pitotHeat":
        if (x.pitotHeat === on) return { ok: true };
        this.fire("PITOT_HEAT_TOGGLE", 0);
        return done(check((s) => s.pitotHeat === on), "Pitot heat");
      case "seatbelts":
        if (x.seatbelts === on) return { ok: true };
        this.fire("CABIN_SEATBELTS_ALERT_SWITCH_TOGGLE", 0);
        return done(check((s) => s.seatbelts === on), "The seat belt sign");
      case "baroStd":
        this.fire("BAROMETRIC_STD_PRESSURE", 0);
        return done(check((s) => Math.abs(s.baroHpa - 1013.2) < 1), "The altimeter");
      case "baroSet": {
        const raw = value ?? 0;
        const hpa = raw < 40 ? raw * 33.8639 : raw;
        if (hpa < 940 || hpa > 1080) return { ok: false, error: "The altimeter setting must be 940 to 1080 hPa (27.76 to 31.89 inHg)." };
        this.fire("KOHLSMAN_SET", Math.round(hpa * 16));
        return done(check((s) => Math.abs(s.baroHpa - hpa) < 1.2), "The altimeter");
      }
      case "pause": {
        if (x.paused === on) return { ok: true };
        // PAUSE_SET with an explicit state is dependable where the plain toggle is not.
        this.fire("PAUSE_SET", on ? 1 : 0);
        this.fire(on ? "PAUSE_ON" : "PAUSE_OFF", 0);
        return done(this.until(() => this.sim.status().paused === on, 1500), "Pause");
      }
      case "simRate": {
        const want = RATE_STEPS.reduce((best, r) => (Math.abs(r - (value ?? 1)) < Math.abs(best - (value ?? 1)) ? r : best), RATE_STEPS[0]!);
        for (let i = 0; i < 10; i++) {
          const cur = this.sysNow()?.simRate ?? 1;
          const steps = Math.round(Math.log2(want / Math.max(0.03125, Math.min(128, cur))));
          if (steps === 0) break;
          // One event at a time: a quick burst counts as a single step.
          this.fire(steps > 0 ? "SIM_RATE_INCR" : "SIM_RATE_DECR", 0);
          await check((s) => s.simRate !== cur, 1200);
        }
        return done(check((s) => Math.abs(s.simRate - want) / want <= 0.25, 600), "The time rate");
      }
      case "flapsSet": {
        const max = x.flapsCount > 0 ? x.flapsCount : 8;
        const want = Math.max(0, Math.min(max, Math.round(value ?? 0)));
        if (x.flapsIndex === want) return { ok: true };
        // Writing the handle index lands exactly on a detent; add-ons that ignore it are stepped with the stock events.
        const b = new RawBuffer(8);
        b.writeFloat64(want);
        try {
          this.h.setDataOnSimObject(DEF_FLAPS, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
        } catch {
          /* fall through to the events */
        }
        if (await check((s) => s.flapsIndex === want, 1000)) return this.worked();
        for (let i = 0; i < max + 1; i++) {
          const cur = this.sysNow()?.flapsIndex ?? want;
          if (cur === want) break;
          this.fire(cur < want ? "FLAPS_INCR" : "FLAPS_DECR", 0);
          await check((s) => s.flapsIndex !== cur, 1200);
        }
        return done(check((s) => s.flapsIndex === want, 600), "The flaps");
      }
      case "doorToggle": {
        const n = Math.round(value ?? 1);
        if (n < 1 || n > 4) return { ok: false, error: "Doors are numbered 1 to 4." };
        const before = x.doors?.[n - 1] ?? 0;
        this.fire("TOGGLE_AIRCRAFT_EXIT", n);
        if (await check((s) => Math.abs((s.doors?.[n - 1] ?? 0) - before) > 2, 4000)) return this.worked();
        return this.ignored(`Door ${n}`);
      }
      case "slew":
        if (!!x.slew === on) return { ok: true };
        this.fire("SLEW_TOGGLE", 0);
        return done(check((s) => !!s.slew === on), "Slew mode");
      case "wingLeveler":
        if (!!x.wingLeveler === on) return { ok: true };
        this.fire("AP_WING_LEVELER", 0);
        return done(check((s) => !!s.wingLeveler === on), "The wing leveler");
      case "panLeft":
      case "panRight":
      case "panUp":
      case "panDown":
      case "zoomIn":
      case "zoomOut":
      case "viewReset": {
        // The simulator doesn't report where the view is, so there is nothing to check these against.
        const event = CAMERA_MOVES[id]!;
        const n = id === "viewReset" ? 1 : Math.max(1, Math.min(20, Math.round(value ?? 1)));
        for (let i = 0; i < n; i++) this.fire(event, 0);
        return { ok: true };
      }
      case "camera": {
        const cam = this.cameraStates();
        const target = value === 2 ? cam.drone : value === 1 ? cam.outside : cam.cockpit;
        const b = new RawBuffer(8);
        b.writeFloat64(target);
        try {
          this.h.setDataOnSimObject(DEF_CAMERA, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
        } catch {
          return { ok: false, error: "The simulator would not change the camera." };
        }
        return done(check((s) => s.camera === (value ?? 0)), "The camera");
      }
    }
  }
}
