import type { SimStatus, Telemetry, TelemetryFrame } from "@vbuddy/protocol";
import { randomUUID } from "node:crypto";
import type { FrameArchive } from "./db/recorder.js";
import type { SimSource } from "./sim/source.js";

/** A sample older than this is treated as "no data" (sim paused hard, stalled, or gone). */
const STALE_MS = 3000;

/** Most frames sent in one resume. A longer outage is thinned to stay under this. */
export const MAX_REPLAY_FRAMES = 4000;

export type ResumeResult =
  | { status: "ok" | "gap"; frames: TelemetryFrame[]; stride: number; fromDisk: number }
  | { status: "new-session"; frames: []; stride: 1; fromDisk: 0 };

/**
 * Turns raw samples (up to every sim frame) into a numbered stream at a fixed
 * rate, and keeps the recent part of that stream so a client that drops off
 * can ask for exactly what it missed.
 */
export class TelemetryHub {
  readonly sessionId = randomUUID();
  private latest: { t: Telemetry; at: number } | null = null;
  private nextSeq = 0;
  private ring: TelemetryFrame[];
  private ringStart = 0; // index of oldest frame in ring
  private ringLen = 0;
  private timer: NodeJS.Timeout | null = null;
  private frameCbs: Array<(f: TelemetryFrame) => void> = [];
  private statusCbs: Array<(s: SimStatus) => void> = [];
  private archive: FrameArchive | null = null;
  /** True when the aircraft's own autopilot is on although the simulator's standard flag says off (the Fenix keeps its own). */
  private apOverride: (() => boolean) | null = null;
  private extra: Pick<SimStatus, "inFlight" | "flight" | "vatsimReg"> = {};

  constructor(
    private source: SimSource,
    readonly hz: number,
    backlogMinutes: number,
    private maxReplay = MAX_REPLAY_FRAMES,
  ) {
    this.ring = new Array(Math.max(1, Math.round(hz * 60 * backlogMinutes)));
    source.onSample((t, at) => {
      this.latest = { t: !t.ap.master && this.apOverride?.() ? { ...t, ap: { ...t.ap, master: true } } : t, at };
    });
    source.onStatus((s) => {
      if (!s.connected) this.latest = null;
      this.emitStatus();
    });
  }

  /** Lets an aircraft backend say "autopilot on" when the standard simulator flag doesn't. */
  setApOverride(fn: (() => boolean) | null) {
    this.apOverride = fn;
  }

  apOverrideOn(): boolean {
    return this.apOverride?.() ?? false;
  }

  /** Where frames older than the in-memory buffer can be fetched from (the flight log). */
  setArchive(a: FrameArchive | null) {
    this.archive = a;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1000 / this.hz);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onFrame(cb: (f: TelemetryFrame) => void) {
    this.frameCbs.push(cb);
  }
  onStatus(cb: (s: SimStatus) => void) {
    this.statusCbs.push(cb);
  }

  /** The source's status plus what the bridge works out on top (in a flight, which flight, the map trail). */
  simStatus(): SimStatus {
    return { ...this.source.status(), ...this.extra };
  }

  /** Adds to the status the clients see; sent to them when it changes. */
  patchStatus(p: Pick<SimStatus, "inFlight" | "flight" | "vatsimReg">) {
    const next = { ...this.extra, ...p };
    if (JSON.stringify(next) === JSON.stringify(this.extra)) return;
    this.extra = next;
    this.emitStatus();
  }

  private emitStatus() {
    const s = this.simStatus();
    for (const cb of this.statusCbs) cb(s);
  }

  /** Highest seq produced so far, or -1. */
  latestSeq() {
    return this.nextSeq - 1;
  }

  oldestSeq() {
    return this.ringLen === 0 ? this.nextSeq : this.ring[this.ringStart]!.seq;
  }

  /** Builds and stores a frame from the latest sample. Exposed for tests. */
  tick(now = Date.now()): TelemetryFrame | null {
    const l = this.latest;
    if (!l || now - l.at > STALE_MS) return null;
    const frame: TelemetryFrame = { seq: this.nextSeq++, ts: l.at, data: l.t };
    this.push(frame);
    for (const cb of this.frameCbs) cb(frame);
    return frame;
  }

  private push(f: TelemetryFrame) {
    const cap = this.ring.length;
    if (this.ringLen < cap) {
      this.ring[(this.ringStart + this.ringLen) % cap] = f;
      this.ringLen++;
    } else {
      this.ring[this.ringStart] = f;
      this.ringStart = (this.ringStart + 1) % cap;
    }
  }

  /**
   * Frames with seq > lastSeq, oldest first: from memory, and for anything older
   * than the buffer, from the archive. If that is more than maxReplay frames
   * the outage is thinned to every Nth frame (counted from the first missed
   * one, newest always included) and `stride` says so.
   */
  resume(sessionId: string, lastSeq: number): ResumeResult {
    if (sessionId !== this.sessionId) return { status: "new-session", frames: [], stride: 1, fromDisk: 0 };
    const want = Math.max(0, lastSeq + 1);
    const n = this.nextSeq - want; // frames the client is missing
    if (n <= 0) return { status: "ok", frames: [], stride: 1, fromDisk: 0 };

    const stride = Math.max(1, Math.ceil(n / this.maxReplay));
    const last = this.nextSeq - 1;
    const oldest = this.oldestSeq();

    let frames: TelemetryFrame[] = [];
    if (want < oldest && this.archive) {
      try {
        frames = this.archive.range(sessionId, want, oldest - 1, stride).filter((f) => f.seq < oldest);
      } catch {
        frames = []; // a failing disk means a gap, not a failed reconnect
      }
    }
    const fromDisk = frames.length;

    const cap = this.ring.length;
    for (let s = Math.max(want, oldest); s <= last; s++) {
      if ((s - want) % stride === 0 || s === last) frames.push(this.ring[(this.ringStart + (s - oldest)) % cap]!);
    }

    const expected = Math.floor((n - 1) / stride) + 1 + ((n - 1) % stride === 0 ? 0 : 1);
    return { status: frames.length >= expected ? "ok" : "gap", frames, stride, fromDisk };
  }
}
