import { CDU_COLUMNS, CDU_ROWS, familyOf, type ApButton, type CduScreen, type ApKnob, type LightId, type PanelState, type SimStatus, type SysId } from "@vbuddy/protocol";
import { ClientDataPeriod, ClientDataRequestFlag, EventFlag, SimConnectConstants, type ConnectionHandle } from "node-simconnect";
import type { Logger } from "../log.js";
import type { PanelBackend, PanelResult } from "../panel/backend.js";
import { findSdkHeader, type FoundSdk } from "./find-sdk.js";
import type { PmdgSetupReport } from "./sdk-setup.js";
import { NOT_A_BUTTON, NOT_A_LIGHT_SWITCH, PROFILES, pickNames, type FlagSpec, type PmdgKind, type Profile } from "./profiles.js";
import { parseHeader, readField, type Field, type Sdk } from "./sdk.js";

/** One block for the whole data area, as PMDG's sample reads it (client data areas can be up to 8 KB; PMDG's are under 1 KB). */
const CHUNK = 8192;
/** SimConnect's highest priority, used as the "group" with EVENT_FLAG_GROUPID_IS_PRIORITY (PMDG's sample, Cobalt). */
const PRIORITY_HIGHEST = 1;
/** Client event ids for PMDG's "#<number>" events. */
const PMDG_EVENT_IDS = 6000;
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
  /**
   * Installs the SDK headers and turns on PMDG's broadcast in the options .ini (pmdg/sdk-setup.ts). Called on every
   * aircraft change; `headers` asks for the header copy too (only when one couldn't be loaded).
   */
  setup?: (o: { headers: boolean }) => PmdgSetupReport;
}

interface Resolved {
  vals: Record<"spd" | "hdg" | "alt" | "vs" | "crs", Field | null>;
  flags: Record<ApButton, { f: Field; spec: FlagSpec } | null>;
  press: Record<ApButton, string | null>;
  knobs: Record<ApKnob, string | null>;
  lights: Partial<Record<LightId, string[]>>;
}

/** One CDU screen as PMDG sends it: CDU_COLUMNS x CDU_ROWS cells of (symbol, colour, flags), column by column, then Powered. */
const CDU_BYTES = CDU_COLUMNS * CDU_ROWS * 3 + 1;
/** PMDG's special symbols (PMDG_NG3_SDK.h: \xA1-\xA4 arrows); the rest is ASCII. */
const CDU_SYMBOLS: Record<number, string> = { 0xa1: "←", 0xa2: "→", 0xa3: "↑", 0xa4: "↓", 0xb0: "°" };
const CDU_SIDE_LETTER = ["L", "R", "C"] as const;
/** After this long without a screen while someone is watching, say how to turn the broadcast on. */
const CDU_WAIT_MS = 4000;

interface CduBuf {
  buf: Buffer;
  live: boolean;
}

/** What the server needs from the CDU side of the PMDG panel. */
export interface CduSource {
  screen(side: number): CduScreen | null;
  key(side: number, key: string): Promise<PanelResult>;
  onCdu(cb: (side: number) => void): void;
}

interface Runtime {
  cdus: CduBuf[];
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
export class PmdgPanel implements PanelBackend, CduSource {
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
  /** PMDG event number -> our client event id (mapped once per connection). */
  private evIds = new Map<number, number>();
  private sent = 0;
  private cduCbs: Array<(side: number) => void> = [];
  private cduTimers = new Map<number, NodeJS.Timeout>();
  private cduSince = 0;
  private readonly speed: number;
  private readonly load: (file: string) => FoundSdk | null;
  private readonly setup: PmdgOptions["setup"];
  /** Aircraft whose options .ini VBuddy has just turned the broadcast on in: they need reloading. */
  private enabledNow = new Set<PmdgKind>();

