import { randomUUID } from "node:crypto";
import type { FlareSample, Landing, Telemetry } from "@vbuddy/protocol";
import { EMPTY_EXTRAS, type SimExtras } from "../sim/source.js";
import { rateLanding } from "./rating.js";

/**
 * Landing analyzer.
 *
 * It is fed every telemetry sample the sim produces (not the 5 Hz stream the
 * clients get) and keeps the last 45 seconds in a ring buffer. When the
 * aircraft goes from airborne to on-ground it opens a landing, follows it
 * through any bounces until the aircraft has settled, then builds one record
 * with the touchdown numbers and a ~10 Hz trace from 20 s before to 3 s after.
 *
 * It never reads a clock: every decision uses the timestamps passed in, so a
 * recorded or synthetic flight gives the same result at any speed. `flush()`
 * is the only way time moves without data (called on a timer by the bridge).
 *
 * Heights are measured from the wheels-down reference at first contact, so
 * aircraft whose "altitude above ground" doesn't read 0 on the runway are fine.
 */

const RING_MS = 45_000;
const PROFILE_BEFORE_MS = 20_000;
const PROFILE_AFTER_MS = 3_000;
const PROFILE_STEP_MS = 100;

/** A touchdown only counts if the aircraft was flying for this long... */
const MIN_AIR_MS = 3_000;
/** ...and got at least this high above where it landed. Filters taxi/hop jitter. */
const MIN_AIR_HEIGHT_FT = 15;

/** The G peak is searched from just before to this long after first contact. */
const G_BEFORE_MS = 100;
const G_AFTER_MS = 1_000;
/** Descent-rate estimate is taken from this window before first contact. */
const ESTIMATE_WINDOW_MS = 400;
/** The sim's touchdown latch is looked for this long after first contact. */
const LATCH_WINDOW_MS = 1_500;
/** The "before" value of that latch is read from at least this long before contact. */
const LATCH_BEFORE_MS = 300;

/** Done when on the ground this long (and at least PROFILE_AFTER_MS after touchdown). */
const SETTLE_MS = 3_000;
const MAX_ACTIVE_MS = 15_000;
/** A hop off the ground counts as a bounce if it lasts this long and gets this high. */
const BOUNCE_MIN_MS = 300;
const BOUNCE_MIN_FT = 2;
/** Flying again this high / this long after contact = touch-and-go or go-around. */
const AIRBORNE_AGAIN_FT = 100;
const AIRBORNE_AGAIN_MS = 8_000;
/** Data around touchdown is "sparse" past this gap, or with fewer samples than MIN_WINDOW_SAMPLES. */
const SPARSE_GAP_MS = 250;
const MIN_WINDOW_SAMPLES = 3;
/** No samples for this long after touchdown: the sim stopped; wrap up with what we have. */
const STALL_MS = 3_000;

/** After the aircraft is (re)spawned the sim reports odd "airborne" and height values for a while; nothing counts until it settles. */
const SPAWN_QUIET_MS = 20_000;
/** A jump of this many degrees of latitude/longitude between two samples is a teleport (spawn, slew, "fly to"), not flight. */
const JUMP_DEG = 0.02;
/** A real approach is flown at speed: it must have reached this ground speed while airborne and still have it at touchdown. */
const MIN_AIR_GS_KT = 40;
const MIN_TD_GS_KT = 25;

/** Sanity range for the sim's own touchdown velocity, in fpm magnitude. */
const LATCH_MIN_FPM = 5;
const LATCH_MAX_FPM = 3_000;

interface Entry {
  at: number;
  t: Telemetry;
  x: SimExtras;
}

interface Active {
  tdAt: number;
  td: Entry;
  prev: Entry;
  groundRef: number;
  lowConfidence: boolean;
  hop: { since: number; maxFt: number } | null;
  bounces: number;
  bounceMaxFt: number;
  groundSince: number | null;
  lastAt: number;
  touchAndGo: boolean;
}

