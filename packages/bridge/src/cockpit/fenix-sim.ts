import type { SimStatus } from "@vbuddy/protocol";
import { DataRequestFlag, RawBuffer, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type ConnectionHandle } from "node-simconnect";
import type { Logger } from "../log.js";
import type { CockpitBackend, ControlPath } from "./backend.js";
import { emptyValues, isFenix, READ_VARS, type FenixValues, type FenixVar } from "./fenix-vars.js";

// IDs well away from the telemetry ones (1-5).
const DEF_FCU = 40;
const REQ_FCU = 40;
const DEF_WRITE_BASE = 100; // one write definition per variable, created when first needed
const CD_MOBIFLIGHT = 60; // client data area id
const CD_DEF_MOBIFLIGHT = 60;
const MF_SIZE = 1024;
/** Optional: MobiFlight ignores a command identical to the last, so each carries a changing number. */
const SEQ_VAR = "VBUDDY_SEQ";

const PATHS: ControlPath[] = ["mobiflight", "simconnect"];

interface SimLike {
  onHandle(cb: (h: ConnectionHandle | null) => void): void;
  onStatus(cb: (s: SimStatus) => void): void;
  status(): SimStatus;
}

/**
 * The real Fenix A320 over SimConnect. Reads the FCU's L:vars every time one
 * changes. Writes go through the MobiFlight WASM module (runs RPN inside the
 * sim, as the VBuddy vPilot plugin does) or, failing that, direct SimConnect
 * L:var writes.
 */
export class FenixSim implements CockpitBackend {
  readonly aircraft = "fenix-a320" as const;
  private h: ConnectionHandle | null = null;
  private v: FenixValues | null = null;
  private active = false;
  private defsReady = false;
  private cbs: Array<() => void> = [];
  private pathIdx = 0;
  private mfReady = false;
  private seq = 0;
  private writeDefs = new Map<FenixVar, number>();
  /** Last value written per variable, so quick successive adds build on each other. */
  private written = new Map<FenixVar, { value: number; at: number }>();
  private isPaused = false;

  constructor(
    private sim: SimLike,
    private log: Logger,
  ) {
    sim.onHandle((h) => this.attach(h));
    sim.onStatus((s) => {
      this.isPaused = s.paused;
      this.update(s);
    });
  }

  private attach(h: ConnectionHandle | null) {
    this.h = h;
    this.defsReady = false;
    this.mfReady = false;
    this.writeDefs.clear();
    this.active = false;
    this.setValues(null);
    if (!h) return;
    h.on("simObjectData", (r) => {
      if (r.requestID !== REQ_FCU || h !== this.h) return;
      const v = emptyValues();
      for (const n of READ_VARS) v[n] = r.data.readFloat64();
      this.setValues(v);
    });
    this.update(this.sim.status());
  }

  /** Starts or stops reading when a Fenix is (un)loaded. */
  private update(s: SimStatus) {
    const h = this.h;
    if (!h) return;
    const want = s.connected && isFenix(s.aircraftTitle);
    if (want === this.active) return;
    this.active = want;
    if (want) {
      if (!this.defsReady) {
        for (const n of READ_VARS) h.addToDataDefinition(DEF_FCU, `L:${n}`, "number", SimConnectDataType.FLOAT64);
        this.defsReady = true;
      }
      h.requestDataOnSimObject(REQ_FCU, DEF_FCU, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED);
      this.log.info(`Fenix A320 detected (${s.aircraftTitle}): cockpit control available.`);
      this.resetPath();
    } else {
      h.requestDataOnSimObject(REQ_FCU, DEF_FCU, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.NEVER);
      this.setValues(null);
    }
  }

  private setValues(v: FenixValues | null) {
    this.v = v;
    for (const cb of this.cbs) cb();
  }

  values() {
    return this.v;
  }
  onValues(cb: () => void) {
    this.cbs.push(cb);
  }
  paused() {
    return this.isPaused;
  }
  path(): ControlPath {
    return PATHS[this.pathIdx] ?? "none";
  }
  nextPath() {
    this.pathIdx++;
    return this.pathIdx < PATHS.length;
  }
  resetPath() {
    this.pathIdx = 0;
  }

  /* ---------------- MobiFlight WASM: RPN code written to its command channel ---------------- */

  private mf(code: string): boolean {
    const h = this.h;
    if (!h) return false;
    if (!this.mfReady) {
      h.mapClientDataNameToID("MobiFlight.Command", CD_MOBIFLIGHT);
      h.addToClientDataDefinition(CD_DEF_MOBIFLIGHT, 0, MF_SIZE);
      this.mfReady = true;
      this.mfSend("MF.DummyCmd"); // the module ignores the first command from a new connection
    }
    return this.mfSend(`MF.SimVars.Set.${code} ${++this.seq % 100000} (>L:${SEQ_VAR})`);
  }

  private mfSend(cmd: string) {
    const bytes = Buffer.from(cmd, "ascii");
    if (bytes.length >= MF_SIZE) return false;
    const buf = Buffer.alloc(MF_SIZE);
    bytes.copy(buf);
    this.h!.setClientData(CD_MOBIFLIGHT, CD_DEF_MOBIFLIGHT, 0, 0, MF_SIZE, buf);
    return true;
  }

  /* ---------------- direct SimConnect L:var writes ---------------- */

  private scWrite(name: FenixVar, value: number): boolean {
    const h = this.h;
    if (!h) return false;
    let def = this.writeDefs.get(name);
    if (def === undefined) {
      def = DEF_WRITE_BASE + this.writeDefs.size;
      h.addToDataDefinition(def, `L:${name}`, "number", SimConnectDataType.FLOAT64);
      this.writeDefs.set(name, def);
    }
    const b = new RawBuffer(8);
    b.writeFloat64(value);
    h.setDataOnSimObject(def, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
    this.written.set(name, { value, at: Date.now() });
    return true;
  }

  add(name: FenixVar, delta: number): boolean {
    if (!this.v) return false;
    if (this.path() === "mobiflight") return this.mf(`(L:${name}) ${delta} + (>L:${name})`);
    if (this.path() === "simconnect") {
      // Build on our own last write if the sim hasn't reported it back yet.
      const w = this.written.get(name);
      const base = w && Date.now() - w.at < 500 ? w.value : this.v[name];
      return this.scWrite(name, base + delta);
    }
    return false;
  }

  set(name: FenixVar, value: number): boolean {
    if (!this.v) return false;
    if (this.path() === "mobiflight") return this.mf(`${value} (>L:${name})`);
    if (this.path() === "simconnect") return this.scWrite(name, value);
    return false;
  }
}
