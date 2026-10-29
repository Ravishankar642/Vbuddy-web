import { emptySystems, type SimStatus, type SystemsSnapshot } from "@vbuddy/protocol";
import { DataRequestFlag, RawBuffer, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type ConnectionHandle } from "node-simconnect";
import type { Logger } from "../log.js";
import { assignPath, detectAircraftProfile, displayTransform, HIGH_VARS, LOW_VARS, MED_VARS, profileOverlays, readGroup, type SystemsProfile, type VarDef } from "./systems-vars.js";

/** Where the Systems page gets its numbers. */
export interface SystemsSource {
  snapshot(): SystemsSnapshot | null;
  onChange(cb: () => void): void;
}

/* Ids kept clear of the other SimConnect users in the bridge. */
const GROUP_IDS = { high: 800, med: 801, low: 802 } as const;
const LVAR_DEF_BASE = 820;
const ONE_SHOT_BASE = 5000;
const ONE_SHOT_TIMEOUT_MS = 1000;
/** The Fenix needs ~15 cockpit variables, FlyByWire ~7. Read once a second at most. */
const OVERLAY_MIN_MS = 1000;
/** Clients get the state at most twice a second; engines change every frame. */
const SEND_MIN_MS = 500;
/** A scratch cockpit variable nothing else uses, written and read back to prove the "L:" channel works. */
const LVAR_PROBE = "VBUDDY_BRIDGE_LVAR_PROBE";

const TYPES: Record<VarDef["type"], SimConnectDataType> = { f64: SimConnectDataType.FLOAT64, i32: SimConnectDataType.INT32, s32: SimConnectDataType.STRING32 };

interface SimLike {
  onHandle(cb: (h: ConnectionHandle | null) => void): void;
  onStatus(cb: (s: SimStatus) => void): void;
  status(): SimStatus;
  labelSend?(sendId: number, what: string): void;
}

/**
 * Reads the aircraft's systems the way Cobalt does: three positional groups (engines every few frames, the rest a few
 * times a second, slow values once a second), with study-aircraft cockpit variables laid over the stock ones.
 */
export class SimSystems implements SystemsSource {
  private s: SystemsSnapshot = emptySystems();
  private live = false;
  private cbs: Array<() => void> = [];
  private h: ConnectionHandle | null = null;
  private title = "";
  private profile: SystemsProfile = "stock";
  private lvarIds = new Map<string, number>();
  private nextLvarId = LVAR_DEF_BASE;
  private lvarChannel: boolean | null = null;
  private lvarProbe: Promise<boolean> | null = null;
  private pending = new Map<number, (v: number) => void>();
  private nextOneShot = ONE_SHOT_BASE;
  private overlayBusy = false;
  private lastOverlay = 0;
  private lastSend = 0;
  private sendTimer: NodeJS.Timeout | null = null;

  constructor(
    private sim: SimLike,
    private log?: Logger,
  ) {
    sim.onHandle((h) => this.attach(h));
    sim.onStatus((st) => {
      if (!st.connected) {
        this.live = false;
        this.emitNow();
      } else if (st.aircraftTitle !== this.title) {
        this.title = st.aircraftTitle;
        this.profile = detectAircraftProfile(this.title);
        this.s.profile = this.profile;
      }
    });
  }

  snapshot() {
    return this.live ? this.s : null;
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }

  /** paused: nobody is looking, or landing (the sim isn't asked for any of it); lite: read less often. */
  private mode = { paused: false, lite: false };
  setMode(m: { paused: boolean; lite: boolean }) {
    if (m.paused === this.mode.paused && m.lite === this.mode.lite) return;
    this.mode = { ...m };
    if (this.h) this.requestGroups(this.h);
  }

  /**
   * The app shows these twice a second at most: engines every 10th frame, the rest every 30th (6 and 2 a second at
   * 60 fps), both only when something changed; the slow group once a second. Lite: a third as often. Paused: none.
   */
  private requestGroups(h: ConnectionHandle) {
    const tag = (id: number, what: string) => this.sim.labelSend?.(id, what);
    const { paused, lite } = this.mode;
    const frame = paused ? SimConnectPeriod.NEVER : SimConnectPeriod.SIM_FRAME;
    try {
      tag(h.requestDataOnSimObject(GROUP_IDS.high, GROUP_IDS.high, SimConnectConstants.OBJECT_ID_USER, frame, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED, 0, lite ? 30 : 10, 0), "systems request (engines)");
      tag(h.requestDataOnSimObject(GROUP_IDS.med, GROUP_IDS.med, SimConnectConstants.OBJECT_ID_USER, frame, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED, 0, lite ? 90 : 30, 0), "systems request");
      tag(h.requestDataOnSimObject(GROUP_IDS.low, GROUP_IDS.low, SimConnectConstants.OBJECT_ID_USER, paused ? SimConnectPeriod.NEVER : SimConnectPeriod.SECOND, 0, 0, lite ? 3 : 1, 0), "systems request (slow)");
    } catch (e) {
      this.log?.warn(`Couldn't change the systems reads: ${(e as Error).message}`);
    }
  }

