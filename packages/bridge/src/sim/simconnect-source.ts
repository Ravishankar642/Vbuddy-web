import type { SimStatus, Telemetry } from "@vbuddy/protocol";
import {
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  DataRequestFlag,
  type ConnectionHandle,
  type RawBuffer,
} from "node-simconnect";
import { logger } from "../log.js";
import { connectSim, errText, type SimConnectTarget } from "./connect.js";
import { EMPTY_EXTRAS, normDeg, type SimExtras, type SimSource } from "./source.js";

const log = logger("simconnect");

const DEF_TELEMETRY = 1;
const DEF_TITLE = 2;
const REQ_TELEMETRY = 1;
const REQ_TITLE = 2;
// The aircraft's registration and type, as the Live page shows them.
const DEF_IDENT = 20;
const REQ_IDENT = 20;

/** MSFS answers ATC MODEL with a text key ("TT:ATCCOM.AC_MODEL_B788.0.text") for most aircraft: keep the type in it. */
export function cleanModel(raw: string): string {
  const s = raw.trim();
  const m = /AC_MODEL[ _]([A-Z0-9]{2,5})/i.exec(s);
  if (m) return m[1]!.toUpperCase();
  if (/^TT:|\.text$/i.test(s)) return "";
  return /^[A-Z0-9]{2,5}$/i.test(s) ? s.toUpperCase() : s.slice(0, 12);
}
// One definition + request per extra variable, so a name the sim rejects only
// loses that one value instead of shifting the layout of the others.
const EXTRAS = [
  { def: 3, req: 3, name: "PLANE TOUCHDOWN NORMAL VELOCITY", units: "feet per second", key: "touchdownNormalVelFps", slow: false },
  { def: 4, req: 4, name: "AMBIENT WIND VELOCITY", units: "knots", key: "windKt", slow: false },
  { def: 5, req: 5, name: "AMBIENT WIND DIRECTION", units: "degrees", key: "windFromDeg", slow: false },
  // Aircraft-alert inputs: once a second is plenty, and only when the value changes.
  { def: 6, req: 6, name: "FUEL TOTAL QUANTITY WEIGHT", units: "pounds", key: "fuelLbs", slow: true },
  { def: 7, req: 7, name: "NUMBER OF ENGINES", units: "number", key: "engineCount", slow: true },
  { def: 8, req: 8, name: "GENERAL ENG COMBUSTION:1", units: "bool", key: "eng1", slow: true },
  { def: 9, req: 9, name: "GENERAL ENG COMBUSTION:2", units: "bool", key: "eng2", slow: true },
  { def: 10, req: 10, name: "GENERAL ENG COMBUSTION:3", units: "bool", key: "eng3", slow: true },
  { def: 11, req: 11, name: "GENERAL ENG COMBUSTION:4", units: "bool", key: "eng4", slow: true },
  { def: 12, req: 12, name: "STALL WARNING", units: "bool", key: "stallWarning", slow: true },
  { def: 13, req: 13, name: "OVERSPEED WARNING", units: "bool", key: "overspeedWarning", slow: true },
  // Menu, loading and replay versus flying: VBuddy only records and counts landings while flying.
  { def: 14, req: 14, name: "CAMERA STATE", units: "number", key: "cameraState", slow: true },
] as const;
const EVT_PAUSE = 1;
const EVT_SIM = 2;

const RETRY_MS = 5000;

/**
 * The SimVars we read every sim frame, in buffer order. Every value is a
 * FLOAT64 so decoding is just "read the next double".
 */
const VARS = [
  ["PLANE LATITUDE", "degrees"],
  ["PLANE LONGITUDE", "degrees"],
  ["PLANE ALTITUDE", "feet"],
  ["PLANE ALT ABOVE GROUND", "feet"],
  ["GROUND ALTITUDE", "feet"],
  ["PLANE PITCH DEGREES", "degrees"],
  ["PLANE BANK DEGREES", "degrees"],
  ["PLANE HEADING DEGREES TRUE", "degrees"],
  ["PLANE HEADING DEGREES MAGNETIC", "degrees"],
  ["GPS GROUND TRUE TRACK", "degrees"],
  ["AIRSPEED INDICATED", "knots"],
  ["AIRSPEED TRUE", "knots"],
  ["GROUND VELOCITY", "knots"],
  ["AIRSPEED MACH", "mach"],
  ["VERTICAL SPEED", "feet per minute"],
  ["SIM ON GROUND", "bool"],
  ["G FORCE", "GForce"],
  ["GEAR HANDLE POSITION", "bool"],
  ["FLAPS HANDLE INDEX", "number"],
  ["BRAKE PARKING POSITION", "bool"],
  ["SIMULATION RATE", "number"],
  ["AUTOPILOT MASTER", "bool"],
  ["AUTOPILOT ALTITUDE LOCK VAR:3", "feet"], // Airbus FCU window
  ["AUTOPILOT ALTITUDE LOCK VAR:1", "feet"],
  ["AUTOPILOT HEADING LOCK DIR", "degrees"],
  ["AUTOPILOT AIRSPEED HOLD VAR", "knots"],
  ["AUTOPILOT VERTICAL HOLD VAR", "feet per minute"],
] as const;

