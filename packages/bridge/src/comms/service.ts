import { formatMhz, MAX_CHAT, mentionsCallsign, toHz, type AtcAppStatus, type BridgeToPlugin, type ChatMessage, type ChatSource, type CommsCommand, type CommsState, type PluginToBridge, type VoiceStatus } from "@vbuddy/protocol";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Logger } from "../log.js";
import type { RadioBackend } from "./backend.js";

const PLUGIN_TIMEOUT_MS = 8000;
const NO_PLUGIN = "The VBuddy Link plugin isn't connected. Start vPilot with the plugin installed (see the README).";

type Result = { ok: true } | { ok: false; error: string };
export interface PluginLink {
  send(msg: BridgeToPlugin): void;
  close(): void;
}

interface Identity {
  callsign: string;
  type: string;
  selcal: string;
}

/**
 * Radios, transponder, the VATSIM connection and the chat log in one place. The radios come from the
 * simulator; everything about the network (connect, chat, ident) goes through the plugin inside vPilot.
 */
export class CommsService {
  private plugin: PluginLink | null = null;
  private net = { connected: false, callsign: null as string | null, observer: false };
  private last: Identity | null = null;
  private chat: ChatMessage[] = [];
  private seq = 0;
  private pending = new Map<string, { done: (r: Result) => void; timer: NodeJS.Timeout }>();
  private stateCbs: Array<() => void> = [];
  private chatCbs: Array<(m: ChatMessage) => void> = [];
  private lastJson = "";
  private extra: () => { voice?: VoiceStatus; apps?: { sayintentions: AtcAppStatus; beyondatc: AtcAppStatus } } = () => ({});
  /** A callsign to listen for when VATSIM isn't connected (SayIntentions / BeyondATC flights, or the SimBrief plan). */
  private fallbackCallsign: () => string | null = () => null;

  constructor(
    private radios: RadioBackend | null,
    private log: Logger,
    private identityFile: string | null = null,
    private now: () => number = Date.now,
  ) {
    radios?.onValues(() => this.changed());
    this.loadIdentity();
  }

  /* ------------------------------------------------------------ state */

  state(): CommsState {
    const v = this.radios?.values() ?? null;
    return {
      net: { ...this.net, pluginLinked: this.plugin !== null, last: this.last },
      radios: v?.radios ?? null,
      xpdr: v?.xpdr ?? null,
      ...this.extra(),
    };
  }

  /** Voice-to-text and AI ATC status, shown with the radios. Call `extrasChanged` when they change. */
  setExtras(get: () => { voice?: VoiceStatus; apps?: { sayintentions: AtcAppStatus; beyondatc: AtcAppStatus } }, callsign?: () => string | null) {
    this.extra = get;
    if (callsign) this.fallbackCallsign = callsign;
    this.changed();
  }
  extrasChanged() {
    this.changed();
  }

  /** Your callsign as ATC would use it: the VATSIM one, else the AI ATC app's or the flight plan's. */
  myCallsign(): string | null {
    return this.net.callsign ?? this.fallbackCallsign();
  }

  /** The frequency you're listening on: COM1 if it's receiving, else COM2, else COM1. */
  listeningHz(): number | null {
    const r = this.radios?.values()?.radios;
    if (!r) return null;
    if (r.com1.rx || !r.com2.rx) return r.com1.active;
    return r.com2.active;
  }

  /**
   * A message from VBuddy's own voice-to-text or an AI ATC app. Radio calls join the conversation on their frequency;
   * "attention" (badge, chime, push) when it uses your callsign.
   */
  addExternal(m: { source: ChatSource; text: string; from: string; dir?: "in" | "out"; freqHz?: number | null; to?: string | null; clip?: string; kind?: "radio" | "private" | "system" }): ChatMessage {
    const dir = m.dir ?? "in";
    const hz = m.freqHz ?? (m.source === "voice" ? this.listeningHz() : null);
    const kind = m.kind ?? "radio";
    const me = this.myCallsign();
    const spoken = m.source === "voice" || m.source === "beyondatc" ? mentionsCallsign(m.text, me) : false;
    const attention = dir === "in" && kind === "radio" && (spoken || this.mentionsMe(m.text));
    return this.push({
      kind,
      dir,
      from: m.from,
      to: m.to ?? null,
      freqHz: hz ? [hz] : [],
      text: m.text,
      thread: kind === "private" ? `dm:${m.from.toUpperCase()}` : kind === "system" ? "system" : `freq:${hz ?? 0}`,
      attention,
      source: m.source,
      ...(m.clip ? { clip: m.clip } : {}),
    });
  }
  onState(cb: () => void) {
    this.stateCbs.push(cb);
  }
  onChat(cb: (m: ChatMessage) => void) {
    this.chatCbs.push(cb);
  }
  history(): ChatMessage[] {
    return this.chat.slice();
  }
  private changed() {
    const json = JSON.stringify(this.state());
    if (json === this.lastJson) return;
    this.lastJson = json;
    for (const cb of this.stateCbs) cb();
  }

