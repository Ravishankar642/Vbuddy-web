import type { Landing, SimStatus, TelemetryFrame } from "@vbuddy/protocol";
import type { FlightDb, FlightRow, FlightUpdate, TrackPoint } from "./flight-db.js";
import type { Logger } from "../log.js";

/** Old frames that a reconnecting client can be given from disk. */
export interface FrameArchive {
  /** Frames with fromSeq <= seq <= toSeq of this bridge run, every `stride`th, oldest first. */
  range(sessionId: string, fromSeq: number, toSeq: number, stride: number): TelemetryFrame[];
}

/** Read side of the flight log, for the HTTP API. */
export interface FlightHistory {
  flights(limit: number): FlightRow[];
  track(id: number, maxPoints: number): TrackPoint[] | null;
  setDistance(id: number, nm: number): void;
}

export interface RecorderOptions {
  flushMs?: number;
  /** A pause in telemetry longer than this starts a new flight. */
  flightGapMs?: number;
  /** Frames held back while the disk is failing; the oldest are dropped past this. */
  maxPending?: number;
}

interface Open {
  id: number;
  aircraft: string;
  lastTs: number;
  firstSeq: number;
  lastSeq: number;
  frames: number;
  lat: number;
  lon: number;
  maxAlt: number;
  maxGs: number;
  dirty: boolean;
  planned: boolean;
}

/**
 * Writes the numbered telemetry stream to the flight database, whether or not
 * any client is connected, in small batches so the sim loop never waits on disk.
 * A disk problem never reaches the live stream: it is logged once and retried.
 */
export class FlightRecorder implements FrameArchive, FlightHistory {
  private pending: TelemetryFrame[] = [];
  private cur: Open | null = null;
  private lastFlightId: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failing = false;
  private dropped = 0;
  private flushMs: number;
  private gapMs: number;
  private maxPending: number;

  constructor(
    private db: FlightDb,
    private sessionId: string,
    private source: "mock" | "simconnect",
    private aircraft: () => string,
    private log: Logger,
    opts: RecorderOptions = {},
    /** The departure and arrival of the SimBrief plan, if one is filled in. */
    private plan: () => { dep: string; arr: string } | null = () => null,
  ) {
    this.flushMs = opts.flushMs ?? 2000;
    this.gapMs = opts.flightGapMs ?? 10 * 60_000;
    this.maxPending = opts.maxPending ?? 20_000;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushMs);
    this.timer.unref();
  }

  /** The sim went away: whatever flight was open is over. */
  onStatus(s: SimStatus) {
    if (!s.connected) this.closeFlight();
  }

  onFrame(f: TelemetryFrame) {
    const title = this.aircraft();
    const c = this.cur;
    if (c && (f.ts - c.lastTs > this.gapMs || (title && c.aircraft && title !== c.aircraft))) this.closeFlight();
    if (!this.cur) this.openFlight(f, title);
    const o = this.cur!;
    if (!o.aircraft && title) {
      o.aircraft = title;
      o.dirty = true;
    }
    o.lastTs = f.ts;
    o.lastSeq = f.seq;
    o.frames++;
    o.lat = f.data.lat;
    o.lon = f.data.lon;
    o.maxAlt = Math.max(o.maxAlt, f.data.altMsl);
    o.maxGs = Math.max(o.maxGs, f.data.gs);
    o.dirty = true;
    this.pending.push(f);
    if (this.pending.length > this.maxPending) {
      const over = this.pending.length - this.maxPending;
      this.pending.splice(0, over);
      this.dropped += over;
    }
  }

  private openFlight(f: TelemetryFrame, title: string) {
    let id = -1;
    try {
      id = this.db.openFlight({
        sessionId: this.sessionId,
        startedAt: f.ts,
        source: this.source,
        aircraft: title,
        firstSeq: f.seq,
        lat: f.data.lat,
        lon: f.data.lon,
      });
    } catch (e) {
      this.fail("start a flight", e);
    }
    this.cur = { id, aircraft: title, lastTs: f.ts, firstSeq: f.seq, lastSeq: f.seq, frames: 0, lat: f.data.lat, lon: f.data.lon, maxAlt: f.data.altMsl, maxGs: f.data.gs, dirty: true, planned: false };
    if (id >= 0) this.lastFlightId = id;
  }

  private closeFlight() {
    if (!this.cur) return;
    this.flush();
    this.cur = null;
  }

  /** Flight a landing belongs to: the open one, else the most recent. */
  currentFlightId(): number | null {
    return this.cur && this.cur.id >= 0 ? this.cur.id : this.lastFlightId;
  }

  saveLanding(l: Landing) {
    try {
      this.db.insertLanding(l, this.currentFlightId());
    } catch (e) {
      this.fail("save a landing", e);
    }
  }

  /** Writes everything buffered. Safe to call any time; never throws. */
  flush() {
    const c = this.cur;
    try {
      if (c && c.id < 0) {
        // the flight row couldn't be created earlier; try again
        c.id = this.db.openFlight({ sessionId: this.sessionId, startedAt: c.lastTs, source: this.source, aircraft: c.aircraft, firstSeq: c.firstSeq, lat: c.lat, lon: c.lon });
        this.lastFlightId = c.id;
      }
      if (this.pending.length) {
        this.db.insertFrames(this.sessionId, this.pending);
        this.pending = [];
      }
      if (c && c.id >= 0 && !c.planned) {
        const pl = this.plan();
        if (pl) {
          this.db.setFlightPlan(c.id, pl.dep, pl.arr);
          c.planned = true;
        }
      }
      if (c && c.id >= 0 && c.dirty) {
        const u: FlightUpdate = {
          endedAt: c.lastTs,
          aircraft: c.aircraft || undefined,
          lastSeq: c.lastSeq,
          frames: c.frames,
          endLat: c.lat,
          endLon: c.lon,
          maxAltFt: c.maxAlt,
          maxGsKt: c.maxGs,
        };
        this.db.updateFlight(c.id, u);
        c.dirty = false;
      }
      if (this.failing) {
        this.failing = false;
        this.log.info(`Flight log is writing again${this.dropped ? ` (${this.dropped} frames were lost meanwhile)` : ""}.`);
        this.dropped = 0;
      }
    } catch (e) {
      this.fail("write the flight log", e);
    }
  }

  private fail(what: string, e: unknown) {
    if (!this.failing) this.log.warn(`Couldn't ${what}: ${(e as Error).message}. Live data is unaffected; will keep retrying.`);
    this.failing = true;
  }

  /** Deletes frames older than `hours`. */
  prune(hours: number, now = Date.now()) {
    try {
      const n = this.db.pruneFrames(now - hours * 3_600_000);
      if (n > 0) this.log.info(`Flight log: removed ${n} telemetry frames older than ${hours} h.`);
    } catch (e) {
      this.log.warn(`Couldn't clean up old telemetry: ${(e as Error).message}`);
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  /* ---- FrameArchive / FlightHistory ---- */

  range(sessionId: string, fromSeq: number, toSeq: number, stride: number): TelemetryFrame[] {
    this.flush(); // frames still waiting for the next batch must be visible too
    return this.db.frames(sessionId, fromSeq, toSeq, stride);
  }
  flights(limit: number) {
    this.flush();
    return this.db.flights(limit);
  }
  track(id: number, maxPoints: number) {
    this.flush();
    return this.db.track(id, maxPoints);
  }
  setDistance(id: number, nm: number) {
    this.db.setFlightDistance(id, nm);
  }
}