function decode(b: RawBuffer): Telemetry {
  const v = VARS.map(() => b.readFloat64());
  const at = (i: number) => v[i] ?? 0;
  const alt3 = at(22);
  return {
    lat: at(0),
    lon: at(1),
    altMsl: at(2),
    altAgl: at(3),
    groundElev: at(4),
    // MSFS reports pitch as + nose DOWN and bank as + LEFT; flip to the usual convention.
    pitch: -at(5),
    bank: -at(6),
    hdgTrue: normDeg(at(7)),
    hdgMag: normDeg(at(8)),
    track: normDeg(at(9)),
    ias: at(10),
    tas: at(11),
    gs: at(12),
    mach: at(13),
    vs: at(14),
    onGround: at(15) !== 0,
    gForce: at(16),
    gearDown: at(17) !== 0,
    flapsIndex: Math.round(at(18)),
    parkingBrake: at(19) !== 0,
    simRate: at(20),
    ap: {
      master: at(21) !== 0,
      altSel: alt3 !== 0 ? alt3 : at(23),
      hdgSel: normDeg(at(24)),
      spdSel: at(25),
      vsSel: at(26),
    },
  };
}

export class SimConnectSource implements SimSource {
  private handle: ConnectionHandle | null = null;
  private sampleCbs: Array<(t: Telemetry, at: number) => void> = [];
  private extrasCbs: Array<(e: SimExtras, at: number) => void> = [];
  private extras: SimExtras = EMPTY_EXTRAS;
  private extrasSendIds = new Map<number, string>();
  private statusCbs: Array<(s: SimStatus) => void> = [];
  private st: SimStatus = { connected: false, source: "simconnect", paused: false, aircraftTitle: "", detail: "starting" };
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastFailure = "";
  /** Send IDs whose exceptions another module reports itself. */
  readonly quietSendIds = new Set<number>();
  /** Other modules name their requests so a bare SimConnect error says which one it was. */
  private sendLabels = new Map<number, string>();
  labelSend(sendId: number, what: string) {
    if (this.sendLabels.size > 4000) this.sendLabels.clear();
    this.sendLabels.set(sendId, what);
  }
  private handleCbs: Array<(h: ConnectionHandle | null) => void> = [];

  constructor(private target: SimConnectTarget | null) {}

  onSample(cb: (t: Telemetry, at: number) => void) {
    this.sampleCbs.push(cb);
  }
  onExtras(cb: (e: SimExtras, at: number) => void) {
    this.extrasCbs.push(cb);
  }
  onStatus(cb: (s: SimStatus) => void) {
    this.statusCbs.push(cb);
  }
  status() {
    return this.st;
  }

  /** Other modules (the cockpit) add their own definitions on each new connection. Called with null when it closes. */
  onHandle(cb: (h: ConnectionHandle | null) => void) {
    this.handleCbs.push(cb);
    if (this.handle) cb(this.handle);
  }
  private emitHandle(h: ConnectionHandle | null) {
    for (const cb of this.handleCbs) {
      try {
        cb(h);
      } catch (e) {
        log.warn(`cockpit setup failed: ${errText(e)}`);
      }
    }
  }

  start() {
    this.stopped = false;
    void this.connect();
  }

  /** Drops the current connection (if any) and tries again now, instead of waiting for the next retry. */
  reconnectNow() {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const h = this.handle;
    this.handle = null;
    try {
      h?.close();
    } catch {
      /* already closed */
    }
    if (h) this.setStatus({ connected: false, paused: false, detail: "Reconnecting..." });
    log.info("Reconnecting to MSFS (asked for from the VBuddy window)...");
    void this.connect();
  }

