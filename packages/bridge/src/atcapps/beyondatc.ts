import { parseMhz, type AtcAppStatus } from "@vbuddy/protocol";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "../log.js";

/*
 * BeyondATC: its ATC messages in VBuddy's Comms. BeyondATC has no public interface for other apps, so VBuddy reads the
 * log it writes while you fly (Unity's Player.log in %USERPROFILE%\AppData\LocalLow\Skirmish Mode Games, Inc\BeyondATC),
 * from the end, as it grows. The log's format isn't documented, so the reader looks for the shapes ATC lines take
 * (a speaker, then the words) and leaves everything else alone. EXPERIMENTAL until checked against real logs.
 * BeyondATC's spoken ATC is also caught by VBuddy's voice-to-text, which needs no log at all.
 */

const POLL_MS = 1500;
const MAX_READ = 256 * 1024;

export interface BatcLine {
  dir: "in" | "out";
  from: string;
  text: string;
  freqHz: number | null;
}

const ATC_SPEAKER = /^(atc|controller|tower|ground|approach|departure|center|centre|clearance|delivery|apron|ramp|radar|control|unicom|atis|[A-Z]{4}[_ ](?:del|gnd|twr|app|dep|ctr)|[A-Z][\w .'-]{1,30} (?:tower|ground|approach|departure|center|centre|control|radar|delivery|clearance))$/i;
const PILOT_SPEAKER = /^(pilot|you|player|user|me|readback)$/i;
/** Lines that are clearly the app talking about itself, not ATC. */
const NOISE = /(exception|error|warning|loaded|loading|initializ|shader|texture|audio device|gc|memory|unity|\.dll|\.cs:|fps|websocket|http|token|license|settings?)\b/i;

/**
 * One log line to a conversation line, or null. Recognised shapes:
 *   [12:34:56] Tower: Speedbird 123, cleared to land runway 27
 *   ATC (118.700): ...      Pilot: ...       Controller says: "..."
 *   {"speaker":"ATC","text":"...","frequency":"118.700"}
 */
export function parseBatcLine(raw: string): BatcLine | null {
  let line = raw.trim();
  if (!line || line.length > 600) return null;
  // JSON lines.
  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const text = [j.text, j.message, j.transcript, j.phrase].find((v) => typeof v === "string" && v.trim()) as string | undefined;
      const who = [j.speaker, j.from, j.role, j.source].find((v) => typeof v === "string") as string | undefined;
      if (!text || !who) return null;
      const freq = typeof j.frequency === "string" || typeof j.frequency === "number" ? parseMhz(String(j.frequency)) : null;
      if (PILOT_SPEAKER.test(who)) return { dir: "out", from: "YOU", text: text.trim(), freqHz: freq };
      if (ATC_SPEAKER.test(who) || /atc/i.test(who)) return { dir: "in", from: who.trim(), text: text.trim(), freqHz: freq };
      return null;
    } catch {
      return null;
    }
  }
  // Strip timestamps and log levels in brackets at the start.
  line = line.replace(/^(\s*(\[[^\]]{1,40}\]|\d{1,2}:\d{2}(:\d{2})?(\.\d+)?|\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*)+/, "");
  const m = /^([A-Za-z][\w .'-]{0,40}?)\s*(?:\((\d{3}\.\d{1,3})\))?\s*(?:says|said)?\s*[:>]\s*["“]?(.+?)["”]?$/.exec(line);
  if (!m) return null;
  const who = m[1]!.trim();
  const text = m[3]!.trim();
  if (text.length < 4 || NOISE.test(who) || NOISE.test(text) && !/runway|squawk|climb|descend|taxi|contact|cleared|heading/i.test(text)) return null;
  const freqHz = m[2] ? parseMhz(m[2]) : null;
  if (PILOT_SPEAKER.test(who)) return { dir: "out", from: "YOU", text, freqHz };
  if (ATC_SPEAKER.test(who)) return { dir: "in", from: who, text, freqHz };
  return null;
}

export class BeyondAtcLog {
  private st: AtcAppStatus = { state: "off", message: null };
  private cbs: Array<() => void> = [];
  private lineCbs: Array<(l: BatcLine) => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private pos = -1;
  private carry = "";
  private seen = 0;

  constructor(
    private enabled: () => boolean,
    private log: Logger,
    private file: string | null = process.env.USERPROFILE ? join(process.env.USERPROFILE, "AppData", "LocalLow", "Skirmish Mode Games, Inc", "BeyondATC", "Player.log") : null,
  ) {}

  status() {
    return this.st;
  }
  onStatus(cb: () => void) {
    this.cbs.push(cb);
  }
  onLine(cb: (l: BatcLine) => void) {
    this.lineCbs.push(cb);
  }
  private set(s: AtcAppStatus) {
    if (s.state === this.st.state && s.message === this.st.message) return;
    this.st = s;
    for (const cb of this.cbs) cb();
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.timer.unref?.();
    this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Exposed for tests: read what was added to the log since last time. */
  tick() {
    if (!this.enabled() || !this.file) {
      this.pos = -1;
      return this.set({ state: "off", message: null });
    }
    if (!existsSync(this.file)) return this.set({ state: "waiting", message: "BeyondATC's log wasn't found on this PC (start BeyondATC)." });
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    // From the end on first sight (not the whole of an old flight), and from the start when BeyondATC restarts the log.
    if (this.pos < 0 || size < this.pos) {
      this.pos = this.pos < 0 ? size : 0;
      this.carry = "";
    }
    if (size === this.pos) {
      if (this.st.state !== "live") this.set({ state: "waiting", message: this.seen ? null : "Reading BeyondATC's log. ATC messages show here as BeyondATC writes them (experimental)." });
      return;
    }
    const len = Math.min(MAX_READ, size - this.pos);
    const buf = Buffer.alloc(len);
    try {
      const fd = openSync(this.file, "r");
      readSync(fd, buf, 0, len, this.pos);
      closeSync(fd);
    } catch {
      return;
    }
    this.pos += len;
    const text = this.carry + buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    this.carry = lines.pop() ?? "";
    for (const l of lines) {
      const hit = parseBatcLine(l);
      if (!hit) continue;
      this.seen++;
      for (const cb of this.lineCbs) cb(hit);
    }
    this.set(this.seen ? { state: "live", message: null } : { state: "waiting", message: "Reading BeyondATC's log. ATC messages show here as BeyondATC writes them (experimental)." });
  }
}