export interface AnalyzerContext {
  aircraftTitle: string;
  source: "simconnect" | "mock";
}

const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const rad = (d: number) => (d * Math.PI) / 180;

export class LandingAnalyzer {
  private ring: Entry[] = [];
  private extras: SimExtras = EMPTY_EXTRAS;
  private air: { since: number; maxAgl: number; maxGs: number } | null = null;
  /** Set by spawn(): the next sample starts a quiet period. */
  private quietPending = false;
  private armedAt = 0;
  private active: Active | null = null;
  private cbs: Array<(l: Landing) => void> = [];

  constructor(
    private context: () => AnalyzerContext,
    private newId: () => string = randomUUID,
  ) {}

  onLanding(cb: (l: Landing) => void) {
    this.cbs.push(cb);
  }

  setExtras(x: SimExtras) {
    this.extras = x;
  }

  /** True while a landing is open (touched down, not yet settled). */
  get busy() {
    return this.active !== null;
  }

  ingest(t: Telemetry, atIn: number) {
    const last = this.ring[this.ring.length - 1];
    const at = last ? Math.max(atIn, last.at) : atIn;
    const e: Entry = { at, t, x: this.extras };
    this.ring.push(e);
    this.prune(at);

    // Spawning, slewing or "fly to" put the aircraft somewhere new: whatever it was doing before is not a flight.
    if (this.quietPending) {
      this.quietPending = false;
      this.armedAt = at + SPAWN_QUIET_MS;
    }
    if (last && Math.abs(t.lat - last.t.lat) + Math.abs(t.lon - last.t.lon) > JUMP_DEG) {
      this.armedAt = at + SPAWN_QUIET_MS;
      this.air = null;
      if (this.active) this.finalize();
    }
    if (at < this.armedAt) {
      this.air = null;
      return;
    }

    if (this.active) {
      this.stepActive(e);
      return;
    }

    if (!t.onGround) {
      if (!this.air) this.air = { since: at, maxAgl: t.altAgl, maxGs: t.gs };
      else {
        this.air.maxAgl = Math.max(this.air.maxAgl, t.altAgl);
        this.air.maxGs = Math.max(this.air.maxGs, t.gs);
      }
      return;
    }

    const air = this.air;
    this.air = null;
    if (air && last && !last.t.onGround && at - air.since >= MIN_AIR_MS && air.maxAgl - t.altAgl >= MIN_AIR_HEIGHT_FT && air.maxGs >= MIN_AIR_GS_KT && t.gs >= MIN_TD_GS_KT) {
      this.begin(e, last);
    }
  }

  /** Lets an open landing finish when no more samples are coming. */
  flush(now: number) {
    const a = this.active;
    if (a && (now - a.lastAt > STALL_MS || now - a.tdAt >= MAX_ACTIVE_MS)) this.finalize();
  }

  /** An aircraft was just loaded or spawned: ignore the first moments while the sim settles. */
  spawn() {
    if (this.active) this.finalize();
    this.air = null;
    this.quietPending = true;
  }

  /** The sim went away: wrap up any open landing and forget everything. */
  reset() {
    if (this.active) this.finalize();
    this.armedAt = 0;
    this.quietPending = false;
    this.ring = [];
    this.air = null;
    this.extras = EMPTY_EXTRAS;
  }

  private prune(now: number) {
    const first = this.ring[0];
    // Trim in batches so we aren't shifting an array on every frame.
    if (first && now - first.at > RING_MS + 5_000) {
      const cutoff = now - RING_MS;
      let i = 0;
      while (i < this.ring.length && this.ring[i]!.at < cutoff) i++;
      this.ring.splice(0, i);
    }
  }