  private emitNow() {
    this.lastSend = Date.now();
    for (const cb of this.cbs) cb();
  }
  private emitSoon() {
    if (this.sendTimer) return;
    const wait = Math.max(0, SEND_MIN_MS - (Date.now() - this.lastSend));
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      this.emitNow();
    }, wait);
    this.sendTimer.unref?.();
  }

  private attach(h: ConnectionHandle | null) {
    this.h = h;
    this.live = false;
    this.title = this.sim.status().aircraftTitle ?? "";
    this.profile = detectAircraftProfile(this.title);
    this.s = emptySystems();
    this.s.profile = this.profile;
    this.lvarIds.clear();
    this.nextLvarId = LVAR_DEF_BASE;
    this.lvarChannel = null;
    this.lvarProbe = null;
    for (const [, done] of this.pending) done(Number.NaN);
    this.pending.clear();
    if (!h) return this.emitNow();

    const groups: Array<[number, VarDef[]]> = [
      [GROUP_IDS.high, HIGH_VARS],
      [GROUP_IDS.med, MED_VARS],
      [GROUP_IDS.low, LOW_VARS],
    ];
    for (const [id, defs] of groups)
      for (const d of defs) this.sim.labelSend?.(h.addToDataDefinition(id, d.name, d.unit || null, TYPES[d.type]), `Systems: ${d.name}`);

    this.requestGroups(h);

    h.on("simObjectData", (r) => {
      if (h !== this.h) return;
      const once = this.pending.get(r.requestID);
      if (once) {
        this.pending.delete(r.requestID);
        once(r.data.readFloat64());
        return;
      }
      const defs = r.requestID === GROUP_IDS.high ? HIGH_VARS : r.requestID === GROUP_IDS.med ? MED_VARS : r.requestID === GROUP_IDS.low ? LOW_VARS : null;
      if (!defs) return;
      try {
        readGroup(this.s, r.data, defs, this.overlaidPaths());
      } catch (e) {
        this.log?.warn(`Couldn't read the systems data: ${(e as Error).message}`);
        return;
      }
      this.live = true;
      this.emitSoon();
      if (r.requestID === GROUP_IDS.med) this.maybeOverlay();
    });
  }

  /* ---------------- study-aircraft overlay */

  private overlaidFor = "";
  private overlaidSet = new Set<string>();
  /** Paths the aircraft's own variables own; only once the "L:" channel is proven, so stock values keep flowing otherwise. */
  private overlaidPaths(): Set<string> {
    if (this.lvarChannel !== true) return EMPTY;
    if (this.overlaidFor !== this.profile) {
      this.overlaidFor = this.profile;
      this.overlaidSet = new Set(profileOverlays(this.profile).filter((o) => o.always).map((o) => o.path));
    }
    return this.overlaidSet;
  }

  private maybeOverlay() {
    if (this.mode.paused || this.overlayBusy || Date.now() - this.lastOverlay < (this.mode.lite ? OVERLAY_MIN_MS * 3 : OVERLAY_MIN_MS)) return;
    const list = profileOverlays(this.profile);
    if (!list.length) return;
    this.lastOverlay = Date.now();
    this.overlayBusy = true;
    void (async () => {
      try {
        if (!(await this.lvarChannelReady())) return;
        let changed = false;
        for (const o of list) {
          const v = await this.readLVar(o.lvar);
          if (v === null) continue;
          if (o.boolean) {
            const on = v > 0.5;
            assignPath(this.s, o.path, o.invert ? !on : on);
          } else assignPath(this.s, o.path, displayTransform(o.path, v));
          changed = true;
        }
        if (changed) this.emitSoon();
      } finally {
        this.overlayBusy = false;
      }
    })();
  }

  private lvarDef(name: string): number | null {
    const have = this.lvarIds.get(name);
    if (have !== undefined) return have;
    if (!this.h) return null;
    const id = this.nextLvarId++;
    try {
      this.sim.labelSend?.(this.h.addToDataDefinition(id, `L:${name}`, "number", SimConnectDataType.FLOAT64), `cockpit variable ${name}`);
    } catch {
      return null;
    }
    this.lvarIds.set(name, id);
    return id;
  }

  private readOnce(def: number): Promise<number | null> {
    const h = this.h;
    if (!h) return Promise.resolve(null);
    const req = this.nextOneShot++;
    if (this.nextOneShot > ONE_SHOT_BASE + 999) this.nextOneShot = ONE_SHOT_BASE;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req);
        resolve(null);
      }, ONE_SHOT_TIMEOUT_MS);
      this.pending.set(req, (v) => {
        clearTimeout(timer);
        resolve(Number.isFinite(v) ? v : null);
      });
      try {
        h.requestDataOnSimObject(req, def, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.ONCE, 0, 0, 0, 0);
      } catch {
        clearTimeout(timer);
        this.pending.delete(req);
        resolve(null);
      }
    });
  }

  private readLVar(name: string) {
    const def = this.lvarDef(name);
    return def === null ? Promise.resolve(null) : this.readOnce(def);
  }

  private writeLVar(name: string, value: number): boolean {
    const def = this.lvarDef(name);
    if (!this.h || def === null) return false;
    try {
      const b = new RawBuffer(8);
      b.writeFloat64(value);
      this.h.setDataOnSimObject(def, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
      return true;
    } catch {
      return false;
    }
  }

  /** Simulators before 2020 SU12 can't read cockpit variables this way; prove it once per connection. */
  private lvarChannelReady(): Promise<boolean> {
    if (this.lvarChannel !== null) return Promise.resolve(this.lvarChannel);
    if (this.lvarProbe) return this.lvarProbe;
    this.lvarProbe = (async () => {
      const marker = 1 + Math.floor(Math.random() * 1000);
      if (!this.writeLVar(LVAR_PROBE, marker)) return (this.lvarChannel = false);
      const read = await this.readLVar(LVAR_PROBE);
      this.lvarChannel = read !== null && Math.abs(read - marker) < 0.5;
      this.log?.info(this.lvarChannel ? "Cockpit variables can be read; study-aircraft systems use them." : "Cockpit variables can't be read on this simulator; the Systems page uses the standard values only.");
      return this.lvarChannel;
    })();
    return this.lvarProbe;
  }
}
const EMPTY = new Set<string>();

