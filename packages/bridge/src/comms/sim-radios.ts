import type { SimStatus } from "@vbuddy/protocol";
import { DataRequestFlag, EventFlag, RawBuffer, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type ConnectionHandle } from "node-simconnect";
import type { RadioBackend, RadioValues } from "./backend.js";
import { addonOf, comFrequencyMatches, FENIX_RMP, rmpChannelIndex, rmpTuneClicks } from "../panel/addons.js";
import { LVarChannel } from "../sim/lvars.js";

/** SimConnect ids for L:var reads and writes here (the panel uses 3000-3199). */
const LVAR_IDS = 3300;
/** Cobalt: up to three passes to close in on a frequency; each waits up to 1.2 s for the radio to move. */
const RMP_TUNE_PASSES = 3;
const RMP_SETTLE_MS = 1200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEF_COMMS = 50;
const REQ_COMMS = 50;
const DEF_XPDR_STATE = 51;
const DEF_FREQ_BASE = 60;
const DEF_LISTEN_BASE = 64;
const EVENT_BASE = 200;
/** A real notification group: SimConnect rejects events sent to a group id it has never been told about (UNRECOGNIZED_ID). */
const GROUP_RADIOS = 60;
const GROUP_PRIORITY_HIGHEST = 1;

const VARS: Array<[string, string]> = [
  ["COM ACTIVE FREQUENCY:1", "Hz"],
  ["COM STANDBY FREQUENCY:1", "Hz"],
  ["COM ACTIVE FREQUENCY:2", "Hz"],
  ["COM STANDBY FREQUENCY:2", "Hz"],
  ["TRANSPONDER CODE:1", "Bco16"],
  ["TRANSPONDER STATE:1", "Enum"],
  ["TRANSPONDER IDENT:1", "Bool"],
  ["COM RECEIVE:1", "Bool"],
  ["COM RECEIVE:2", "Bool"],
];

const EVENTS = {
  com1Active: "COM_RADIO_SET_HZ",
  com2Active: "COM2_RADIO_SET_HZ",
  com1Standby: "COM_STBY_RADIO_SET_HZ",
  com2Standby: "COM2_STBY_RADIO_SET_HZ",
  com1Swap: "COM_STBY_RADIO_SWAP",
  com2Swap: "COM2_RADIO_SWAP",
  com1ActiveBcd: "COM_RADIO_SET",
  com2ActiveBcd: "COM2_RADIO_SET",
  com1StandbyBcd: "COM_STBY_RADIO_SET",
  com2StandbyBcd: "COM2_STBY_RADIO_SET",
  com1Listen: "COM1_RECEIVE_SELECT",
  com2Listen: "COM2_RECEIVE_SELECT",
  xpdrSet: "XPNDR_SET",
  xpdrIdent: "XPNDR_IDENT_ON",
} as const;
type EventKey = keyof typeof EVENTS;

interface SimLike {
  onHandle(cb: (h: ConnectionHandle | null) => void): void;
  onStatus(cb: (s: SimStatus) => void): void;
  status(): SimStatus;
  labelSend?(sendId: number, what: string): void;
}

const XPDR_MODE: Record<number, "off" | "stby" | "alt"> = { 0: "off", 1: "stby", 4: "alt" };

/**
 * COM1/COM2 and the transponder, read from SimConnect whenever one changes and set with the
 * simulator's own radio events (the same ones the old VBuddy plugin used). vPilot follows the sim's radios,
 * so tuning here is what vPilot hears on.
 */
export class SimRadios implements RadioBackend {
  private h: ConnectionHandle | null = null;
  private v: RadioValues | null = null;
  private cbs: Array<() => void> = [];
  private ids = new Map<EventKey, number>();
  private stateDefReady = false;
  private freqDefs = new Set<number>();
  private lv: LVarChannel | null = null;

  constructor(private sim: SimLike) {
    sim.onHandle((h) => this.attach(h));
    sim.onStatus((s) => {
      if (!s.connected) this.set(null);
    });
  }

  private attach(h: ConnectionHandle | null) {
    this.h = h;
    this.ids.clear();
    this.stateDefReady = false;
    this.freqDefs.clear();
    this.set(null);
    this.lv = h ? new LVarChannel(h, LVAR_IDS) : null;
    if (!h) return;
    for (const [name, unit] of VARS) this.sim.labelSend?.(h.addToDataDefinition(DEF_COMMS, name, unit, SimConnectDataType.FLOAT64), name);
    h.on("simObjectData", (r) => {
      if (r.requestID !== REQ_COMMS || h !== this.h) return;
      const n = VARS.map(() => r.data.readFloat64());
      const code = Math.round(n[4]!).toString(16).padStart(4, "0"); // Bco16: each digit is a hex nibble (squawk 1200 arrives as 0x1200 = 4608)
      const state = Math.round(n[5]!);
      this.set({
        radios: {
          com1: { active: Math.round(n[0]!), standby: Math.round(n[1]!), rx: n[7]! > 0 },
          com2: { active: Math.round(n[2]!), standby: Math.round(n[3]!), rx: n[8]! > 0 },
        },
        xpdr: { code: /^[0-7]{4}$/.test(code) ? code : "0000", mode: XPDR_MODE[state] ?? "other", ident: n[6]! > 0 },
      });
    });
    this.sim.labelSend?.(h.requestDataOnSimObject(REQ_COMMS, DEF_COMMS, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED), "radios request");
  }