  private begin(e: Entry, prev: Entry) {
    let inWindow = 0;
    for (let i = this.ring.length - 2; i >= 0; i--) {
      const en = this.ring[i]!;
      if (e.at - en.at > ESTIMATE_WINDOW_MS) break;
      if (!en.t.onGround) inWindow++;
    }
    this.active = {
      tdAt: e.at,
      td: e,
      prev,
      groundRef: e.t.altAgl,
      lowConfidence: e.at - prev.at > SPARSE_GAP_MS || inWindow < MIN_WINDOW_SAMPLES,
      hop: null,
      bounces: 0,
      bounceMaxFt: 0,
      groundSince: e.at,
      lastAt: e.at,
      touchAndGo: false,
    };
  }

  private stepActive(e: Entry) {
    const a = this.active!;
    a.lastAt = e.at;

    if (!e.t.onGround) {
      a.groundSince = null;
      const h = e.t.altAgl - a.groundRef;
      if (!a.hop) a.hop = { since: e.at, maxFt: h };
      else a.hop.maxFt = Math.max(a.hop.maxFt, h);
      if (a.hop.maxFt >= AIRBORNE_AGAIN_FT || e.at - a.hop.since >= AIRBORNE_AGAIN_MS) {
        a.touchAndGo = true;
        this.finalize();
      }
      return;
    }

    if (a.hop) {
      if (e.at - a.hop.since >= BOUNCE_MIN_MS && a.hop.maxFt >= BOUNCE_MIN_FT) {
        a.bounces++;
        a.bounceMaxFt = Math.max(a.bounceMaxFt, a.hop.maxFt);
      }
      a.hop = null;
    }
    if (a.groundSince === null) a.groundSince = e.at;

    const sinceTd = e.at - a.tdAt;
    if ((e.at - a.groundSince >= SETTLE_MS && sinceTd >= PROFILE_AFTER_MS) || sinceTd >= MAX_ACTIVE_MS) this.finalize();
  }

  /** Value of `field` when the aircraft passed `level` ft going down, before first contact. */
  private atHeight(a: Active, level: number, field: "vs" | "pitch"): number | null {
    const ring = this.ring;
    let i = ring.length - 1;
    while (i >= 0 && ring[i]!.at >= a.tdAt) i--;
    for (; i >= 0; i--) {
      const en = ring[i]!;
      const h = en.t.altAgl - a.groundRef;
      if (h < level) continue;
      const next = ring[i + 1];
      if (!next || next.at >= a.tdAt) return en.t[field];
      const hn = next.t.altAgl - a.groundRef;
      if (hn >= h) return en.t[field];
      const f = (h - level) / (h - hn);
      return en.t[field] + (next.t[field] - en.t[field]) * Math.min(1, Math.max(0, f));
    }
    return null;
  }

  private finalize() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.air = null;

    const ring = this.ring;
    const { tdAt, td } = a;

    // --- descent rate: sim latch if it changed since before touchdown, else estimate
    let estimate: number | null = null;
    for (const en of ring) {
      if (en.at >= tdAt) break;
      if (en.at >= tdAt - ESTIMATE_WINDOW_MS && !en.t.onGround) estimate = estimate === null ? en.t.vs : Math.min(estimate, en.t.vs);
    }
    if (estimate === null) estimate = a.prev.t.vs;
    estimate = Math.min(0, r0(estimate));

    let beforeLatch: number | null = null;
    for (const en of ring) {
      if (en.at > tdAt - LATCH_BEFORE_MS) break;
      beforeLatch = en.x.touchdownNormalVelFps;
    }
    if (beforeLatch === null) beforeLatch = a.prev.x.touchdownNormalVelFps;
    let latch: number | null = null;
    for (const en of ring) {
      if (en.at < tdAt) continue;
      if (en.at > tdAt + LATCH_WINDOW_MS) break;
      const v = en.x.touchdownNormalVelFps;
      if (v === null || !Number.isFinite(v) || v === beforeLatch) continue;
      const fpm = Math.abs(v) * 60;
      if (fpm >= LATCH_MIN_FPM && fpm <= LATCH_MAX_FPM) {
        latch = v;
        break;
      }
    }
    const vsFpm = latch !== null ? -r0(Math.abs(latch) * 60) : estimate;