/** A gently moving cruise, for the mock bridge and screenshots. */
export class MockSystems implements SystemsSource {
  private cbs: Array<() => void> = [];
  private t = 0;
  private snap: SystemsSnapshot;
  constructor(private jet = true) {
    this.snap = this.make();
    setInterval(() => {
      this.t++;
      this.snap = this.make();
      for (const cb of this.cbs) cb();
    }, 1000).unref();
  }
  snapshot() {
    return this.snap;
  }
  onChange(cb: () => void) {
    this.cbs.push(cb);
  }
  private make(): SystemsSnapshot {
    const s = emptySystems();
    const w = Math.sin(this.t / 7);
    s.engines.count = 2;
    for (const [i, e] of [s.engines.eng1, s.engines.eng2].entries()) {
      Object.assign(e, {
        running: true,
        engineType: this.jet ? "jet" : "turboprop",
        n1: Math.round((84 + w * (i ? -1 : 1)) * 10) / 10,
        n2: 91.2,
        egt: 584 + i * 9,
        fuelFlow: Math.round(1500 + w * 20),
        oilPressure: 62 - i,
        oilTemp: 155 + i,
        vibration: 0.6 + i / 10,
        torquePct: this.jet ? 0 : 78,
        rpm: this.jet ? 0 : 1020,
      });
    }
    Object.assign(s.fuel, { totalGal: Math.round((4800 - this.t * 0.4) * 10) / 10, totalLbs: Math.round(32200 - this.t * 2.6), left: 1900, right: 1900, center: Math.round(1000 - this.t * 0.4), capacity: 6400, weightPerGal: 6.7 });
    Object.assign(s.autopilot, { apMaster: true, fdActive: true, apAltHold: true, apAltTarget: 36000, apHDGHold: true, apHDGTarget: 270, apSpdTarget: 280, apMachTarget: 0.78, apNAVHold: true, autothrottleActive: true, autothrottleArmed: true });
    Object.assign(s.surfaces, { flapsHandle: 0, flapsDetents: 4, gearHandle: false, gearExtended: 0, gearLeft: 0, gearRight: 0, gearNose: 0 });
    Object.assign(s.electrical, { busVoltage: 28.1, batteryVoltage: 27.6, hydPressure1: 3000, hydPressure2: 3010 });
    Object.assign(s.pressurization, { cabinAlt: 6200, diffPressure: 7.4, cabinRate: 0 });
    Object.assign(s.navigation, { wpNextId: "BUBIM", wpDistanceNm: Math.max(0, Math.round((48 - this.t * 0.1) * 10) / 10), wpEteSec: 1500 - this.t, destEteSec: 5400 - this.t, com1Active: 124.825, com1Standby: 121.5, com2Active: 121.5, com2Standby: 122.8, nav1Active: 110.3, xpdrCode: 2764, xpdrState: 4, baroMb: 1013.2 });
    Object.assign(s.lights, { beacon: true, nav: true, strobe: true, logo: true });
    Object.assign(s.environment, { oat: -48, windSpeed: 62, windDir: 280, qnh: 1013.2 });
    Object.assign(s.systems, { pitotHeat: true, seatbeltSign: true });
    Object.assign(s.meta, { onGround: false, simRate: 1, maxSimRate: 1 });
    s.weight.grossWeight = 142000;
    return s;
  }
}
