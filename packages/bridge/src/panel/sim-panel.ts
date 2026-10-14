import { familyOf, LIGHT_IDS, type CockpitCommand, type FcuState, type ApButton, type ApKnob, type LightId, type PanelState, type SimStatus, type SysId } from "@vbuddy/protocol";
import { DataRequestFlag, EventFlag, RawBuffer, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type ConnectionHandle } from "node-simconnect";
import type { PanelBackend, PanelResult } from "./backend.js";
import { addonOf, AIRLINER_BUTTON, AIRLINER_FCU_BUTTON, AIRLINER_KNOB, AIRLINER_LIGHT, studyReadOnly, eventDword, FBW_LIGHTS, FBW_PUSH_PULL, FENIX_MANAGED_DOT, FENIX_PUSH_PULL, SLOT_INDEX_EVENT, type FcuKnob, FBW_ALT_INCREMENT, FBW_BUTTON, FBW_SET, fbwValue, FENIX_APU_START_DELAY_MS, FENIX_LIGHT, FENIX_SWITCH, FENIX_SYS, IFLY_BUTTON, IFLY_KNOB, incDecClicks, isSelectorKnob, matchName, pmdgPlan, STUDY_NOTE } from "./addons.js";
import { LVarChannel } from "../sim/lvars.js";