    // --- G peak
    let gPeak = td.t.gForce;
    for (const en of ring) {
      if (en.at < tdAt - G_BEFORE_MS) continue;
      if (en.at > tdAt + G_AFTER_MS) break;
      gPeak = Math.max(gPeak, en.t.gForce);
    }

    // --- flare
    let peakSink: number | null = null;
    let peakSinkAt: number | null = null;
    for (const en of ring) {
      if (en.at >= tdAt) break;
      const h = en.t.altAgl - a.groundRef;
      if (h < 0 || h > 100) continue;
      if (peakSink === null || en.t.vs < peakSink) {
        peakSink = en.t.vs;
        peakSinkAt = h;
      }
    }
    const opt = (v: number | null, f: (n: number) => number) => (v === null ? null : f(v));
    const pitchAt50 = this.atHeight(a, 50, "pitch");

    // --- wind (latest values around touchdown)
    let wx: SimExtras = td.x;
    for (const en of ring) {
      if (en.at < tdAt) continue;
      if (en.at > tdAt + LATCH_WINDOW_MS) break;
      wx = en.x;
    }
    let wind: Landing["wind"] = null;
    if (wx.windKt !== null && wx.windFromDeg !== null && Number.isFinite(wx.windKt) && Number.isFinite(wx.windFromDeg)) {
      const d = rad(wx.windFromDeg - td.t.hdgTrue);
      wind = {
        speedKt: r1(wx.windKt),
        fromDeg: r0(((wx.windFromDeg % 360) + 360) % 360),
        headwindKt: r1(wx.windKt * Math.cos(d)),
        crosswindKt: r1(wx.windKt * Math.sin(d)),
      };
    }

    // --- trace
    const profile: FlareSample[] = [];
    let lastKept = -Infinity;
    for (const en of ring) {
      if (en.at < tdAt - PROFILE_BEFORE_MS) continue;
      if (en.at > tdAt + PROFILE_AFTER_MS) break;
      if (en !== td && en.at - lastKept < PROFILE_STEP_MS) continue;
      lastKept = en.at;
      profile.push({
        t: r2((en.at - tdAt) / 1000),
        agl: r1(en.t.altAgl - a.groundRef),
        vs: r0(en.t.vs),
        pitch: r1(en.t.pitch),
        ias: r1(en.t.ias),
        g: r2(en.t.gForce),
        onGround: en.t.onGround,
      });
    }

    const { rating, ratedBy } = rateLanding(vsFpm, gPeak);
    const ctx = this.context();
    const landing: Landing = {
      id: this.newId(),
      ts: tdAt,
      source: ctx.source,
      aircraftTitle: ctx.aircraftTitle,
      lat: td.t.lat,
      lon: td.t.lon,
      hdgTrue: r0(td.t.hdgTrue),
      vsFpm,
      vsSource: latch !== null ? "sim" : "estimated",
      vsEstimateFpm: estimate,
      gPeak: r2(gPeak),
      pitch: r1(td.t.pitch),
      bank: r1(td.t.bank),
      iasKt: r0(td.t.ias),
      gsKt: r0(td.t.gs),
      bounces: a.bounces,
      bounceMaxFt: r1(a.bounceMaxFt),
      touchAndGo: a.touchAndGo,
      lowConfidence: a.lowConfidence,
      rating,
      ratedBy,
      wind,
      flare: {
        sinkAt50: opt(this.atHeight(a, 50, "vs"), r0),
        sinkAt30: opt(this.atHeight(a, 30, "vs"), r0),
        sinkAt10: opt(this.atHeight(a, 10, "vs"), r0),
        peakSinkFpm: opt(peakSink, r0),
        peakSinkAtFt: opt(peakSinkAt, r0),
        easedByFpm: peakSink === null ? null : r0(vsFpm - peakSink),
        pitchChange: pitchAt50 === null ? null : r1(td.t.pitch - pitchAt50),
      },
      profile,
    };
    for (const cb of this.cbs) cb(landing);
  }
}