  private set(v: RadioValues | null) {
    this.v = v;
    for (const cb of this.cbs) cb();
  }
  values() {
    return this.v;
  }
  onValues(cb: () => void) {
    this.cbs.push(cb);
  }

  private fire(key: EventKey, data: number): boolean {
    const h = this.h;
    if (!h || !this.v) return false;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = EVENT_BASE + this.ids.size;
      h.mapClientEventToSimEvent(id, EVENTS[key]);
      h.addClientEventToNotificationGroup(GROUP_RADIOS, id, false);
      h.setNotificationGroupPriority(GROUP_RADIOS, GROUP_PRIORITY_HIGHEST);
      this.ids.set(key, id);
    }
    h.transmitClientEvent(SimConnectConstants.OBJECT_ID_USER, id, data, GROUP_RADIOS, EventFlag.EVENT_FLAG_DEFAULT);
    return true;
  }

  /**
   * Tunes a radio. Aircraft differ in which way in they listen, so this tries the sim's Hz event first, then the
   * classic BCD event, then writes the frequency variable directly, moving on only if the radio didn't change.
   */
  setCom(radio: 1 | 2, which: "active" | "standby", hz: number) {
    if (!this.h || !this.v) return false;
    if (this.isFenix()) {
      // The Fenix ignores the simulator's frequency events: turn its radio panel's knobs instead (as Cobalt does).
      void this.fenixSetCom(radio, which, hz).then((r) => {
        if (r === null) this.stockSetCom(radio, which, hz);
      });
      return true;
    }
    return this.stockSetCom(radio, which, hz);
  }

  private isFenix() {
    return addonOf(this.sim.status().aircraftTitle ?? "") === "fenix";
  }

  private mhz(radio: 1 | 2, which: "active" | "standby"): number | null {
    const r = this.v?.radios?.[radio === 1 ? "com1" : "com2"];
    return r ? r[which] / 1e6 : null;
  }

  /** Waits for a radio to leave `from`, then lets the knob settle (Cobalt: waitForComChange). */
  private async waitChange(radio: 1 | 2, which: "active" | "standby", from: number): Promise<number | null> {
    let latest: number | null = null;
    for (let t = 0; t < RMP_SETTLE_MS; t += 250) {
      await sleep(250);
      const now = this.mhz(radio, which);
      if (now === null) continue;
      latest = now;
      if (!comFrequencyMatches(now, from)) {
        await sleep(250);
        return this.mhz(radio, which) ?? now;
      }
    }
    return latest;
  }

  /**
   * Fenix RMP: outer knob 1 MHz a click, inner knob one channel a click (or four when the RMP is in 25 kHz spacing:
   * the first pass sends one inner click to find out). Active has no direct entry, so it is standby then transfer.
   * True: reached; false: the knobs moved but didn't get there; null: not possible here (use the standard events).
   */
  private async fenixSetCom(radio: 1 | 2, which: "active" | "standby", hz: number): Promise<boolean | null> {
    if (!this.lv || !(await this.lv.ready())) return null;
    const target = hz / 1e6;
    if (which === "active") {
      const active = this.mhz(radio, "active");
      if (active !== null && comFrequencyMatches(active, target)) return true;
      const tuned = await this.fenixSetCom(radio, "standby", hz);
      if (tuned !== true) return tuned;
      return this.fenixSwap(radio);
    }
    const rmp = FENIX_RMP[radio];
    let current = this.mhz(radio, "standby");
    if (current === null || current < 100) return null;
    let perClick = 1;
    let moved = false;
    for (let pass = 0; pass < RMP_TUNE_PASSES; pass++) {
      if (comFrequencyMatches(current, target)) break;
      const c = rmpTuneClicks(current, target, perClick);
      const inner = pass === 0 ? Math.sign(c.inner) : c.inner;
      if (c.outer === 0 && inner === 0) break;
      if (c.outer !== 0) await this.lv.add(rmp.outer, c.outer);
      if (inner !== 0) await this.lv.add(rmp.inner, inner);
      const after = await this.waitChange(radio, "standby", current);
      if (after === null || comFrequencyMatches(after, current)) break;
      moved = true;
      if (pass === 0 && inner !== 0 && Math.abs(rmpChannelIndex(after) - rmpChannelIndex(current)) === 4) perClick = 4;
      current = after;
    }
    if (comFrequencyMatches(current, target)) return true;
    return moved ? false : null;
  }

  /** Fenix RMP transfer key, checked against the active frequency; the standard swap event if the key did nothing. */
  private async fenixSwap(radio: 1 | 2): Promise<boolean | null> {
    if (!this.lv || !(await this.lv.ready())) return null;
    const before = this.mhz(radio, "active");
    const standby = this.mhz(radio, "standby");
    await this.lv.press(FENIX_RMP[radio].xfer);
    // Pressed but can't be checked: don't send the standard swap too (it could swap straight back).
    if (before === null) return true;
    if (standby !== null && comFrequencyMatches(standby, before)) return true;
    let after = await this.waitChange(radio, "active", before);
    if (after === null || comFrequencyMatches(after, before)) {
      this.fire(radio === 1 ? "com1Swap" : "com2Swap", 0);
      after = await this.waitChange(radio, "active", before);
    }
    return after !== null && !comFrequencyMatches(after, before);
  }

  private stockSetCom(radio: 1 | 2, which: "active" | "standby", hz: number) {
    if (!this.h || !this.v) return false;
    const name = which === "active" ? "Active" : "Standby";
    const reached = () => {
      const r = this.v?.radios?.[`com${radio}` as "com1" | "com2"];
      return !!r && Math.abs(r[which] - hz) < 5000;
    };
    const attempts: Array<() => void> = [
      () => void this.fire(`com${radio}${name}` as EventKey, hz),
      () => void this.fire(`com${radio}${name}Bcd` as EventKey, parseInt(String(Math.round((hz - 100_000_000) / 10_000)).padStart(4, "0"), 16)),
      () => this.writeFreq(radio, which, hz),
    ];
    const run = (i: number) => {
      if (i >= attempts.length || this.h === null) return;
      attempts[i]!();
      setTimeout(() => {
        if (!reached()) run(i + 1);
      }, 600);
    };
    run(0);
    return true;
  }
  private writeFreq(radio: 1 | 2, which: "active" | "standby", hz: number) {
    const h = this.h;
    if (!h) return;
    const def = DEF_FREQ_BASE + (radio - 1) * 2 + (which === "active" ? 0 : 1);
    if (!this.freqDefs.has(def)) {
      h.addToDataDefinition(def, `COM ${which === "active" ? "ACTIVE" : "STANDBY"} FREQUENCY:${radio}`, "Hz", SimConnectDataType.FLOAT64);
      this.freqDefs.add(def);
    }
    const b = new RawBuffer(8);
    b.writeFloat64(hz);
    h.setDataOnSimObject(def, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
  }
  /** The audio panel's receive switch: the sim's select event first, then the variable itself. */
  setListen(radio: 1 | 2, on: boolean) {
    if (!this.h || !this.v?.radios) return false;
    const key = radio === 1 ? "com1" : "com2";
    const reached = () => this.v?.radios?.[key].rx === on;
    if (reached()) return true;
    const attempts: Array<() => void> = [() => void this.fire(`com${radio}Listen` as EventKey, 0), () => this.writeListen(radio, on)];
    const run = (i: number) => {
      if (i >= attempts.length || this.h === null) return;
      attempts[i]!();
      setTimeout(() => {
        if (!reached()) run(i + 1);
      }, 600);
    };
    run(0);
    return true;
  }
  private writeListen(radio: 1 | 2, on: boolean) {
    const h = this.h;
    if (!h) return;
    const def = DEF_LISTEN_BASE + radio;
    if (!this.freqDefs.has(def)) {
      h.addToDataDefinition(def, `COM RECEIVE:${radio}`, "Bool", SimConnectDataType.FLOAT64);
      this.freqDefs.add(def);
    }
    const b = new RawBuffer(8);
    b.writeFloat64(on ? 1 : 0);
    h.setDataOnSimObject(def, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
  }
  swapCom(radio: 1 | 2) {
    if (this.isFenix() && this.h && this.v) {
      void this.fenixSwap(radio).then((r) => {
        if (r === null) this.fire(radio === 1 ? "com1Swap" : "com2Swap", 0);
      });
      return true;
    }
    return this.fire(radio === 1 ? "com1Swap" : "com2Swap", 0);
  }
  setXpdrCode(code: string) {
    return this.fire("xpdrSet", parseInt(code, 16)); // the event takes the four digits as BCD
  }
  setXpdrMode(mode: "stby" | "alt") {
    const h = this.h;
    if (!h || !this.v) return false;
    if (!this.stateDefReady) {
      h.addToDataDefinition(DEF_XPDR_STATE, "TRANSPONDER STATE:1", "Enum", SimConnectDataType.FLOAT64);
      this.stateDefReady = true;
    }
    const b = new RawBuffer(8);
    b.writeFloat64(mode === "alt" ? 4 : 1);
    h.setDataOnSimObject(DEF_XPDR_STATE, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
    return true;
  }
  ident() {
    return this.fire("xpdrIdent", 1);
  }
}