const DEF_PANEL = 70;
/** The Fenix's own switch positions, read once a second while a Fenix is loaded (Cobalt overlays these too). */
const DEF_FENIX_SW = 73;
const REQ_FENIX_SW = 73;
const FENIX_SW_VARS = [FENIX_SWITCH.speedbrake, FENIX_SWITCH.parkingBrake, FENIX_SWITCH.seatbelts, FENIX_SWITCH.probeHeat, FENIX_SWITCH.apuMaster] as const;
/** SimConnect ids for L:var reads and writes (see sim/lvars.ts). */
const LVAR_IDS = 3000;
/** FlyByWire FCU lights and managed dots, read once a second while a FlyByWire is loaded. */
const DEF_FBW = 74;
const REQ_FBW = 74;
const REQ_PANEL = 70;
const EVENT_BASE = 400;
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
  // Airbus FCU slots: 2 = managed, 1 = selected (the default A320neo; Cobalt's FCU_SLOT_INDEX_SIMVARS).
  ["AUTOPILOT SPEED SLOT INDEX", "Number"],
  ["AUTOPILOT HEADING SLOT INDEX", "Number"],
  ["AUTOPILOT ALTITUDE SLOT INDEX", "Number"],
  ["AUTOPILOT VS SLOT INDEX", "Number"],
  // The V/S window per slot: the iniBuilds A350 shows one of these, not the plain variable (which one is watched for).
  ["AUTOPILOT VERTICAL HOLD VAR:1", "Feet per minute"],
  ["AUTOPILOT VERTICAL HOLD VAR:2", "Feet per minute"],
  ["AUTOPILOT VERTICAL HOLD VAR:3", "Feet per minute"],
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
  /** Retries the input-event list: it fails while an aircraft is still loading (SimConnect answers ERROR). */
  private inputsTimer: NodeJS.Timeout | null = null;
  private inputsTries = 0;
  /** iniBuilds knobs: how far one write of +1 moves the window, learned per aircraft and knob. */
  private airlinerStep = new Map<string, number>();
  /** Current values of the iniBuilds FCU / light input events (subscribed), by name. */
  private inputValues = new Map<string, number>();
  private inputHashNames = new Map<bigint, string>();
  /** iniBuilds V/S window: which of the plain / :1 / :2 / :3 V/S variables last changed (that's the one the FCU shows). */
  private vsPrev: number[] = [];
  private vsSrc = 0;
  private title = "";
  private note: string | null = null;
  private lastJson = "";
  private lv: LVarChannel | null = null;
  /** Latest Fenix switch positions (FENIX_SW_VARS order), or null when no Fenix is loaded. */
  private fenixSw: number[] | null = null;
  private fenixSwOn = false;
  private fbw: number[] | null = null;
  private fbwOn = false;
  private lastAp: number[] = [];
  private lastLights: PanelState["lights"] | null = null;

  constructor(private sim: SimLike) {
    sim.onHandle((h) => this.attach(h));
    sim.onStatus((st) => {
      if (st.connected && this.s?.sys && this.s.sys.paused !== st.paused) this.publish({ ...this.s, sys: { ...this.s.sys, paused: st.paused } });
      if (!st.connected) this.publish(null);
      else if (st.aircraftTitle !== this.title) {
        this.title = st.aircraftTitle;
        this.note = null;
        this.refreshInputEvents();
        this.watchFenix();
        if (this.s) this.publish({ ...this.s, aircraft: this.title, family: familyOf(this.title), readOnly: this.readOnly() });
      }
    });
  }

  state() {
    return this.s;
  }
  /** Study airliners (FSLabs, ToLiss, iniBuilds A300/A310) ignore outside commands: say so instead of offering controls. */
  private readOnly(): string | null {
    return addonOf(this.title) === "study" ? studyReadOnly(this.title) : null;
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
    this.lv = h ? new LVarChannel(h, LVAR_IDS) : null;
    this.fenixSw = null;
    this.fenixSwOn = false;
    if (!h) return;
    this.fbw = null;
    this.fbwOn = false;
    for (const n of FENIX_SW_VARS) h.addToDataDefinition(DEF_FENIX_SW, `L:${n}`, "number", SimConnectDataType.FLOAT64);
    for (const n of FBW_LIGHTS) h.addToDataDefinition(DEF_FBW, `L:${n}`, "number", SimConnectDataType.FLOAT64);
    h.on("simObjectData", (r) => {
      if (r.requestID !== REQ_FBW || h !== this.h || !this.fbwOn) return;
      this.fbw = FBW_LIGHTS.map(() => r.data.readFloat64());
      this.republish();
    });
    h.on("simObjectData", (r) => {
      if (r.requestID !== REQ_FENIX_SW || h !== this.h || !this.fenixSwOn) return;
      this.fenixSw = FENIX_SW_VARS.map(() => r.data.readFloat64());
      this.republish();
    });
    for (const l of LIGHT_IDS) this.sim.labelSend?.(h.addToDataDefinition(DEF_PANEL, LIGHT_VARS[l], "Bool", SimConnectDataType.FLOAT64), LIGHT_VARS[l]);
    for (const [name, unit] of AP_VARS) this.sim.labelSend?.(h.addToDataDefinition(DEF_PANEL, name, unit, SimConnectDataType.FLOAT64), name);
    for (const [name, unit] of SYS_VARS) this.sim.labelSend?.(h.addToDataDefinition(DEF_PANEL, name, unit, SimConnectDataType.FLOAT64), name);
    h.addToDataDefinition(DEF_CAMERA, "CAMERA STATE", "Enum", SimConnectDataType.FLOAT64);
    h.addToDataDefinition(DEF_FLAPS, "FLAPS HANDLE INDEX", "Number", SimConnectDataType.FLOAT64);
    h.on("simObjectData", (r) => {
      if (r.requestID !== REQ_PANEL || h !== this.h) return;
      const n = [...LIGHT_IDS, ...AP_VARS, ...SYS_VARS].map(() => r.data.readFloat64());
      const lights = Object.fromEntries(LIGHT_IDS.map((l, i) => [l, n[i]! > 0])) as PanelState["lights"];
      this.lastLights = lights;
      this.lastAp = n.slice(LIGHT_IDS.length, LIGHT_IDS.length + AP_VARS.length);
      const x = n.slice(LIGHT_IDS.length + AP_VARS.length);
      this.title = this.sim.status().aircraftTitle || this.title;
      this.publish({ aircraft: this.title, family: familyOf(this.title), lights, ap: this.apFrom(this.lastAp), note: this.note, sys: this.sysFrom(x), readOnly: this.readOnly() });
    });
    h.on("inputEventsList", (r) => {
      // The list comes in chunks; entry 0 starts a fresh one (as Cobalt reads it).
      if (r.entryNumber === 0) this.inputs.clear();
      for (const d of r.inputEventDescriptors) this.inputs.set(d.name, d.inputEventIdHash);
      if (r.entryNumber + r.inputEventDescriptors.length >= r.outOf) this.watchAirlinerInputs();
    });
    h.on("subscribeInputEvent", (r) => {
      const name = this.inputHashNames.get(r.inputEventIdHash);
      if (name !== undefined && typeof r.value === "number") this.inputValues.set(name, r.value);
    });
    this.sim.labelSend?.(h.requestDataOnSimObject(REQ_PANEL, DEF_PANEL, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED), "lights and autopilot request");
    this.refreshInputEvents();
    this.watchFenix();
  }

  /** Rebuilds the published state from the last readings plus the add-on overlays. */
  private republish() {
    if (!this.s || !this.lastLights) return;
    this.publish({ ...this.s, ap: this.lastAp.length ? this.apFrom(this.lastAp) : this.s.ap, sys: this.lastSys.length ? this.sysFrom(this.lastSys) : this.s.sys });
  }

  /** The autopilot as the simulator reports it, with FlyByWire's own FCU lights laid over (Cobalt's A32NX overlay). */
  /** The V/S window. iniBuilds keeps the window in one of the slot variables; follow whichever one moves. */
  private vsFor(a: number[]): number {
    if (addonOf(this.title) !== "airliner") return a[15]!;
    const now = [a[15] ?? 0, a[21] ?? 0, a[22] ?? 0, a[23] ?? 0];
    if (this.vsPrev.length) {
      const moved = now.findIndex((v, i) => Math.abs(v - this.vsPrev[i]!) >= 1);
      if (moved >= 0) this.vsSrc = moved;
    }
    this.vsPrev = now;
    return now[this.vsSrc]!;
  }

  private apFrom(a: number[]): NonNullable<PanelState["ap"]> {
    const mach = a[10]! > 0;
    const ap: NonNullable<PanelState["ap"]> = {
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
      vsFpm: Math.round(this.vsFor(a)),
      crs: Math.round(a[16]!) % 360,
    };
    const f = this.fbw;
    if (f) {
      Object.assign(ap, { master: f[0]! > 0.5, athr: f[1]! > 0.5, lnav: f[2]! > 0.5, app: f[3]! > 0.5 });
      ap.managed = { spd: f[4]! > 0.5, hdg: f[5]! > 0.5, alt: f[6]! > 0.5 };
    } else if (familyOf(this.title) === "airbus" && (addonOf(this.title) === "none" || addonOf(this.title) === "airliner") && (a[17] ?? 0) > 0) {
      ap.managed = { spd: Math.round(a[17]!) === 2, hdg: Math.round(a[18] ?? 0) === 2, alt: Math.round(a[19] ?? 0) === 2 };
    }
    return ap;
  }

  /** Reads the Fenix's own switches (or FlyByWire's FCU lights) while one is loaded. */
  private watchFenix() {
    const h = this.h;
    if (!h) return;
    const fbw = addonOf(this.sim.status().aircraftTitle || this.title) === "fbw";
    if (fbw !== this.fbwOn) {
      this.fbwOn = fbw;
      if (!fbw) this.fbw = null;
      try {
        h.requestDataOnSimObject(REQ_FBW, DEF_FBW, SimConnectConstants.OBJECT_ID_USER, fbw ? SimConnectPeriod.SECOND : SimConnectPeriod.NEVER);
      } catch {
        /* simulator gone */
      }
    }
    const want = addonOf(this.sim.status().aircraftTitle || this.title) === "fenix";
    if (want === this.fenixSwOn) return;
    this.fenixSwOn = want;
    if (!want) this.fenixSw = null;
    try {
      h.requestDataOnSimObject(REQ_FENIX_SW, DEF_FENIX_SW, SimConnectConstants.OBJECT_ID_USER, want ? SimConnectPeriod.SECOND : SimConnectPeriod.NEVER);
    } catch {
      /* simulator gone */
    }
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
    const engineCount = Math.round(x[9] ?? 0);
    const engines = [x[5], x[6], x[7], x[8]].slice(0, Math.max(0, engineCount)).map((v) => (v ?? 0) > 0);
    const f = this.fenixSw;
    const base = {
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
      engines,
    };
    // A Fenix shows its own switch positions (the standard variables don't follow every Fenix switch).
    if (f) Object.assign(base, { spoilersArmed: !((f[0] ?? 1) > 0.5), parkingBrake: (f[1] ?? 0) > 0.5, seatbelts: (f[2] ?? 0) > 0.5, pitotHeat: (f[3] ?? 0) > 0.5, apuOn: (f[4] ?? 0) > 0.5 });
    return base;
  }

  /**
   * The simulator's own list of cockpit controls changes with the aircraft. Asked for when the aircraft changes, and
   * again a few times while it is empty: right after the title changes the aircraft is often still loading and
   * SimConnect answers with an error (Cobalt asks again once the aircraft has loaded).
   */
  private refreshInputEvents() {
    if (!this.h || this.inputsFor === this.title) return;
    this.inputsFor = this.title;
    this.inputs.clear();
    this.inputsTries = 0;
    this.askInputEvents();
  }
  private askInputEvents() {
    if (this.inputsTimer) clearTimeout(this.inputsTimer);
    this.inputsTimer = null;
    if (!this.h) return;
    try {
      this.h.enumerateInputEvents(60);
    } catch {
      return; /* older simulator: the standard events are all there is */
    }
    const delays = [3000, 8000, 15000, 30000, 60000];
    const wait = delays[this.inputsTries++];
    if (wait === undefined) return;
    const forTitle = this.title;
    this.inputsTimer = setTimeout(() => {
      if (this.title === forTitle && this.inputs.size === 0) this.askInputEvents();
    }, wait);
    this.inputsTimer.unref?.();
  }

  /** An input event's hash by the first name matching `patterns`; undefined when the aircraft has none. */
  private input(patterns: RegExp[] | undefined): bigint | undefined {
    const name = matchName(this.inputs.keys(), patterns);
    return name ? this.inputs.get(name) : undefined;
  }

  /**
   * iniBuilds: watch the values of the FCU and light input events, so a press can be sent as one change of value.
   * (Their buttons rest at 1 or at 0 depending on the button, so "1 then 0" can be two presses or none.)
   */
  private watchAirlinerInputs() {
    if (!this.h || addonOf(this.title) !== "airliner") return;
    this.inputValues.clear();
    this.inputHashNames.clear();
    const patterns = [
      ...Object.values(AIRLINER_FCU_BUTTON),
      ...Object.values(AIRLINER_KNOB).flatMap((k) => [k.push, k.pull]),
      ...Object.values(AIRLINER_LIGHT).map((l) => l!.names),
    ];
    for (const ps of patterns) {
      const name = matchName(this.inputs.keys(), ps);
      const hash = name ? this.inputs.get(name) : undefined;
      if (!name || hash === undefined || this.inputHashNames.has(hash)) continue;
      this.inputHashNames.set(hash, name);
      try {
        this.h.subscribeInputEvent(hash);
      } catch {
        /* older simulator */
      }
    }
  }

  /** One press of an iniBuilds button or knob push/pull: its input event set to the other value from where it rests. */
  private async airlinerPress(patterns: RegExp[] | undefined): Promise<boolean> {
    const name = matchName(this.inputs.keys(), patterns);
    const hash = name ? this.inputs.get(name) : undefined;
    if (!name || hash === undefined || !this.h) return false;
    const now = this.inputValues.get(name);
    if (now === undefined) {
      await this.pulse(hash); // value not known yet: a press and release
      return true;
    }
    this.h.setInputEvent(hash, now > 0 ? 0 : 1);
    this.inputValues.set(name, now > 0 ? 0 : 1);
    return true;
  }

  /** A momentary press through an input event: 1, then 0 (Cobalt's pulseInputEvent). */
  private async pulse(hash: bigint) {
    this.h?.setInputEvent(hash, 1);
    await sleep(80);
    this.h?.setInputEvent(hash, 0);
  }

  private fire(event: string, data: number) {
    const h = this.h;
    if (!h) return false;
    let id = this.ids.get(event);
    if (id === undefined) {
      id = EVENT_BASE + this.ids.size;
      h.mapClientEventToSimEvent(id, event);
      this.ids.set(event, id);
    }
    // As PMDG's SDK sample and Cobalt: the "group" is a priority (highest), flagged GROUPID_IS_PRIORITY. Add-on events
    // such as PMDG's "#<number>" ones are picked up this way.
    h.transmitClientEvent(SimConnectConstants.OBJECT_ID_USER, id, eventDword(data), GROUP_PRIORITY_HIGHEST, EventFlag.EVENT_FLAG_GROUPID_IS_PRIORITY);
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
    const fenix = await this.fenixLight(id, on);
    if (fenix) return fenix;
    const airliner = await this.airlinerLight(id, on);
    if (airliner) return airliner;
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

  /** iniBuilds A340 / A350 / A380: the light switch's input event, each "on" position in turn until the light reports on. */
  private async airlinerLight(id: LightId, on: boolean): Promise<PanelResult | null> {
    const plan = AIRLINER_LIGHT[id];
    if (!plan || addonOf(this.title) !== "airliner" || !this.h) return null;
    const hash = this.input(plan.names);
    if (hash === undefined) return null;
    for (const v of on ? plan.on : [0]) {
      this.h.setInputEvent(hash, v);
      if (await this.until(() => this.s?.lights[id] === on, 1500)) return this.worked();
    }
    return this.sentUnchecked(`Sent to the ${LABELS[id].toLowerCase()} light switch, but the aircraft doesn't report that light to the simulator.`);
  }

  /** Fenix: the overhead light switch itself, checked by reading it back (Cobalt's fenixControlPlan). Null: not a Fenix switch, or no L:var channel. */
  private async fenixLight(id: LightId, on: boolean): Promise<PanelResult | null> {
    const plan = FENIX_LIGHT[id];
    if (!plan || addonOf(this.title) !== "fenix" || !this.lv || !(await this.lv.ready())) return null;
    const want = on ? plan.on : plan.off;
    for (const name of plan.lvars) if (!this.lv.write(name, want)) return null;
    const ok = await this.lv.confirm(plan.lvars[0]!, want);
    if (ok === false) return null; // didn't move: try the standard event as well
    return this.worked();
  }

  /** Fenix: a switch under Systems, through its own L:var. Null: not handled here. */
  private async fenixSwitch(lvar: string, want: number, what: string): Promise<PanelResult | null> {
    if (addonOf(this.title) !== "fenix" || !this.lv || !(await this.lv.ready())) return null;
    if (!this.lv.write(lvar, want)) return null;
    const ok = await this.lv.confirm(lvar, want);
    if (ok === false) return this.ignored(what);
    return this.worked();
  }

  /**
   * Airbus FCU knob push (managed) / pull (selected), as Cobalt does it: FlyByWire's own events, the Fenix knob counter,
   * or the default A320neo's slot-index events; checked against the managed dot (or slot index) where there is one.
   */
  async fcu(ctl: FcuKnob, action: "push" | "pull"): Promise<PanelResult> {
    if (!this.h || !this.s?.ap) return { ok: false, error: "This aircraft isn't reporting its autopilot." };
    const kind = addonOf(this.title);
    const wantManaged = action === "push";
    if (kind === "study") return { ok: false, error: "Push or pull this knob on the cockpit FCU: this aircraft keeps its FCU private." };
    if (kind === "pmdg737" || kind === "ifly" || familyOf(this.title) === "boeing") return { ok: false, error: "This aircraft has a Boeing MCP, not an Airbus FCU." };
    if (kind === "fenix") {
      if (!this.lv || !(await this.lv.ready())) return { ok: false, error: "Use the Fenix FCU under Controls." };
      if (!(await this.lv.add(FENIX_PUSH_PULL[ctl], wantManaged ? -1 : 1))) return this.ignored("That knob");
      const dot = FENIX_MANAGED_DOT[ctl];
      if (!dot) return this.worked();
      const ok = await this.lv.confirm(dot, wantManaged ? 1 : 0);
      return ok === false ? this.ignored("That knob") : this.worked();
    }
    if (kind === "airliner") {
      if (!(await this.airlinerPress(AIRLINER_KNOB[ctl][action]))) return { ok: false, error: "This aircraft didn't list that FCU knob. Try again once it has finished loading." };
      if (ctl !== "vs" && this.s.ap.managed !== undefined) {
        const managedNow = () => this.s?.ap?.managed?.[ctl as "spd" | "hdg" | "alt"];
        if (await this.until(() => managedNow() === wantManaged, 1500)) return this.worked();
      }
      return this.sentUnchecked(`${action === "push" ? "Pushed" : "Pulled"} on the FCU. This aircraft doesn't report the knob's managed dot.`);
    }
    const managedNow = () => this.s?.ap?.managed?.[ctl as "spd" | "hdg" | "alt"];
    if (kind === "fbw") this.fire(FBW_PUSH_PULL[ctl][action], 0);
    else this.fire(SLOT_INDEX_EVENT[ctl], wantManaged ? 2 : 1);
    // V/S has no managed dot: sent, nothing to check it against.
    if (ctl === "vs" || this.s.ap.managed === undefined) return this.sentUnchecked("Sent to the FCU. This aircraft doesn't report the knob's managed dot.");
    if (await this.until(() => managedNow() === wantManaged, 2500)) return this.worked();
    return this.ignored("That knob");
  }

  async press(ctl: ApButton): Promise<PanelResult> {
    if (!this.h || !this.s?.ap) return { ok: false, error: "This aircraft isn't reporting its autopilot." };
    const { event, flag } = BUTTON_EVENTS[ctl];
    const before = this.s.ap[flag];
    const kind = addonOf(this.title);
    if (kind === "fbw" && FBW_BUTTON[ctl]) {
      this.fire(FBW_BUTTON[ctl]!, 0);
      if (await this.until(() => this.s?.ap?.[flag] !== before, 2500)) return this.worked();
      // FlyByWire doesn't mirror every light into the standard variables, so a quiet button isn't proof it failed.
      return this.sentUnchecked("Sent to the FCU, but this aircraft doesn't report the result.");
    }
    if (kind === "airliner") {
      if (!(await this.airlinerPress(AIRLINER_BUTTON[ctl]))) return { ok: false, error: "This aircraft has no such FCU button, or hasn't finished loading." };
      if (await this.until(() => this.s?.ap?.[flag] !== before, 1500)) return this.worked();
      // Don't fire the standard event on top: if the press did land, that would switch it straight back.
      return this.sentUnchecked("Pressed on the FCU. This aircraft doesn't report that mode to the simulator, so the light here may not change.");
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
    } else if (kind === "airliner") {
      return this.airlinerSet(ctl, value);
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

  /**
   * iniBuilds A340 / A350 / A380: the FCU knob's input event. One write of +1 or -1 is one detent; which way and how far
   * is learned the first time by watching the window (the aircraft keeps the standard autopilot values up to date).
   * Null when the knob didn't move, so the standard events get their turn.
   */
  private async airlinerSet(ctl: "spd" | "hdg" | "alt" | "vs", value: number): Promise<PanelResult | null> {
    const hash = this.input(AIRLINER_KNOB[ctl].turn);
    if (hash === undefined || !this.h) return null;
    const wrap = ctl === "hdg";
    const diff = (a: number, b: number) => (wrap ? ((((a - b) % 360) + 540) % 360) - 180 : a - b);
    const key = `${this.title}:${ctl}`;
    let step = this.airlinerStep.get(key);
    if (step === undefined) {
      for (const v of [1, -1]) {
        const before = this.current(ctl);
        this.h.setInputEvent(hash, v);
        if (await this.until(() => this.current(ctl) !== before, 900)) {
          step = diff(this.current(ctl), before) * v; // how far +1 moves it
          break;
        }
      }
      if (!step) return null;
      this.airlinerStep.set(key, step);
    }
    const tol = ctl === "alt" || ctl === "vs" ? 50 : ctl === "spd" && this.s?.ap?.machMode ? 0.006 : 1;
    for (let round = 0; round < 4; round++) {
      const d = diff(value, this.current(ctl));
      if (Math.abs(d) <= tol) return this.worked();
      const clicks = Math.min(500, Math.max(1, Math.round(Math.abs(d) / Math.abs(step))));
      const dir = Math.sign(d) === Math.sign(step) ? 1 : -1;
      const start = this.current(ctl);
      for (let i = 0; i < clicks; i++) {
        this.h.setInputEvent(hash, dir);
        if ((i + 1) % 25 === 0) await sleep(25);
      }
      await this.until(() => Math.abs(diff(value, this.current(ctl))) <= tol, 1500);
      if (this.current(ctl) === start) break; // stopped moving
    }
    return this.reached(ctl, value) ? this.worked() : this.ignored("That window");
  }

  async set(ctl: ApKnob, value: number): Promise<PanelResult> {
    if (!this.h || !this.s?.ap) return { ok: false, error: "This aircraft isn't reporting its autopilot." };
    if (addonOf(this.title) === "study") return { ok: false, error: STUDY_NOTE };
    const viaAddon = await this.addonSet(ctl, value);
    if (viaAddon) return viaAddon;
    const mach = ctl === "spd" && this.s.ap.machMode;
    // Select the knob first (slot 1), so an Airbus in managed mode takes the value (Cobalt's "pre" events).
    if (ctl === "spd" || ctl === "hdg" || ctl === "vs") this.fire(SLOT_INDEX_EVENT[ctl], 1);
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
      case "spoilersArm": {
        if (x.spoilersArmed === on) return { ok: true };
        const viaFenix = await this.fenixSwitch(FENIX_SYS.spoilersArm.lvar, on ? FENIX_SYS.spoilersArm.on : FENIX_SYS.spoilersArm.off, "The spoilers");
        if (viaFenix) return viaFenix;
        this.fire(on ? "SPOILERS_ARM_ON" : "SPOILERS_ARM_OFF", 0);
        return done(check((s) => s.spoilersArmed === on), "The spoilers");
      }
      case "gear":
        if (x.gearDown === on) return { ok: true };
        this.fire(on ? "GEAR_DOWN" : "GEAR_UP", 0);
        return done(check((s) => s.gearDown === on), "The landing gear");
      case "parkingBrake": {
        if (x.parkingBrake === on) return { ok: true };
        const viaFenix = await this.fenixSwitch(FENIX_SYS.parkingBrake.lvar, on ? 1 : 0, "The parking brake");
        if (viaFenix) return viaFenix;
        this.fire("PARKING_BRAKES", 0);
        return done(check((s) => s.parkingBrake === on), "The parking brake");
      }
      case "engine": {
        // One engine: fuel valve + starter to start, fuel valve to stop (Cobalt's engine:start:n / engine:shutdown:n).
        const n = Math.abs(Math.round(value ?? 0));
        if (n < 1 || n > 4 || n > Math.max(1, x.engineCount)) return { ok: false, error: `This aircraft has no engine ${n}.` };
        const start = (value ?? 0) > 0;
        const running = () => !!this.sysNow()?.engines?.[n - 1];
        if (running() === start) return { ok: true };
        this.fire(`TOGGLE_FUEL_VALVE_ENG${n}`, 0);
        if (start) this.fire(`TOGGLE_STARTER${n}`, 0);
        return done(this.until(() => running() === start, start ? 60_000 : 20_000), `Engine ${n}`);
      }
      case "engines":
        this.fire(on ? "ENGINE_AUTO_START" : "ENGINE_AUTO_SHUTDOWN", 0);
        return done(check((s) => (on ? s.enginesRunning > 0 : s.enginesRunning === 0), 15_000), on ? "Engine start" : "Engine shutdown");
      case "apu":
        if (x.apuOn === on) return { ok: true };
        if (addonOf(this.title) === "fenix" && this.lv && (await this.lv.ready())) {
          // Cobalt: APU MASTER on, wait 1.5 s, press START; off is MASTER off.
          if (!this.lv.write(FENIX_SWITCH.apuMaster, on ? 1 : 0)) return this.ignored("The APU");
          if (on) {
            await sleep(FENIX_APU_START_DELAY_MS);
            await this.lv.press(FENIX_SWITCH.apuStart);
          }
          const ok = await this.lv.confirm(FENIX_SWITCH.apuMaster, on ? 1 : 0);
          return ok === false ? this.ignored("The APU") : this.worked();
        }
        this.fire(on ? "APU_STARTER" : "APU_OFF_SWITCH", 1);
        return done(check((s) => s.apuOn === on, 3000), "The APU");
      case "pitotHeat": {
        if (x.pitotHeat === on) return { ok: true };
        const viaFenix = await this.fenixSwitch(FENIX_SYS.pitotHeat.lvar, on ? 1 : 0, "Probe heat");
        if (viaFenix) return viaFenix;
        this.fire("PITOT_HEAT_TOGGLE", 0);
        return done(check((s) => s.pitotHeat === on), "Pitot heat");
      }
      case "seatbelts": {
        if (x.seatbelts === on) return { ok: true };
        const viaFenix = await this.fenixSwitch(FENIX_SYS.seatbelts.lvar, on ? 1 : 0, "The seat belt sign");
        if (viaFenix) return viaFenix;
        this.fire("CABIN_SEATBELTS_ALERT_SWITCH_TOGGLE", 0);
        return done(check((s) => s.seatbelts === on), "The seat belt sign");
      }
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

  /* ---------------------------------------------------------------- iniBuilds FCU screen (the Fenix-style FCU in the app) */

  /** The FCU as the iniBuilds A340 / A350 / A380 reports it through the standard autopilot values; null for other aircraft. */
  airlinerFcu(): FcuState | null {
    const ap = this.s?.ap;
    if (!ap || addonOf(this.title) !== "airliner") return null;
    const baro = this.s?.sys?.baroHpa ?? 1013.2;
    return {
      aircraft: "inibuilds",
      power: true,
      spd: ap.spd,
      spdIsMach: ap.machMode,
      spdDashed: false,
      spdManaged: !!ap.managed?.spd,
      hdg: ap.hdg,
      hdgDashed: false,
      hdgManaged: !!ap.managed?.hdg,
      trkFpa: (this.inputValues.get(matchName(this.inputValues.keys(), AIRLINER_FCU_BUTTON.hdgTrk) ?? "") ?? 0) > 1,
      alt: ap.alt,
      altManaged: !!ap.managed?.alt,
      altStep: null,
      vs: ap.vsFpm,
      vsDashed: false,
      lights: { ap1: ap.master, ap2: false, athr: ap.athr, loc: ap.lnav, appr: ap.app, exped: false },
      efis1: { baroHpa: baro, baroInHg: Math.round((baro / 33.8639) * 100) / 100, ndMode: 0 },
    };
  }

  /** Runs one FCU screen command on an iniBuilds aircraft. */
  async airlinerCommand(cmd: CockpitCommand): Promise<PanelResult> {
    if (!this.h || addonOf(this.title) !== "airliner") return { ok: false, error: "No iniBuilds A340 / A350 / A380 loaded." };
    switch (cmd.op) {
      case "turn": {
        if (cmd.ctl === "baro1") return { ok: false, error: "Set the altimeter under Simulator and systems." };
        const hash = this.input(AIRLINER_KNOB[cmd.ctl].turn);
        if (hash === undefined) return { ok: false, error: "This aircraft didn't list that FCU knob. Try again once it has finished loading." };
        const n = Math.abs(cmd.clicks);
        const learned = this.airlinerStep.get(`${this.title}:${cmd.ctl}`);
        // +1 turns clockwise unless the aircraft showed otherwise
        const dir = Math.sign(cmd.clicks) * (learned !== undefined && learned < 0 ? -1 : 1);
        for (let i = 0; i < n; i++) {
          this.h.setInputEvent(hash, dir);
          if ((i + 1) % 25 === 0) await sleep(25);
        }
        return { ok: true };
      }
      case "push":
      case "pull":
        if (cmd.ctl === "baro1") return { ok: false, error: "Set the altimeter under Simulator and systems." };
        return this.fcu(cmd.ctl, cmd.op);
      case "press": {
        if (!(await this.airlinerPress(AIRLINER_FCU_BUTTON[cmd.ctl]))) return { ok: false, error: "This aircraft has no such FCU button." };
        return { ok: true };
      }
      case "target":
        return this.set(cmd.ctl, cmd.value);
      case "ndMode":
        return { ok: false, error: "The ND mode isn't available for this aircraft yet." };
    }
  }
}