  constructor(
    private sim: SimLike,
    private base: PanelBackend,
    private log: Logger,
    opts: PmdgOptions = {},
  ) {
    this.speed = opts.speed ?? 1;
    this.load = opts.load ?? ((file) => findSdkHeader(file, opts.sdkDirs ?? []));
    this.setup = opts.setup;
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
    const any = this.runtimes.get(profile.kind);
    const cdu = { sides: profile.kind === "777x" ? 3 : 2 };
    if (!rt) return { ...b, family: "boeing", ap: b.ap && profile.kind === "777x" ? { ...b.ap, hasCrs: false } : b.ap, note: b.note ?? this.problem, cdu: any || this.h ? cdu : null };
    return { ...b, family: "boeing", ap: this.ap(rt), note: this.note, cdu };
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
      hasCrs: rt.profile.kind !== "777x", // the 777's MCP has no course knob
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
    this.prepare(p);
    if (p) {
      const rt = this.runtime(p);
      // No SDK header: the panel still works the way Cobalt drives a PMDG (its published event numbers, see
      // panel/addons.ts), but the MCP windows and lights can't be read, so say where the file goes.
      if (!rt) this.problem = `The ${p.label}'s MCP windows and lights need PMDG's ${p.headerFile}, and VBuddy couldn't find it in the aircraft's package. Copy it from the aircraft's Documentation\\SDK folder into %APPDATA%\\VBuddy\\sdk and restart VBuddy.`;
      else if (!rt.live) {
        this.liveTimer = setTimeout(() => {
          if (!rt.live && this.title === title) {
            const got = rt.chunks.filter(Boolean).length;
            this.problem =
              got > 0
                ? `Only ${got} of ${rt.chunks.length} blocks of ${p.label} data arrived: ${p.headerFile} (${rt.path}) probably doesn't match the installed aircraft version.`
                : this.enabledNow.has(p.kind)
                  ? `VBuddy has just turned on the ${p.label}'s data in its options .ini. Reload the aircraft (or restart the flight) to start it.`
                  : `The ${p.label} isn't sending its data. In the aircraft's work folder, open its options .ini file, set EnableDataBroadcast=1 under [SDK] and reload the aircraft.`;
            this.log.warn(this.problem);
            this.changed();
          }
        }, 8000 / this.speed);
      }
    }
    this.changed();
  }

  /**
   * Keeps the PMDG setup in place (pmdg/sdk-setup.ts): the options .ini lines every time the aircraft changes (PMDG
   * recreates the file when the aircraft is updated), and the header when this aircraft's couldn't be loaded before.
   */
  private prepare(p: Profile | null | undefined) {
    if (!this.setup) return;
    const r = this.setup({ headers: !!p && this.runtimes.has(p.kind) && this.runtimes.get(p.kind) === null });
    for (const h of r.headers) {
      if (h.action === "current") continue;
      this.log.info(`${h.action === "installed" ? "Installed" : "Updated"} ${h.file} from ${h.from}`);
      if (this.runtimes.get(h.kind) === null) this.runtimes.delete(h.kind); // try loading it again
    }
    for (const i of r.inis) {
      if (i.action === "current") continue;
      this.log.info(`Turned on PMDG's data in ${i.path} (${i.added.join(", ")}). The aircraft picks it up when it's next loaded.`);
      this.enabledNow.add(i.kind);
    }
    for (const e of r.errors) this.log.warn(`PMDG setup: ${e}`);
  }

