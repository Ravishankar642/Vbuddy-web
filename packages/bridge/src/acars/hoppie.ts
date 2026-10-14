import type { AcarsCommand, AcarsMessage, AcarsState, Briefing } from "@vbuddy/protocol";
import { randomUUID } from "node:crypto";
import type { Logger } from "../log.js";

export const HOPPIE_URL = "https://www.hoppie.nl/acars/system/connect.html";
const POLL_MS = 60_000;
const MIN_MANUAL_POLL_MS = 20_000;
const KEEP = 200;

export type HoppieFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Reads one token: a word, or a {braced group} (the braces are dropped). Returns null at the end. */
function token(s: string, from: number): { value: string; end: number } | null {
  let i = from;
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (i >= s.length) return null;
  if (s[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      if (s[j] === "{") depth++;
      else if (s[j] === "}" && --depth === 0) break;
    }
    return { value: s.slice(i + 1, j), end: j + 1 };
  }
  let j = i;
  while (j < s.length && !/\s/.test(s[j]!)) j++;
  return { value: s.slice(i, j), end: j };
}

export interface RawMessage {
  from: string;
  type: string;
  packet: string;
}

/** "ok {FROM type {packet}} {...}" or "error {reason}". */
export function parseReply(body: string): { ok: true; messages: RawMessage[] } | { ok: false; error: string } {
  const first = token(body.trim(), 0);
  if (!first) return { ok: false, error: "Hoppie sent an empty answer." };
  if (first.value.toLowerCase() === "error") {
    const why = token(body.trim(), first.end);
    return { ok: false, error: why?.value || "Hoppie refused the request." };
  }
  if (first.value.toLowerCase() !== "ok") return { ok: false, error: `Unexpected answer from Hoppie: ${body.trim().slice(0, 80)}` };
  const messages: RawMessage[] = [];
  const text = body.trim();
  let pos = first.end;
  for (;;) {
    const group = token(text, pos);
    if (!group) break;
    pos = group.end;
    const from = token(group.value, 0);
    const type = from && token(group.value, from.end);
    const packet = type && token(group.value, type.end);
    if (from && type) messages.push({ from: from.value.toUpperCase(), type: type.value.toLowerCase(), packet: packet?.value ?? "" });
  }
  return { ok: true, messages };
}

const RA_ANSWERS: Record<string, NonNullable<AcarsMessage["answers"]>> = {
  WU: ["WILCO", "UNABLE", "STANDBY"],
  AN: ["AFFIRM", "NEGATIVE", "STANDBY"],
  R: ["ROGER", "UNABLE", "STANDBY"],
};

/** "/data2/<min>/<mrn>/<ra>/<text>" */
export function parseCpdlc(packet: string): { min: number | null; mrn: number | null; ra: string; text: string } | null {
  const m = /^\/data2\/(\d*)\/(\d*)\/([A-Z]{1,2})\/([\s\S]*)$/.exec(packet.trim());
  if (!m) return null;
  return { min: m[1] ? Number(m[1]) : null, mrn: m[2] ? Number(m[2]) : null, ra: m[3]!, text: m[4]!.replace(/@/g, " ").replace(/\s+/g, " ").trim() };
}

/**
 * The pilot's Hoppie ACARS account: checks for messages about once a minute while a flight is on, and sends telex,
 * CPDLC replies, predeparture clearance and weather requests. Messages are kept in memory (the last 200).
 */
export class HoppieService {
  private messages: AcarsMessage[] = [];
  private lastPollAt: number | null = null;
  private error: string | null = null;
  private logon: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private seq = 0;
  private stateCbs: Array<() => void> = [];
  private msgCbs: Array<(m: AcarsMessage) => void> = [];
  private lastJson = "";

  constructor(
    private fetcher: HoppieFetch,
    private code: () => string,
    private callsign: () => string | null,
    private flightOn: () => boolean,
    private briefing: () => Promise<Briefing>,
    private log: Logger,
    private now: () => number = Date.now,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5_000);
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  onState(cb: () => void) {
    this.stateCbs.push(cb);
  }
  onMessage(cb: (m: AcarsMessage) => void) {
    this.msgCbs.push(cb);
  }

  state(): AcarsState {
    const configured = this.code() !== "";
    return { configured, callsign: this.callsign(), polling: configured && this.flightOn() && this.callsign() !== null, lastPollAt: this.lastPollAt, error: this.error, logon: this.logon, messages: this.messages.slice() };
  }

  /** Tells listeners when something the pilot can see has changed. Also called when the code or callsign changes. */
  changed() {
    const j = JSON.stringify(this.state());
    if (j === this.lastJson) return;
    this.lastJson = j;
    for (const cb of this.stateCbs) cb();
  }

  private add(m: Omit<AcarsMessage, "id" | "ts">): AcarsMessage {
    const full: AcarsMessage = { id: randomUUID(), ts: this.now(), ...m };
    this.messages.push(full);
    if (this.messages.length > KEEP) this.messages.splice(0, this.messages.length - KEEP);
    return full;
  }

  private async tick() {
    if (this.code() === "" || !this.flightOn() || !this.callsign()) {
      this.changed();
      return;
    }
    const due = this.lastPollAt === null || this.now() - this.lastPollAt >= POLL_MS;
    if (due) await this.poll();
  }

