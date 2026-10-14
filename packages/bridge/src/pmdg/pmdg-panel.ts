import { familyOf, type ApButton, type ApKnob, type LightId, type PanelState, type SimStatus, type SysId } from "@vbuddy/protocol";
import { ClientDataPeriod, ClientDataRequestFlag, type ConnectionHandle } from "node-simconnect";
import type { Logger } from "../log.js";
import type { PanelBackend, PanelResult } from "../panel/backend.js";
import { findSdkHeader, type FoundSdk } from "./find-sdk.js";
import { NOT_A_BUTTON, NOT_A_LIGHT_SWITCH, PROFILES, pickNames, type FlagSpec, type PmdgKind, type Profile } from "./profiles.js";
import { parseHeader, readField, type Field, type Sdk } from "./sdk.js";

const CHUNK = 256;
const MAX_CLICKS = 150;
const SETTLE_WAIT_MS = 5000;

interface SimLike {
  onHandle(cb: (h: ConnectionHandle | null) => void): void;
  onStatus(cb: (s: SimStatus) => void): void;
  status(): SimStatus;
  labelSend?(sendId: number, what: string): void;
}

export interface PmdgOptions {
  /** Extra folders to look for the SDK headers in. */
  sdkDirs?: string[];
  /** Replaces the disk search (tests). */
  load?: (file: string) => FoundSdk | null;
  /** Divides every wait (tests). */
  speed?: number;
}

interface Resolved {
  vals: Record<"spd" | "hdg" | "alt" | "vs" | "crs", Field | null>;
  flags: Record<ApButton, { f: Field; spec: FlagSpec } | null>;
  press: Record<ApButton, string | null>;
  knobs: Record<ApKnob, string | null>;
  lights: Partial<Record<LightId, string[]>>;
}

interface Runtime {
  profile: Profile;
  index: number;
  sdk: Sdk;
  path: string;
  buf: Buffer;
  chunks: boolean[];
  live: boolean;
  res: Resolved;
  dataName: string;
  controlName: string;
}

const BUTTONS: ApButton[] = ["cmd", "fd", "athr", "speed", "lvlChg", "hdgSel", "lnav", "app", "altHld", "vs"];
const KNOBS: ApKnob[] = ["spd", "hdg", "alt", "vs", "crs"];
const LIGHTS: LightId[] = ["nav", "strobe", "beacon", "landing", "taxi", "wing", "logo", "recognition"];
const BUTTON_NAMES: Record<ApButton, string> = {
  cmd: "A/P engage",
  fd: "F/D",
  athr: "A/T arm",
  speed: "SPEED",
  lvlChg: "LVL CHG",
  hdgSel: "HDG SEL",
  lnav: "LNAV",
  app: "APP",
  altHld: "ALT HOLD",
  vs: "V/S",
};

const sleepReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The autopilot panel and lights of a PMDG 737 / 777, driven the way PMDG documents: the cockpit state is read from
 * the aircraft's client data area, and buttons, knobs and switches are sent as PMDG events written to its control area.
 * Event numbers and the data layout come from the SDK header installed with the aircraft.
 * Any other aircraft (and a PMDG whose SDK file can't be found) is handled by `base`.
 */
export class PmdgPanel implements PanelBackend {
  private h: ConnectionHandle | null = null;
  private cbs: Array<() => void> = [];
  private runtimes = new Map<PmdgKind, Runtime | null>();
  private title = "";
  private problem: string | null = null;
  private note: string | null = null;
  private lastJson = "";
  private queue: Promise<void> = Promise.resolve();
  private gen = new Map<ApKnob, number>();
  private learnedKnob = new Map<ApKnob, number>();
  private learnedLight = new Map<string, number>();
  private liveTimer: NodeJS.Timeout | null = null;
  private pending = false;
  private readonly speed: number;
  private readonly load: (file: string) => FoundSdk | null;

  constructor(
    private sim: SimLike,
    private base: PanelBackend,
    private log: Logger,
    opts: PmdgOptions = {},
  ) {
    this.speed = opts.speed ?? 1;
    this.load = opts.load ?? ((file) => findSdkHeader(file, opts.sdkDirs ?? []));
    base.onChange(() => this.changed());
    sim.onHandle((h) => this.attach(h));
    sim.onStatus((s) => {
      if (!s.connected) return;
      if (s.aircraftTitle !== this.title) this.titleChanged(s.aircraftTitle);
    });
  }

  /* ---------------------------------------------------------------- state */

  state(): PanelState | null {
    const b = this.base.state();
    if (!b) return null;
    const profile = this.profileFor(this.title);
    if (!profile) return b;
    const rt = this.activeRuntime();
    // No SDK data: keep the standard readings so the add-on fallback in SimPanel can still work, and say what is missing.
    if (!rt) return { ...b, family: "boeing", note: b.note ?? this.problem };
    return { ...b, family: "boeing", ap: this.ap(rt), note: this.note };
  }

  onChange(cb: () => void) {
    this.cbs.push(cb);
  }

  private changed() {
    const json = JSON.stringify(this.state());
    if (json === this.lastJson) return;
    this.lastJson = json;
    for (const cb of this.cbs) cb();
  }

  private profileFor(title: string): Profile | undefined {
    return PROFILES.find((p) => p.isTitle(title));
  }

  private activeRuntime(): Runtime | null {
    const p = this.profileFor(this.title);
    if (!p) return null;
    const rt = this.runtimes.get(p.kind);
    return rt?.live ? rt : null;
  }

  private num(rt: Runtime, f: Field | null, ...idx: number[]): number | null {
    return f && rt.sdk.layout ? readField(rt.sdk.layout, rt.buf, f, ...idx) : null;
  }

  private flag(rt: Runtime, key: ApButton): boolean | null {
    const r = rt.res.flags[key];
    if (!r) return null;
    const { f, spec } = r;
    const count = f.dims.reduce((a, b) => a * b, 1);
    let on: boolean;
    if (spec.index === "any") on = Array.from({ length: count }, (_, i) => this.num(rt, f, i) ?? 0).some((v) => v !== 0);
    else on = (this.num(rt, f, spec.index ?? 0) ?? 0) !== 0;
    return spec.invert ? !on : on;
  }

  private ap(rt: Runtime): PanelState["ap"] {
    const v = rt.res.vals;
    const ias = this.num(rt, v.spd);
    const hdg = this.num(rt, v.hdg);
    const alt = this.num(rt, v.alt);
    const vs = this.num(rt, v.vs);
    if (ias === null || hdg === null || alt === null || vs === null) return null;
    const mach = ias > 0 && ias < 10;
    const f = (k: ApButton) => this.flag(rt, k) === true;
    return {
      master: f("cmd"),
      fd: f("fd"),
      athr: f("athr"),
      speed: f("speed"),
      lvlChg: f("lvlChg"),
      hdgSel: f("hdgSel"),
      lnav: f("lnav"),
      app: f("app"),
      altHld: f("altHld"),
      vs: f("vs"),
      machMode: mach,
      spd: mach ? Math.round(ias * 100) / 100 : Math.round(ias),
      hdg: Math.round(hdg) % 360,
      alt: Math.round(alt),
      vsFpm: Math.round(vs),
      crs: Math.round(this.num(rt, v.crs, 0) ?? 0) % 360,
    };
  }

  /* ---------------------------------------------------------------- finding and reading the aircraft */

  private titleChanged(title: string) {
    this.title = title;
    this.note = null;
    this.problem = null;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    const p = this.profileFor(title);
    if (p) {
      const rt = this.runtime(p);
      if (!rt) this.problem = `Couldn't find ${p.headerFile}. Copy it from the ${p.label} package's Documentation\\SDK folder into the "sdk" folder next to VBuddy, then restart the bridge.`;
      else if (!rt.live) {
        this.liveTimer = setTimeout(() => {
          if (!rt.live && this.title === title) {
            const got = rt.chunks.filter(Boolean).length;
            this.problem =
              got > 0
                ? `Only ${got} of ${rt.chunks.length} blocks of ${p.label} data arrived: ${p.headerFile} (${rt.path}) probably doesn't match the installed aircraft version.`
                : `The ${p.label} isn't sending its data. In the aircraft's work folder, open its options .ini file, set EnableDataBroadcast=1 and reload the aircraft.`;
            this.log.warn(this.problem);
            this.changed();
          }
        }, 8000 / this.speed);
      }
    }
    this.changed();
  }

  /** Loads the header and starts listening, once per PMDG aircraft type. */
  private runtime(p: Profile): Runtime | null {
    if (this.runtimes.has(p.kind)) return this.runtimes.get(p.kind)!;
    const found = this.load(p.headerFile);
    if (!found) {
      this.log.warn(`${p.label}: ${p.headerFile} not found. Copy it into the "sdk" folder next to VBuddy (it is in the aircraft package's Documentation\\SDK folder) or set PMDG_SDK_DIR.`);
      this.runtimes.set(p.kind, null);
      return null;
    }
    const sdk = parseHeader(found.text, p.struct);
    if (!sdk.layout) {
      this.log.warn(`${p.label}: couldn't read the data layout from ${found.path}: ${sdk.layoutError}`);
      this.runtimes.set(p.kind, null);
      return null;
    }
    const index = PROFILES.indexOf(p);
    const rt: Runtime = {
      profile: p,
      index,
      sdk,
      path: found.path,
      buf: Buffer.alloc(sdk.layout.size),
      chunks: new Array(Math.ceil(sdk.layout.size / CHUNK)).fill(false),
      live: false,
      res: this.resolve(p, sdk),
      dataName: sdk.dataName ?? p.dataName,
      controlName: sdk.controlName ?? p.controlName,
    };
    this.runtimes.set(p.kind, rt);
    this.report(rt);
    this.register(rt);
    return rt;
  }

  private resolve(p: Profile, sdk: Sdk): Resolved {
    const layout = sdk.layout!;
    const fieldNames = [...layout.fields.keys()];
    const field = (patterns: RegExp[]): Field | null => {
      for (const re of patterns) {
        const n = fieldNames.find((x) => re.test(x));
        if (n) return layout.fields.get(n)!;
      }
      return null;
    };
    const eventNames = [...sdk.events.keys()];
    const one = (patterns: RegExp[], not: RegExp) => pickNames(eventNames, patterns, not)[0] ?? null;
    const vals = Object.fromEntries((["spd", "hdg", "alt", "vs", "crs"] as const).map((k) => [k, field(p.values[k])])) as Resolved["vals"];
    const flags = Object.fromEntries(
      BUTTONS.map((k) => {
        const spec = p.flags[k];
        const f = field(spec.fields);
        return [k, f ? { f, spec } : null];
      }),
    ) as Resolved["flags"];
    const press = Object.fromEntries(BUTTONS.map((k) => [k, one(p.press[k], NOT_A_BUTTON)])) as Resolved["press"];
    const knobs = Object.fromEntries(KNOBS.map((k) => [k, one(p.knobs[k], /ANNUN|GUARD|COVER/)])) as Resolved["knobs"];
    const lights: Resolved["lights"] = {};
    for (const l of LIGHTS) {
      const names = pickNames(eventNames, p.lights[l] ?? [], NOT_A_LIGHT_SWITCH);
      if (names.length) lights[l] = names;
    }
    return { vals, flags, press, knobs, lights };
  }

  private report(rt: Runtime) {
    const r = rt.res;
    const missing: string[] = [];
    const ok: string[] = [];
    for (const k of BUTTONS) (r.press[k] ? ok : missing).push(r.press[k] ? `${k}=${r.press[k]}` : `button ${k}`);
    for (const k of KNOBS) (r.knobs[k] ? ok : missing).push(r.knobs[k] ? `${k}=${r.knobs[k]}` : `knob ${k}`);
    for (const l of LIGHTS) (r.lights[l] ? ok : missing).push(r.lights[l] ? `${l}=${r.lights[l]!.join("+")}` : `light ${l}`);
    for (const k of ["spd", "hdg", "alt", "vs"] as const) if (!r.vals[k]) missing.push(`value ${k}`);
    this.log.info(`${rt.profile.label}: SDK ${rt.path} (${rt.sdk.events.size} events, ${rt.sdk.layout!.size}-byte data)`);
    this.log.info(`${rt.profile.label}: using ${ok.join(", ") || "nothing"}`);
    if (missing.length) this.log.warn(`${rt.profile.label}: not found in the SDK file: ${missing.join(", ")}. Run "pnpm pmdg:dump" and send the report to get these added.`);
  }

  private attach(h: ConnectionHandle | null) {
    this.h = h;
    this.queue = Promise.resolve();
    for (const rt of this.runtimes.values()) {
      if (!rt) continue;
      rt.live = false;
      rt.chunks.fill(false);
    }
    if (!h) return;
    h.on("clientData", (r) => this.onClientData(r.requestID, r.data));
    for (const rt of this.runtimes.values()) if (rt) this.register(rt);
    this.changed();
  }

  private ids(rt: Runtime) {
    return { dataId: 500 + rt.index * 10, controlId: 501 + rt.index * 10, controlDef: 2900 + rt.index, defBase: 2000 + rt.index * 100, reqBase: 3000 + rt.index * 100, onceBase: 3500 + rt.index * 100 };
  }

  private register(rt: Runtime) {
    const h = this.h;
    if (!h) return;
    const { dataId, controlId, controlDef, defBase, reqBase, onceBase } = this.ids(rt);
    const tag = (n: number, what: string) => this.sim.labelSend?.(n, `${rt.profile.label} ${what}`);
    tag(h.mapClientDataNameToID(rt.dataName, dataId), "data area");
    tag(h.mapClientDataNameToID(rt.controlName, controlId), "control area");
    tag(h.addToClientDataDefinition(controlDef, 0, 8), "control definition");
    const size = rt.sdk.layout!.size;
    for (let i = 0; i * CHUNK < size; i++) {
      const len = Math.min(CHUNK, size - i * CHUNK);
      tag(h.addToClientDataDefinition(defBase + i, i * CHUNK, len), "data definition");
      tag(h.requestClientData(dataId, onceBase + i, defBase + i, ClientDataPeriod.ONCE, ClientDataRequestFlag.CLIENT_DATA_REQUEST_FLAG_DEFAULT), "first data request");
      tag(h.requestClientData(dataId, reqBase + i, defBase + i, ClientDataPeriod.ON_SET, ClientDataRequestFlag.CLIENT_DATA_REQUEST_FLAG_CHANGED), "data request");
    }
  }

  private onClientData(requestID: number, data: { readBytes(n: number): Buffer }) {
    for (const rt of this.runtimes.values()) {
      if (!rt) continue;
      const { reqBase, onceBase } = this.ids(rt);
      const i = requestID >= onceBase && requestID < onceBase + 100 ? requestID - onceBase : requestID >= reqBase && requestID < reqBase + 100 ? requestID - reqBase : -1;
      if (i < 0 || i >= rt.chunks.length) continue;
      const size = rt.sdk.layout!.size;
      const len = Math.min(CHUNK, size - i * CHUNK);
      Buffer.from(data.readBytes(len)).copy(rt.buf, i * CHUNK);
      rt.chunks[i] = true;
      if (!rt.live && rt.chunks.every(Boolean)) {
        rt.live = true;
        this.log.info(`${rt.profile.label}: cockpit data is flowing`);
        this.problem = null;
        if (this.liveTimer) clearTimeout(this.liveTimer);
      }
      if (!this.pending) {
        this.pending = true;
        setImmediate(() => {
          this.pending = false;
          this.changed();
        });
      }
      return;
    }
  }

  /* ---------------------------------------------------------------- sending */

  private wait(ms: number) {
    return sleepReal(ms / this.speed);
  }

  /** Writes one PMDG event, then leaves the control area alone for a moment: PMDG reads one command at a time. */
  private send(rt: Runtime, event: string, param: number): Promise<void> {
    const id = rt.sdk.events.get(event);
    const p = this.queue.then(async () => {
      const h = this.h;
      if (!h || id === undefined) return;
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(id >>> 0, 0);
      buf.writeUInt32LE(param >>> 0, 4);
      try {
        const { controlId, controlDef } = this.ids(rt);
        const sendId = h.setClientData(controlId, controlDef, 0, 0, 8, buf);
        this.sim.labelSend?.(sendId, `${rt.profile.label} ${event}`);
      } catch (e) {
        this.log.warn(`${event}: ${(e as Error).message}`);
      }
      await this.wait(40);
    });
    this.queue = p.catch(() => {});
    return p;
  }

  private click(rt: Runtime, event: string, which: "left" | "right") {
    const m = rt.sdk.mouse;
    return this.send(rt, event, which === "left" ? (m.get("MOUSE_FLAG_LEFTSINGLE") ?? 0x20000000) : (m.get("MOUSE_FLAG_RIGHTSINGLE") ?? 0x80000000));
  }

  private async until(test: () => boolean, ms: number): Promise<boolean> {
    for (let t = 0; t < ms; t += 40) {
      if (test()) return true;
      await this.wait(40);
    }
    return test();
  }

  private worked(): PanelResult {
    if (this.note) {
      this.note = null;
      this.changed();
    }
    return { ok: true };
  }

  private failed(error: string): PanelResult {
    this.note = error;
    this.changed();
    return { ok: false, error };
  }

  /* ---------------------------------------------------------------- commands */

  sys(id: SysId, value?: number): Promise<PanelResult> {
    return this.base.sys(id, value);
  }

  async setLight(id: LightId, on: boolean): Promise<PanelResult> {
    const rt = this.activeRuntime();
    const events = rt?.res.lights[id];
    if (!rt || !events?.length) return this.base.setLight(id, on);
    const lit = () => this.base.state()?.lights[id];
    if (lit() === on) return { ok: true };
    const retract = (e: string) => /RETRACT/.test(e);
    // Ways to ask for it, most likely first. Position switches have three positions, so every value gets a turn.
    const attempts: Array<(e: string) => Promise<void>> = [
      (e) => this.send(rt, e, on ? (retract(e) ? 2 : 1) : 0),
      (e) => this.send(rt, e, on ? 2 : 1),
      (e) => this.send(rt, e, on ? 0 : 2),
      (e) => this.click(rt, e, "left"),
      (e) => this.click(rt, e, "right"),
    ];
    const key = `${rt.profile.kind}:${id}:${on}`;
    const first = this.learnedLight.get(key);
    const order = attempts.map((_, i) => i);
    if (first !== undefined) order.sort((a, b) => (a === first ? -1 : b === first ? 1 : a - b));
    for (const i of order) {
      for (const e of events) await attempts[i]!(e);
      if (await this.until(() => lit() === on, 900)) {
        this.learnedLight.set(key, i);
        return this.worked();
      }
    }
    // The aircraft may still honour the simulator's own light command.
    return this.base.setLight(id, on);
  }

  async press(ctl: ApButton): Promise<PanelResult> {
    const rt = this.activeRuntime();
    if (!rt) return this.base.press(ctl);
    const event = rt.res.press[ctl];
    if (!event) return this.failed(`Couldn't find the ${BUTTON_NAMES[ctl]} button in ${rt.profile.headerFile}.`);
    const before = this.flag(rt, ctl);
    await this.click(rt, event, "left");
    if (before === null) return this.worked();
    if (await this.until(() => this.flag(rt, ctl) !== before, 1000)) return this.worked();
    return this.failed(`${BUTTON_NAMES[ctl]} was pressed, but the PMDG's light didn't change. That mode may not be available right now.`);
  }

  async set(ctl: ApKnob, target: number): Promise<PanelResult> {
    const rt = this.activeRuntime();
    if (!rt) return this.base.set(ctl, target);
    const event = rt.res.knobs[ctl];
    if (!event) return this.failed(`Couldn't find the ${ctl.toUpperCase()} knob in ${rt.profile.headerFile}.`);
    const gen = (this.gen.get(ctl) ?? 0) + 1;
    this.gen.set(ctl, gen);
    await this.queue; // let earlier clicks land before reading
    const wrap = ctl === "hdg" || ctl === "crs";
    const diff = (a: number, b: number) => (wrap ? ((((a - b) % 360) + 540) % 360) - 180 : a - b);
    const read = () => {
      const ap = this.ap(rt);
      if (!ap) return null;
      return ctl === "spd" ? ap.spd : ctl === "hdg" ? ap.hdg : ctl === "alt" ? ap.alt : ctl === "vs" ? ap.vsFpm : ap.crs;
    };
    const tol = () => {
      const ap = this.ap(rt);
      return ctl === "spd" ? (ap?.machMode ? 0.006 : 1) : ctl === "alt" || ctl === "vs" ? 50 : 1;
    };
    for (let round = 0; round < 6; round++) {
      if (this.gen.get(ctl) !== gen) return { ok: true }; // a newer turn took over
      const cur = read();
      if (cur === null) return this.failed("The PMDG isn't reporting its autopilot window values.");
      const d = diff(target, cur);
      if (Math.abs(d) <= tol()) return this.worked();
      let perRight = this.learnedKnob.get(ctl);
      if (perRight === undefined) {
        // One click each way finds out which direction is which and how far a click moves it.
        await this.click(rt, event, "right");
        const moved = await this.until(() => read() !== cur, 700);
        if (moved) perRight = diff(read()!, cur);
        else {
          await this.click(rt, event, "left");
          if (await this.until(() => read() !== cur, 700)) perRight = -diff(read()!, cur);
        }
        if (!perRight) return this.failed(`The PMDG ${ctl.toUpperCase()} knob didn't move. Check the aircraft is powered and the MCP is lit.`);
        this.learnedKnob.set(ctl, perRight);
        continue;
      }
      const clicks = Math.min(MAX_CLICKS, Math.max(1, Math.round(Math.abs(d) / Math.abs(perRight))));
      const right = Math.sign(d) === Math.sign(perRight);
      for (let i = 0; i < clicks; i++) {
        if (this.gen.get(ctl) !== gen) return { ok: true };
        void this.click(rt, event, right ? "right" : "left");
      }
      await this.queue;
      await this.until(() => {
        const c = read();
        return c !== null && Math.abs(diff(target, c)) <= tol();
      }, SETTLE_WAIT_MS / 5);
    }
    const end = read();
    if (end !== null && Math.abs(diff(target, end)) <= tol()) return this.worked();
    return this.failed(`The PMDG ${ctl.toUpperCase()} window stopped at ${end ?? "?"} instead of ${target}.`);
  }
}