  /** Loads the header and starts listening, once per PMDG aircraft type. */
  private runtime(p: Profile): Runtime | null {
    if (this.runtimes.has(p.kind)) return this.runtimes.get(p.kind)!;
    const found = this.load(p.headerFile);
    if (!found) {
      this.log.info(`${p.label}: ${p.headerFile} not found, so the MCP works through PMDG's published event numbers and the standard variables (as Cobalt). For exact MCP lights and windows, copy the file into %APPDATA%\\VBuddy\\sdk (from the aircraft package's Documentation\\SDK folder) or set PMDG_SDK_DIR.`);
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
      cdus: Array.from({ length: p.kind === "777x" ? 3 : 2 }, () => ({ buf: Buffer.alloc(CDU_BYTES), live: false })),
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
    // The 777's MCP has no course knob (courses are set in the FMC), so that one isn't missing.
    for (const k of KNOBS) if (r.knobs[k] || !(k === "crs" && rt.profile.kind === "777x")) (r.knobs[k] ? ok : missing).push(r.knobs[k] ? `${k}=${r.knobs[k]}` : `knob ${k}`);
    for (const l of LIGHTS) (r.lights[l] ? ok : missing).push(r.lights[l] ? `${l}=${r.lights[l]!.join("+")}` : `light ${l}`);
    for (const k of ["spd", "hdg", "alt", "vs"] as const) if (!r.vals[k]) missing.push(`value ${k}`);
    this.log.info(`${rt.profile.label}: SDK ${rt.path} (${rt.sdk.events.size} events, ${rt.sdk.layout!.size}-byte data)`);
    this.log.info(`${rt.profile.label}: using ${ok.join(", ") || "nothing"}`);
    if (missing.length) this.log.warn(`${rt.profile.label}: not found in the SDK file: ${missing.join(", ")}. Run "pnpm pmdg:dump" and send the report to get these added.`);
  }

  private attach(h: ConnectionHandle | null) {
    this.h = h;
    this.queue = Promise.resolve();
    this.evIds.clear();
    for (const rt of this.runtimes.values()) {
      if (!rt) continue;
      rt.live = false;
      rt.chunks.fill(false);
      for (const c of rt.cdus) c.live = false;
    }
    if (!h) return;
    h.on("clientData", (r) => this.onClientData(r.requestID, r.data));
    for (const rt of this.runtimes.values()) if (rt) this.register(rt);
    this.changed();
  }

  private ids(rt: Runtime) {
    return { cduId: 502 + rt.index * 10, cduDef: 2950 + rt.index * 5, cduReq: 3900 + rt.index * 10, dataId: 500 + rt.index * 10, controlId: 501 + rt.index * 10, controlDef: 2900 + rt.index, defBase: 2000 + rt.index * 100, reqBase: 3000 + rt.index * 100, onceBase: 3500 + rt.index * 100 };
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
    // The CDU screens, as PMDG's CDU sample reads them (they only arrive when EnableCDUBroadcast.<n>=1 is set).
    const { cduId, cduDef, cduReq } = this.ids(rt);
    const cduName = rt.dataName.replace(/_Data$/, "_CDU_");
    rt.cdus.forEach((_, i) => {
      tag(h.mapClientDataNameToID(`${cduName}${i}`, cduId + i), `CDU ${i} area`);
      tag(h.addToClientDataDefinition(cduDef + i, 0, CDU_BYTES), `CDU ${i} definition`);
      tag(h.requestClientData(cduId + i, cduReq + i, cduDef + i, ClientDataPeriod.VISUAL_FRAME, ClientDataRequestFlag.CLIENT_DATA_REQUEST_FLAG_CHANGED), `CDU ${i} request`);
    });
    this.cduSince = Date.now();
  }

  private onClientData(requestID: number, data: { readBytes(n: number): Buffer }) {
    for (const rt of this.runtimes.values()) {
      if (!rt) continue;
      const { cduReq } = this.ids(rt);
      if (requestID >= cduReq && requestID < cduReq + rt.cdus.length) {
        const side = requestID - cduReq;
        const c = rt.cdus[side]!;
        Buffer.from(data.readBytes(CDU_BYTES)).copy(c.buf, 0);
        c.live = true;
        this.cduChanged(side);
        return;
      }
    }
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

  /**
   * Sends one PMDG event the way PMDG's own sample (PMDG_NG3_ConnectionTest.cpp, "method 2") and Cobalt do: the event
   * is mapped to "#<event number>" and transmitted with SIMCONNECT_GROUP_PRIORITY_HIGHEST and
   * SIMCONNECT_EVENT_FLAG_GROUPID_IS_PRIORITY. Unlike writing the control area ("method 1"), several events can be
   * sent in a row without waiting for PMDG to clear the previous one, so knob turns don't lose clicks.
   * Bursts get a short pause every 25 events so the simulator doesn't merge them.
   */
  private send(rt: Runtime, event: string, param: number): Promise<void> {
    const num = rt.sdk.events.get(event);
    const p = this.queue.then(async () => {
      const h = this.h;
      if (!h || num === undefined) return;
      try {
        let id = this.evIds.get(num);
        if (id === undefined) {
          id = PMDG_EVENT_IDS + this.evIds.size;
          h.mapClientEventToSimEvent(id, `#${num}`);
          this.evIds.set(num, id);
        }
        const sendId = h.transmitClientEvent(SimConnectConstants.OBJECT_ID_USER, id, param >>> 0, PRIORITY_HIGHEST, EventFlag.EVENT_FLAG_GROUPID_IS_PRIORITY);
        this.sim.labelSend?.(sendId, `${rt.profile.label} ${event}`);
      } catch (e) {
        this.log.warn(`${event}: ${(e as Error).message}`);
      }
      if (++this.sent % 25 === 0) await this.wait(25);
      else await this.wait(4);
    });
    this.queue = p.catch(() => {});
    return p;
  }

  /** A mouse click as PMDG's sample does it: the press, then the release (switches and buttons wait for the release). */
  private async click(rt: Runtime, event: string, which: "left" | "right") {
    const m = rt.sdk.mouse;
    if (which === "left") {
      void this.send(rt, event, m.get("MOUSE_FLAG_LEFTSINGLE") ?? 0x20000000);
      return this.send(rt, event, m.get("MOUSE_FLAG_LEFTRELEASE") ?? 0x00020000);
    }
    void this.send(rt, event, m.get("MOUSE_FLAG_RIGHTSINGLE") ?? 0x80000000);
    return this.send(rt, event, m.get("MOUSE_FLAG_RIGHTRELEASE") ?? 0x00080000);
  }

  /** One detent of a knob, as PMDG's sample slews the heading selector: the mouse wheel. */
  private turn(rt: Runtime, event: string, up: boolean) {
    const m = rt.sdk.mouse;
    return this.send(rt, event, up ? (m.get("MOUSE_FLAG_WHEEL_UP") ?? 0x00004000) : (m.get("MOUSE_FLAG_WHEEL_DOWN") ?? 0x00002000));
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

  /** The SDK's direct "set" event(s) for a knob, with the parameter PMDG documents for each. Null when the header has none. */
  private directSet(rt: Runtime, ctl: ApKnob, target: number, machNow: boolean): Array<{ event: string; param: number }> | null {
    const has = (n: string) => rt.sdk.events.has(n);
    const one = (n: string, param: number) => (has(n) ? [{ event: n, param: Math.round(param) }] : null);
    const is777 = rt.profile.kind === "777x";
    switch (ctl) {
      case "spd":
        if (target < 10 || machNow) return target < 10 ? one("EVT_MCP_MACH_SET", target * (is777 ? 1000 : 100)) : one("EVT_MCP_IAS_SET", target);
        return one("EVT_MCP_IAS_SET", target);
      case "hdg":
        return one("EVT_MCP_HDG_SET", ((target % 360) + 360) % 360) ?? one("EVT_MCP_HDGTRK_SET", ((target % 360) + 360) % 360);
      case "alt":
        return one("EVT_MCP_ALT_SET", target);
      case "vs":
        return one("EVT_MCP_VS_SET", target + 10000);
      case "crs": {
        const c = ((target % 360) + 360) % 360;
        const both = [...(one("EVT_MCP_CRS_L_SET", c) ?? []), ...(one("EVT_MCP_CRS_R_SET", c) ?? [])];
        return both.length ? both : null;
      }
    }
    return null;
  }

  async set(ctl: ApKnob, target: number): Promise<PanelResult> {
    const rt = this.activeRuntime();
    if (!rt) return this.base.set(ctl, target);
    const event = rt.res.knobs[ctl];
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
    // PMDG's SDK has "set" events that put a value straight into an MCP window (EVT_MCP_HDG_SET and friends). One event
    // lands exactly where it was asked, so nothing overshoots or creeps back. Turning the knob is the fallback.
    const direct = this.directSet(rt, ctl, target, this.ap(rt)?.machMode ?? false);
    if (direct) {
      for (const d of direct) await this.send(rt, d.event, d.param);
      if (await this.until(() => {
        const c = read();
        return c !== null && Math.abs(diff(target, c)) <= tol();
      }, 1200)) return this.worked();
      if (this.gen.get(ctl) !== gen) return { ok: true };
    }
    if (!event) return this.failed(`Couldn't find the ${ctl.toUpperCase()} knob in ${rt.profile.headerFile}.`);
    for (let round = 0; round < 6; round++) {
      if (this.gen.get(ctl) !== gen) return { ok: true }; // a newer turn took over
      await this.wait(150); // the aircraft's data comes a frame or two after the clicks: don't count from a stale value
      const cur = read();
      if (cur === null) return this.failed("The PMDG isn't reporting its autopilot window values.");
      const d = diff(target, cur);
      if (Math.abs(d) <= tol()) return this.worked();
      let perRight = this.learnedKnob.get(ctl);
      if (perRight === undefined) {
        // One click each way finds out which direction is which and how far a click moves it.
        await this.turn(rt, event, true);
        const moved = await this.until(() => read() !== cur, 700);
        if (moved) perRight = diff(read()!, cur);
        else {
          await this.turn(rt, event, false);
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
        void this.turn(rt, event, right);
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

  /* ---------------------------------------------------------------- CDU */

  onCdu(cb: (side: number) => void) {
    this.cduCbs.push(cb);
  }

  /** Tells watchers at most ten times a second (PMDG sends a screen on every change). */
  private cduChanged(side: number) {
    if (this.cduTimers.has(side)) return;
    this.cduTimers.set(
      side,
      setTimeout(() => {
        this.cduTimers.delete(side);
        for (const cb of this.cduCbs) cb(side);
      }, 100 / this.speed),
    );
  }

  screen(side: number): CduScreen | null {
    const p = this.profileFor(this.title);
    if (!p) return null;
    const sides = p.kind === "777x" ? 3 : 2;
    const aircraft = p.kind === "777x" ? ("777" as const) : ("737" as const);
    const s = Math.max(0, Math.min(sides - 1, side));
    const blank: CduScreen = { aircraft, side: s, sides, live: false, powered: false, rows: [], colors: [], flags: [], annun: { exec: false, msg: false, fail: false, ofst: false, call: false, dspy: false }, keys: [], message: null };
    const rt = this.runtimes.get(p.kind);
    if (!rt) return { ...blank, message: `The CDU needs PMDG's ${p.headerFile}, and VBuddy couldn't find it in the aircraft's package. Copy it from the aircraft's Documentation\\SDK folder into %APPDATA%\\VBuddy\\sdk and restart VBuddy.` };
    const keys = [...rt.sdk.events.keys()].filter((k) => k.startsWith("EVT_CDU_L_") && !/BRITENESS|BRIGHT/.test(k)).map((k) => k.slice("EVT_CDU_L_".length));
    const c = rt.cdus[s]!;
    const flag = (name: string) => {
      const f = rt.sdk.layout?.fields.get(name);
      return f ? (this.num(rt, f, s) ?? 0) !== 0 : false;
    };
    const annun = { exec: flag("CDU_annunEXEC"), msg: flag("CDU_annunMSG"), fail: flag("CDU_annunFAIL"), ofst: flag("CDU_annunOFST"), call: flag("CDU_annunCALL"), dspy: flag("CDU_annunDSPY") };
    if (!c.live) {
      const waited = Date.now() - this.cduSince > CDU_WAIT_MS / this.speed;
      const ini = p.kind === "777x" ? "777_Options.ini" : "737_Options.ini";
      const lines = Array.from({ length: sides }, (_, i) => `EnableCDUBroadcast.${i}=1`).join(", ");
      if (waited && this.enabledNow.has(p.kind)) return { ...blank, keys, annun, message: `VBuddy has just turned on the ${p.label}'s CDU screens in ${ini}. Reload the aircraft (or restart the flight) to see them.` };
      return { ...blank, keys, annun, message: waited ? `The ${p.label} isn't sending its CDU screens. In the aircraft's work folder, open ${ini} and add ${lines} under [SDK], then reload the aircraft.` : "Waiting for the CDU screen…" };
    }
    const rows: string[] = [];
    const colors: string[] = [];
    const flags: string[] = [];
    for (let y = 0; y < CDU_ROWS; y++) {
      let r = "";
      let co = "";
      let fl = "";
      for (let x = 0; x < CDU_COLUMNS; x++) {
        const at = (x * CDU_ROWS + y) * 3;
        const sym = c.buf[at]!;
        r += CDU_SYMBOLS[sym] ?? (sym >= 32 && sym < 127 ? String.fromCharCode(sym) : " ");
        co += String(Math.min(5, c.buf[at + 1]!));
        fl += String(c.buf[at + 2]! & 7);
      }
      rows.push(r);
      colors.push(co);
      flags.push(fl);
    }
    return { aircraft, side: s, sides, live: true, powered: c.buf[CDU_BYTES - 1] !== 0, rows, colors, flags, annun, keys, message: null };
  }

  /** Presses a CDU key the way PMDG's sample presses a switch: left click, then release. */
  async key(side: number, key: string): Promise<PanelResult> {
    const p = this.profileFor(this.title);
    const rt = p ? this.runtimes.get(p.kind) : null;
    if (!p || !rt) return { ok: false, error: "No PMDG CDU to press." };
    const letter = CDU_SIDE_LETTER[side];
    const event = letter ? `EVT_CDU_${letter}_${key}` : "";
    if (!letter || !rt.sdk.events.has(event)) return { ok: false, error: `The ${p.label} has no CDU key ${key}.` };
    if (!this.h) return { ok: false, error: "The simulator isn't connected." };
    await this.click(rt, event, "left");
    return { ok: true };
  }
}