  private async call(type: string, to: string, packet: string): Promise<ReturnType<typeof parseReply>> {
    const from = this.callsign();
    const code = this.code();
    if (!code) return { ok: false, error: "Enter your Hoppie logon code in the VBuddy window on the PC first." };
    if (!from) return { ok: false, error: "No callsign yet. Connect to VATSIM in vPilot, or generate a SimBrief plan." };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    try {
      const r = await this.fetcher(HOPPIE_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "VBuddy" },
        body: new URLSearchParams({ logon: code, from, to, type, packet }).toString(),
        signal: ctl.signal,
      });
      if (!r.ok) return { ok: false, error: `Hoppie answered HTTP ${r.status}.` };
      return parseReply(await r.text());
    } catch {
      return { ok: false, error: "Couldn't reach Hoppie. Check the PC's internet connection." };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Fetches waiting messages. */
  async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const from = this.callsign();
      const r = await this.call("poll", "SERVER", "");
      this.lastPollAt = this.now();
      if (!r.ok) {
        const wasOk = this.error === null;
        this.error = /logon/i.test(r.error) ? "Hoppie doesn't accept this logon code. Check it in the VBuddy window." : r.error;
        if (wasOk) this.log.warn(`Hoppie: ${this.error}`);
        return;
      }
      this.error = null;
      for (const raw of r.messages) {
        // Our own earlier messages can come back on a poll; ignore anything "from" us.
        if (from && raw.from === from.toUpperCase()) continue;
        const m = this.incoming(raw);
        if (m) for (const cb of this.msgCbs) cb(m);
      }
    } finally {
      this.polling = false;
      this.changed();
    }
  }

  private incoming(raw: RawMessage): AcarsMessage | null {
    if (raw.type === "cpdlc") {
      const c = parseCpdlc(raw.packet);
      if (!c) return this.add({ dir: "in", peer: raw.from, kind: "cpdlc", text: raw.packet });
      const answers = RA_ANSWERS[c.ra];
      return this.add({ dir: "in", peer: raw.from, kind: "cpdlc", text: c.text, ...(c.min !== null ? { min: c.min } : {}), ...(answers ? { answers } : {}) });
    }
    if (raw.type === "telex") return this.add({ dir: "in", peer: raw.from, kind: "telex", text: raw.packet.trim() });
    if (raw.type === "ping" || raw.type === "poll") return null;
    return this.add({ dir: "in", peer: raw.from, kind: "info", text: raw.packet.trim() });
  }

  async run(cmd: AcarsCommand): Promise<{ ok: true } | { ok: false; error: string }> {
    const fail = (error: string) => ({ ok: false as const, error });
    switch (cmd.op) {
      case "clear":
        this.messages = [];
        this.changed();
        return { ok: true };
      case "poll":
        if (this.lastPollAt !== null && this.now() - this.lastPollAt < MIN_MANUAL_POLL_MS) return fail("Checked a moment ago. Hoppie asks for no more than about one check a minute.");
        await this.poll();
        return this.error ? fail(this.error) : { ok: true };
      case "telex": {
        const to = cmd.to.toUpperCase();
        const text = cmd.text.toUpperCase().replace(/[{}]/g, "");
        const r = await this.call("telex", to, text);
        if (!r.ok) return fail(r.error);
        this.add({ dir: "out", peer: to, kind: "telex", text });
        this.changed();
        return { ok: true };
      }
      case "info": {
        const icao = cmd.icao.toUpperCase();
        const r = await this.call("inforeq", "SERVER", `${cmd.kind} ${icao}`);
        if (!r.ok) return fail(r.error);
        this.add({ dir: "out", peer: "SERVER", kind: "system", text: `Requested ${cmd.kind.toUpperCase()} for ${icao}. The answer arrives within a minute or so.` });
        this.changed();
        return { ok: true };
      }
      case "pdc": {
        const b = await this.briefing().catch(() => null);
        const o = b?.ofp;
        const dep = b?.airports.find((a) => a.role === "origin");
        const arr = b?.airports.find((a) => a.role === "destination");
        const cs = this.callsign();
        if (!o || !dep || !arr || !cs) return fail("A PDC request needs your SimBrief plan (departure, arrival, aircraft). Enter your SimBrief name in the VBuddy window and generate a plan first.");
        const parts = [`REQUEST PREDEP CLEARANCE ${cs}`, `${o.aircraft ?? "ZZZZ"} TO ${arr.icao} AT ${dep.icao}`, cmd.stand ? `STAND ${cmd.stand.toUpperCase()}` : "", cmd.atis ? `ATIS ${cmd.atis.toUpperCase()}` : ""].filter(Boolean);
        const text = parts.join(" ");
        const to = cmd.to.toUpperCase();
        const r = await this.call("telex", to, text);
        if (!r.ok) return fail(r.error);
        this.add({ dir: "out", peer: to, kind: "telex", text });
        this.changed();
        return { ok: true };
      }
      case "cpdlcLogon": {
        const to = cmd.to.toUpperCase();
        const r = await this.call("cpdlc", to, `/data2/${++this.seq}//Y/REQUEST LOGON`);
        if (!r.ok) return fail(r.error);
        this.logon = to;
        this.add({ dir: "out", peer: to, kind: "cpdlc", text: "REQUEST LOGON" });
        this.changed();
        return { ok: true };
      }
      case "cpdlcReply": {
        const m = this.messages.find((x) => x.id === cmd.id && x.kind === "cpdlc" && x.dir === "in");
        if (!m || m.min === undefined) return fail("That message can't be answered.");
        if (m.answered) return fail(`Already answered (${m.answered}).`);
        if (!m.answers?.includes(cmd.answer)) return fail(`${cmd.answer} isn't a valid answer to this message.`);
        const r = await this.call("cpdlc", m.peer, `/data2/${++this.seq}/${m.min}/N/${cmd.answer}`);
        if (!r.ok) return fail(r.error);
        m.answered = cmd.answer;
        this.add({ dir: "out", peer: m.peer, kind: "cpdlc", text: cmd.answer });
        this.changed();
        return { ok: true };
      }
    }
  }
}
