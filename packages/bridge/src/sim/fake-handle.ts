import { EventEmitter } from "node:events";
import type { SimStatus } from "@vbuddy/protocol";
import type { ConnectionHandle } from "node-simconnect";

/**
 * For tests: a pretend SimConnect connection to a pretend Fenix. L:vars live in `lvars`; writes change them, reads
 * answer them. `onWrite` lets a test model what the aircraft does in response (a knob moving a radio, say).
 */
export class FakeHandle extends EventEmitter {
  lvars = new Map<string, number>();
  events: Array<{ name: string; data: number }> = [];
  writes: Array<{ name: string; value: number }> = [];
  private defs = new Map<number, string[]>();
  private evNames = new Map<number, string>();
  onWrite: ((name: string, value: number, before: number) => void) | null = null;
  onEvent: ((name: string, data: number) => void) | null = null;
  /** Data definitions the test wants answered for continuous requests: requestId -> values. */
  frames = new Map<number, () => number[]>();
  private reqDef = new Map<number, number>();

  addToDataDefinition(def: number, name: string) {
    this.defs.set(def, [...(this.defs.get(def) ?? []), name]);
    return 1;
  }
  setDataOnSimObject(def: number, _obj: number, data: { buffer: { readFloat64?: () => number; getBuffer?: () => Buffer } }) {
    const names = this.defs.get(def) ?? [];
    const buf = (data.buffer as unknown as { getBuffer(): Buffer }).getBuffer();
    const value = buf.readDoubleLE(0);
    for (const n of names) {
      const key = n.startsWith("L:") ? n.slice(2) : n;
      const before = this.lvars.get(key) ?? 0;
      this.lvars.set(key, value);
      this.writes.push({ name: key, value });
      this.onWrite?.(key, value, before);
    }
    return 1;
  }
  requestDataOnSimObject(req: number, def: number, _obj: number, period: number) {
    this.reqDef.set(req, def);
    // SimConnectPeriod.ONCE = 1: answer right away with the L:var values of that definition.
    if (period === 1) {
      const names = this.defs.get(def) ?? [];
      const values = names.map((n) => this.lvars.get(n.startsWith("L:") ? n.slice(2) : n) ?? 0);
      setTimeout(() => this.emitData(req, values), 2);
    }
    return 1;
  }
  emitData(req: number, values: number[]) {
    let i = 0;
    this.emit("simObjectData", { requestID: req, data: { readFloat64: () => values[i++] ?? 0, readInt32: () => values[i++] ?? 0 } });
  }
  mapClientEventToSimEvent(id: number, name: string) {
    this.evNames.set(id, name);
    return 1;
  }
  addClientEventToNotificationGroup() {
    return 1;
  }
  setNotificationGroupPriority() {
    return 1;
  }
  transmitClientEvent(_obj: number, id: number, data: number) {
    const name = this.evNames.get(id) ?? String(id);
    this.events.push({ name, data });
    this.onEvent?.(name, data);
    return 1;
  }
  /** The aircraft's input events (names), listed when asked; until `inputsReadyAfter` asks, the list fails (still loading). */
  inputNames: string[] = [];
  inputsReadyAfter = 0;
  enumerations = 0;
  inputWrites: Array<{ name: string; value: number }> = [];
  onInput: ((name: string, value: number) => void) | null = null;
  private hash = (n: string) => BigInt([...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1_000_000_007, 7));
  enumerateInputEvents() {
    this.enumerations++;
    if (this.enumerations > this.inputsReadyAfter && this.inputNames.length) {
      const list = this.inputNames.map((name) => ({ name, inputEventIdHash: this.hash(name) }));
      setTimeout(() => this.emit("inputEventsList", { entryNumber: 0, outOf: 1, inputEventDescriptors: list }), 2);
    }
    return 1;
  }
  /** Input-event values as the aircraft holds them (answered to subscribeInputEvent). */
  inputValues = new Map<string, number>();
  subscribeInputEvent(hash: bigint) {
    const name = this.inputNames.find((n) => this.hash(n) === hash);
    if (name !== undefined) setTimeout(() => this.emit("subscribeInputEvent", { inputEventIdHash: hash, value: this.inputValues.get(name) ?? 0 }), 1);
    return 1;
  }
  setInputEvent(hash: bigint, value: number) {
    const name = this.inputNames.find((n) => this.hash(n) === hash) ?? String(hash);
    this.inputWrites.push({ name, value });
    this.onInput?.(name, value);
    return 1;
  }
  asHandle() {
    return this as unknown as ConnectionHandle;
  }
}

/** A pretend simulator connection around a FakeHandle. */
export function fakeSim(title: string) {
  const h = new FakeHandle();
  let handleCb: ((h: ConnectionHandle | null) => void) | null = null;
  const statusCbs: Array<(s: SimStatus) => void> = [];
  const status = { connected: true, paused: false, aircraftTitle: title, simName: "MSFS 2024" } as unknown as SimStatus;
  return {
    h,
    sim: {
      onHandle: (cb: (h: ConnectionHandle | null) => void) => void (handleCb = cb),
      onStatus: (cb: (s: SimStatus) => void) => void statusCbs.push(cb),
      status: () => status,
    },
    connect() {
      handleCb?.(h.asHandle());
      for (const cb of statusCbs) cb(status);
    },
  };
}
