import { RawBuffer, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type ConnectionHandle } from "node-simconnect";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long a momentary button is held (Cobalt: BUTTON_PULSE_MS). */
export const BUTTON_PULSE_MS = 120;
const READ_TIMEOUT_MS = 1000;

/**
 * Aircraft L:vars through plain SimConnect, the way Cobalt's bridge drives the Fenix: since MSFS 2020 SU12 (and in
 * MSFS 2024) an "L:" name in a normal data definition can be read and written, no add-on module needed. Older
 * simulator builds refuse it, which the probe finds out once per connection (the caller then uses another way).
 * Each user gets its own block of definition and request ids so they never collide.
 */
export class LVarChannel {
  private defs = new Map<string, number>();
  private nextDef: number;
  private nextReq: number;
  private waiting = new Map<number, (v: number | null) => void>();
  private probe: Promise<boolean> | null = null;

  constructor(
    private h: ConnectionHandle,
    private base: number,
    private size = 200,
  ) {
    this.nextDef = base;
    this.nextReq = base;
    h.on("simObjectData", (r) => {
      const done = this.waiting.get(r.requestID);
      if (!done) return;
      this.waiting.delete(r.requestID);
      done(r.data.readFloat64());
    });
  }

  private def(name: string): number | null {
    const known = this.defs.get(name);
    if (known !== undefined) return known;
    if (this.nextDef >= this.base + this.size) return null;
    const id = this.nextDef++;
    try {
      this.h.addToDataDefinition(id, `L:${name}`, "number", SimConnectDataType.FLOAT64);
    } catch {
      return null;
    }
    this.defs.set(name, id);
    return id;
  }

  read(name: string): Promise<number | null> {
    const def = this.def(name);
    if (def === null) return Promise.resolve(null);
    const req = this.base + ((this.nextReq++ - this.base) % this.size);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(req);
        resolve(null);
      }, READ_TIMEOUT_MS);
      this.waiting.set(req, (v) => {
        clearTimeout(timer);
        resolve(v);
      });
      try {
        this.h.requestDataOnSimObject(req, def, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.ONCE);
      } catch {
        clearTimeout(timer);
        this.waiting.delete(req);
        resolve(null);
      }
    });
  }

  write(name: string, value: number): boolean {
    const def = this.def(name);
    if (def === null) return false;
    try {
      const b = new RawBuffer(8);
      b.writeFloat64(value);
      this.h.setDataOnSimObject(def, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
      return true;
    } catch {
      return false;
    }
  }

  /** Does this simulator read and write L:vars over SimConnect? A scratch variable is written and read back, once. */
  ready(): Promise<boolean> {
    if (!this.probe) {
      this.probe = (async () => {
        const marker = 1 + Math.floor(Math.random() * 1000);
        if (!this.write("VBUDDY_BRIDGE_LVAR_PROBE", marker)) return false;
        const back = await this.read("VBUDDY_BRIDGE_LVAR_PROBE");
        return back !== null && Math.abs(back - marker) < 0.5;
      })();
    }
    return this.probe;
  }

  /** Read-modify-write: counter-style L:vars (knob encoders) move by the difference. */
  async add(name: string, delta: number): Promise<boolean> {
    const cur = await this.read(name);
    if (cur === null) return false;
    return this.write(name, cur + delta);
  }

  /** A Fenix push button: its L:var counts presses and releases, so a press is two increments (Cobalt: pressFenixButton). */
  async press(name: string): Promise<boolean> {
    if (!(await this.add(name, 1))) return false;
    await sleep(BUTTON_PULSE_MS);
    await this.add(name, 1);
    return true;
  }

  /** Wait until the variable reads `want` (within half a step). Null: the variable never answered. */
  async confirm(name: string, want: number, ms = 1500, poll = 250): Promise<boolean | null> {
    let answered = false;
    for (let t = 0; t < ms; t += poll) {
      await sleep(poll);
      const v = await this.read(name);
      if (v === null) continue;
      answered = true;
      if (Math.abs(v - want) < 0.5) return true;
    }
    return answered ? false : null;
  }
}