  /* ------------------------------------------------------------ plugin side */

  attachPlugin(link: PluginLink, name: string) {
    if (this.plugin && this.plugin !== link) this.plugin.close();
    this.plugin = link;
    this.log.info(`vPilot plugin connected (${name})`);
    this.addSystem("VBuddy Link connected to vPilot.");
    this.changed();
  }
  detachPlugin(link: PluginLink) {
    if (this.plugin !== link) return;
    this.plugin = null;
    this.net = { connected: false, callsign: null, observer: false };
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.done({ ok: false, error: "vPilot closed the link." });
      this.pending.delete(id);
    }
    this.log.info("vPilot plugin disconnected");
    this.addSystem("VBuddy Link disconnected (vPilot closed?).");
    this.changed();
  }

  fromPlugin(msg: PluginToBridge) {
    if (msg.t === "net") {
      const was = this.net.connected;
      this.net = { connected: msg.connected, callsign: msg.connected ? msg.callsign : null, observer: msg.observer };
      if (msg.connected && msg.callsign) {
        this.last = { callsign: msg.callsign, type: msg.type ?? this.last?.type ?? "", selcal: msg.selcal ?? this.last?.selcal ?? "" };
        this.saveIdentity();
      }
      if (was !== msg.connected) this.addSystem(msg.connected ? `Connected to VATSIM as ${msg.callsign}${msg.observer ? " (observer)" : ""}.` : "Disconnected from VATSIM.");
      this.changed();
    } else if (msg.t === "chat") {
      this.incoming(msg);
    } else if (msg.t === "result") {
      const p = this.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        p.done(msg.ok ? { ok: true } : { ok: false, error: msg.error ?? "vPilot refused." });
      }
    }
  }

  private ask(build: (id: string) => BridgeToPlugin): Promise<Result> {
    const plugin = this.plugin;
    if (!plugin) return Promise.resolve({ ok: false, error: NO_PLUGIN });
    const id = `p${++this.seq}`;
    return new Promise((done) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        done({ ok: false, error: "vPilot didn't answer." });
      }, PLUGIN_TIMEOUT_MS);
      this.pending.set(id, { done, timer });
      plugin.send(build(id));
    });
  }

  /* ------------------------------------------------------------ chat */

  private mentionsMe(text: string): boolean {
    const cs = this.myCallsign();
    if (!cs) return false;
    const esc = cs.replace(/[^A-Za-z0-9]/g, "");
    return new RegExp(`(^|[^A-Za-z0-9])${esc.split("").join("[ -]?")}($|[^A-Za-z0-9])`, "i").test(text);
  }

  private push(m: Omit<ChatMessage, "id" | "ts">) {
    const msg: ChatMessage = { id: `m${++this.seq}`, ts: this.now(), ...m };
    this.chat.push(msg);
    if (this.chat.length > MAX_CHAT) this.chat.splice(0, this.chat.length - MAX_CHAT);
    for (const cb of this.chatCbs) cb(msg);
    return msg;
  }

  private incoming(m: Extract<PluginToBridge, { t: "chat" }>) {
    const freqHz = m.freqs.map(toHz);
    const from = m.from.toUpperCase();
    if (m.kind === "private") this.push({ kind: "private", dir: "in", from, to: this.net.callsign, freqHz: [], text: m.text, thread: `dm:${from}`, attention: true });
    else if (m.kind === "selcal") this.push({ kind: "selcal", dir: "in", from, to: this.net.callsign, freqHz, text: m.text || "SELCAL", thread: "system", attention: true });
    else if (m.kind === "broadcast") this.push({ kind: "broadcast", dir: "in", from, to: null, freqHz: [], text: m.text, thread: "broadcast", attention: this.mentionsMe(m.text) });
    else this.push({ kind: "radio", dir: "in", from, to: null, freqHz, text: m.text, thread: `freq:${freqHz[0] ?? 0}`, attention: this.mentionsMe(m.text) });
  }

  private addSystem(text: string) {
    this.push({ kind: "system", dir: "in", from: "VBuddy", to: null, freqHz: [], text, thread: "system", attention: false });
  }

  /* ------------------------------------------------------------ commands */

  async run(cmd: CommsCommand): Promise<Result> {
    switch (cmd.op) {
      case "com": {
        const v = this.radios?.values();
        if (!this.radios || !v?.radios) return { ok: false, error: "The simulator isn't connected." };
        if (cmd.action === "swap") return this.radios.swapCom(cmd.radio) ? { ok: true } : { ok: false, error: "Couldn't reach the simulator." };
        if (cmd.action === "listen") return this.radios.setListen(cmd.radio, cmd.on ?? !v.radios[cmd.radio === 1 ? "com1" : "com2"].rx) ? { ok: true } : { ok: false, error: "Couldn't reach the simulator." };
        if (!cmd.hz) return { ok: false, error: "Give a frequency." };
        return this.radios.setCom(cmd.radio, cmd.action, cmd.hz) ? { ok: true } : { ok: false, error: "Couldn't reach the simulator." };
      }
      case "xpdr": {
        if (!this.radios?.values()?.xpdr) return { ok: false, error: "The simulator isn't connected." };
        if (cmd.action === "code") {
          if (!cmd.code) return { ok: false, error: "Give a 4-digit code." };
          return this.radios.setXpdrCode(cmd.code) ? { ok: true } : { ok: false, error: "Couldn't reach the simulator." };
        }
        if (cmd.action === "mode") {
          if (!cmd.mode) return { ok: false, error: "Give a mode." };
          this.radios.setXpdrMode(cmd.mode);
          if (this.plugin) void this.ask((id) => ({ op: "modeC", id, on: cmd.mode === "alt" })); // vPilot's own altitude reporting follows
          return { ok: true };
        }
        // IDENT: vPilot sends the ident to the network; without the plugin only the sim's own transponder lights up.
        if (this.plugin) return this.ask((id) => ({ op: "ident", id }));
        return this.radios.ident() ? { ok: true } : { ok: false, error: "Couldn't reach the simulator." };
      }
      case "net": {
        if (cmd.action === "disconnect") return this.ask((id) => ({ op: "disconnect", id }));
        const callsign = (cmd.callsign ?? this.last?.callsign ?? "").toUpperCase();
        const type = (cmd.type ?? this.last?.type ?? "").toUpperCase();
        const selcal = (cmd.selcal ?? this.last?.selcal ?? "").toUpperCase();
        if (!callsign || !type) return { ok: false, error: "Enter your callsign and aircraft type first." };
        this.last = { callsign, type, selcal };
        this.saveIdentity();
        return this.ask((id) => ({ op: "connect", id, callsign, type, selcal }));
      }
      case "send": {
        if (cmd.to.kind === "private") {
          const to = cmd.to.callsign.toUpperCase();
          const r = await this.ask((id) => ({ op: "sendPrivate", id, to, text: cmd.text }));
          if (r.ok) this.push({ kind: "private", dir: "out", from: this.net.callsign ?? "ME", to, freqHz: [], text: cmd.text, thread: `dm:${to}`, attention: false });
          return r;
        }
        const v = this.radios?.values()?.radios;
        const want = cmd.to.freqHz;
        if (want && v && v.com1.active !== want && v.com2.active !== want) return { ok: false, error: `Neither radio is tuned to ${formatMhz(want)}. Tune one first.` };
        const hz = want ?? v?.com1.active ?? 0;
        const r = await this.ask((id) => ({ op: "sendRadio", id, text: cmd.text }));
        if (r.ok) this.push({ kind: "radio", dir: "out", from: this.net.callsign ?? "ME", to: null, freqHz: hz ? [hz] : [], text: cmd.text, thread: `freq:${hz}`, attention: false });
        return r;
      }
    }
  }

  /* ------------------------------------------------------------ identity */

  private loadIdentity() {
    if (!this.identityFile) return;
    try {
      const j = JSON.parse(readFileSync(this.identityFile, "utf8")) as Partial<Identity>;
      if (j.callsign && j.type) this.last = { callsign: j.callsign, type: j.type, selcal: j.selcal ?? "" };
    } catch {
      /* first run */
    }
  }
  private saveIdentity() {
    if (!this.identityFile || !this.last) return;
    try {
      mkdirSync(dirname(this.identityFile), { recursive: true });
      writeFileSync(this.identityFile, JSON.stringify(this.last));
    } catch (e) {
      this.log.warn(`Couldn't save your callsign: ${(e as Error).message}`);
    }
  }
}