  async stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.handle?.close();
    } catch {
      /* already closed */
    }
    this.handle = null;
  }

  private setStatus(patch: Partial<SimStatus>) {
    const next = { ...this.st, ...patch };
    if (JSON.stringify(next) === JSON.stringify(this.st)) return;
    this.st = next;
    for (const cb of this.statusCbs) cb(next);
  }

  private scheduleRetry(reason: string) {
    if (this.stopped) return;
    this.setStatus({ connected: false, paused: false, detail: reason });
    // Only log a failure once until it changes, so a closed sim doesn't spam the console.
    if (reason !== this.lastFailure) {
      log.info(`${reason} Retrying every ${RETRY_MS / 1000}s...`);
      this.lastFailure = reason;
    }
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), RETRY_MS);
  }

  private async connect() {
    if (this.stopped) return;
    let handle: ConnectionHandle;
    let simName: string;
    try {
      ({ handle, simName } = await connectSim("VBuddy Bridge", this.target));
    } catch (e) {
      this.scheduleRetry(`MSFS not reachable (${errText(e)}).`);
      return;
    }
    if (this.stopped) {
      handle.close();
      return;
    }
    this.handle = handle;
    this.lastFailure = "";
    log.info(`Connected to ${simName}`);

    for (const [name, unit] of VARS) handle.addToDataDefinition(DEF_TELEMETRY, name, unit, SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(DEF_TITLE, "TITLE", null, SimConnectDataType.STRING256);
    handle.addToDataDefinition(DEF_IDENT, "ATC ID", null, SimConnectDataType.STRING32);
    handle.addToDataDefinition(DEF_IDENT, "ATC MODEL", null, SimConnectDataType.STRING64);
    handle.requestDataOnSimObject(REQ_IDENT, DEF_IDENT, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED);

    handle.requestDataOnSimObject(REQ_TELEMETRY, DEF_TELEMETRY, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME);
    handle.requestDataOnSimObject(
      REQ_TITLE,
      DEF_TITLE,
      SimConnectConstants.OBJECT_ID_USER,
      SimConnectPeriod.SECOND,
      DataRequestFlag.DATA_REQUEST_FLAG_CHANGED,
    );
    this.extras = EMPTY_EXTRAS;
    this.extrasSendIds.clear();
    for (const x of EXTRAS) {
      const sendId = handle.addToDataDefinition(x.def, x.name, x.units, SimConnectDataType.FLOAT64);
      this.extrasSendIds.set(sendId, x.name);
      if (x.slow) handle.requestDataOnSimObject(x.req, x.def, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED);
      else handle.requestDataOnSimObject(x.req, x.def, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME);
    }
    handle.subscribeToSystemEvent(EVT_PAUSE, "Pause");
    handle.subscribeToSystemEvent(EVT_SIM, "Sim");

    handle.on("simObjectData", (r) => {
      const x = EXTRAS.find((e) => e.req === r.requestID);
      if (x) {
        const v = r.data.readFloat64();
        if (Number.isFinite(v)) {
          this.extras = { ...this.extras, [x.key]: v };
          const now = Date.now();
          for (const cb of this.extrasCbs) cb(this.extras, now);
        }
        return;
      }
      if (r.requestID === REQ_TELEMETRY) {
        let t: Telemetry;
        try {
          t = decode(r.data);
        } catch (e) {
          log.warn(`bad telemetry packet: ${errText(e)}`);
          return;
        }
        const now = Date.now();
        for (const cb of this.sampleCbs) cb(t, now);
      } else if (r.requestID === REQ_IDENT) {
        try {
          const atcId = r.data.readString32().trim();
          const atcModel = cleanModel(r.data.readString64());
          if (atcId !== this.st.atcId || atcModel !== this.st.atcModel) this.setStatus({ atcId, atcModel });
        } catch {
          /* an aircraft without them */
        }
      } else if (r.requestID === REQ_TITLE) {
        const title = r.data.readString256().trim();
        if (title !== this.st.aircraftTitle) log.info(`Aircraft: ${title || "(none)"}`);
        this.setStatus({ aircraftTitle: title });
      }
    });
    handle.on("event", (e) => {
      if (e.clientEventId === EVT_PAUSE) this.setStatus({ paused: e.data !== 0 });
      else if (e.clientEventId === EVT_SIM) {
        this.extras = { ...this.extras, simRunning: e.data !== 0 ? 1 : 0 };
        const now = Date.now();
        for (const cb of this.extrasCbs) cb(this.extras, now);
      }
    });
    handle.on("exception", (ex) => {
      const extra = this.extrasSendIds.get(ex.sendId);
      if (extra) {
        log.warn(`MSFS didn't accept "${extra}" (${ex.exceptionName}). VBuddy will work without that value (some alerts may be unavailable).`);
        return;
      }
      if (this.quietSendIds.has(ex.sendId)) return;
      const what = this.sendLabels.get(ex.sendId);
      log.warn(`SimConnect exception ${ex.exceptionName} (sendId ${ex.sendId}, index ${ex.index})${what ? ` while setting up: ${what}` : ""}`);
    });
    handle.on("quit", () => {
      log.info("MSFS closed the connection.");
      this.handle = null;
      this.emitHandle(null);
      this.scheduleRetry("MSFS quit.");
    });
    handle.on("close", () => {
      if (this.handle !== handle) return;
      this.handle = null;
      this.emitHandle(null);
      this.scheduleRetry("SimConnect connection closed.");
    });
    handle.on("error", (e) => {
      log.warn(`SimConnect error: ${errText(e)}`);
    });

    this.setStatus({ connected: true, simName, detail: undefined });
    this.emitHandle(handle);
  }
}
