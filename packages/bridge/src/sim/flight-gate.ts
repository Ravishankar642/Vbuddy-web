import type { Telemetry } from "@vbuddy/protocol";
import type { SimExtras } from "./source.js";

/**
 * Decides when the aircraft is really flying, as opposed to sitting in the simulator's menu or hangar, loading,
 * being moved, or playing back a replay. Flights are only recorded, landings only counted and the map trail only
 * drawn while it says so.
 *
 * Signals, strongest first:
 *  - the sim's CAMERA STATE (menu, world map, hangar, loading and replay have their own values);
 *  - the "Sim" event (0 in the menus);
 *  - the position: MSFS parks the aircraft at 0°N 0°E or 0°N 90°E while nothing is loaded;
 *  - a position that doesn't move while the speed says it should (a replay or an active pause);
 *  - a jump of more than a mile between two samples (spawn, slew, "fly to", or the start of a replay).
 * After the aircraft is put somewhere new it has to sit there for a few seconds before the flight begins.
 */

/** CAMERA STATE values that are not flying: 11 waiting, 12 world map, 13-16 hangar and menus, 17 replay, 18 and 20-23 other screens. */
const NOT_FLYING = new Set([11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23]);
const REPLAY_CAMERA = 17;

export type GateReason = "flying" | "settling" | "menu" | "replay" | "paused" | "no-data";
export type EndReason = "menu" | "teleport" | "aircraft" | "sim-lost" | "idle";

export type GateEvent =
  /** A new flight begins: the aircraft has settled where it was put. `t` is the first good sample. */
  | { kind: "start"; at: number; t: Telemetry }
  /** The flight is over. */
  | { kind: "end"; at: number; reason: EndReason }
  /** Flying, or not (menu, replay, pause, settling), within an open flight. */
  | { kind: "flying"; at: number; flying: boolean; reason: GateReason };

export interface GateOptions {
  /** How long a new position has to hold before a flight starts there. */
  settleMs?: number;
  /** Back in the menu this long ends the flight. */
  menuEndMs?: number;
  /** Not flying for any reason this long ends the flight. */
  idleEndMs?: number;
  /** A jump this far from where the flight last was ends it (a new flight somewhere else). */
  teleportNm?: number;
}

const R_NM = 3440.065;
const rad = Math.PI / 180;
export function nm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const a = Math.sin(((bLat - aLat) * rad) / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(((bLon - aLon) * rad) / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Where MSFS keeps the aircraft while no flight is loaded. */
export function isPlaceholder(lat: number, lon: number): boolean {
  return Math.abs(lat) < 0.02 && (Math.abs(lon) < 0.02 || Math.abs(lon - 90) < 0.02);
}

/** Two samples further apart than this are a jump, not flying (a 30 Hz stream at Mach 1 moves 0.01 nm per sample). */
const JUMP_NM = 1.5;
/** The "frozen position" check looks back this far. */
const FROZEN_WINDOW_MS = 2_000;

interface Sample {
  at: number;
  lat: number;
  lon: number;
  gs: number;
  alt: number;
}

export class FlightGate {
  private cbs: Array<(e: GateEvent) => void> = [];
  private camera: number | null = null;
  private simRunning: number | null = null;
  private paused = false;
  private title = "";
  private recent: Sample[] = [];
  private last: Sample | null = null;
  private settleSince: number | null = null;
  private open = false;
  private flying = false;
  private reason: GateReason = "no-data";
  /** Last place the open flight was really flying. */
  private lastGood: { lat: number; lon: number } | null = null;
  private notFlyingSince: number | null = null;
  private menuSince: number | null = null;
  private readonly settleMs: number;
  private readonly menuEndMs: number;
  private readonly idleEndMs: number;
  private readonly teleportNm: number;

  constructor(o: GateOptions = {}) {
    this.settleMs = o.settleMs ?? 8_000;
    this.menuEndMs = o.menuEndMs ?? 30_000;
    this.idleEndMs = o.idleEndMs ?? 60 * 60_000;
    this.teleportNm = o.teleportNm ?? 20;
  }

  on(cb: (e: GateEvent) => void) {
    this.cbs.push(cb);
  }
  private emit(e: GateEvent) {
    for (const cb of this.cbs) cb(e);
  }

  /** True while a flight is open and the aircraft is flying (not in a replay, pause or the menu). */
  inFlight(): boolean {
    return this.flying;
  }
  /** A flight is open (it may be paused or in a replay right now). */
  flightOpen(): boolean {
    return this.open;
  }
  why(): GateReason {
    return this.reason;
  }

  extras(x: SimExtras) {
    this.camera = typeof x.cameraState === "number" && Number.isFinite(x.cameraState) ? Math.round(x.cameraState) : null;
    this.simRunning = typeof x.simRunning === "number" ? x.simRunning : null;
  }

  setPaused(p: boolean) {
    this.paused = p;
  }

  /** The aircraft changed: whatever was flying before is over. */
  aircraft(title: string, at: number) {
    if (title === this.title) return;
    const had = this.title;
    this.title = title;
    if (had && this.open) this.end(at, "aircraft");
    this.settleSince = null;
  }

  /** The simulator went away. */
  simLost(at: number) {
    if (this.open) this.end(at, "sim-lost");
    this.recent = [];
    this.last = null;
    this.settleSince = null;
    this.camera = null;
    this.simRunning = null;
    this.setFlying(false, "no-data", at);
  }

  sample(t: Telemetry, at: number) {
    const s: Sample = { at, lat: t.lat, lon: t.lon, gs: t.gs, alt: t.altMsl };
    const prev = this.last;
    this.last = s;
    this.recent.push(s);
    while (this.recent.length > 2 && at - this.recent[0]!.at > FROZEN_WINDOW_MS) this.recent.shift();

    const why = this.notFlyingReason(t, s);
    if (why) {
      this.settleSince = null;
      this.notFlying(why, at);
      return;
    }

    // A jump: somewhere new. Far from where the flight was = a new flight; near = slewed or nudged, same flight.
    if (prev && nm(prev.lat, prev.lon, s.lat, s.lon) > JUMP_NM) {
      this.settleSince = null;
      this.recent = [s];
    }
    if (this.open && this.lastGood && nm(this.lastGood.lat, this.lastGood.lon, s.lat, s.lon) > this.teleportNm) {
      this.end(at, "teleport");
    }
    if (this.settleSince === null) this.settleSince = at;
    if (at - this.settleSince < this.settleMs) {
      this.notFlying("settling", at);
      return;
    }
    if (!this.open) {
      this.open = true;
      this.emit({ kind: "start", at, t });
    }
    this.lastGood = { lat: s.lat, lon: s.lon };
    this.notFlyingSince = null;
    this.menuSince = null;
    this.setFlying(true, "flying", at);
  }

  /** Time passes without samples (the sim stopped sending): let long silences end the flight. */
  tick(at: number) {
    if (!this.open) return;
    if (this.last && at - this.last.at > 5_000) this.notFlying("no-data", at);
  }

  private notFlyingReason(t: Telemetry, s: Sample): GateReason | null {
    if (this.paused) return "paused";
    if (this.camera !== null && NOT_FLYING.has(this.camera)) return this.camera === REPLAY_CAMERA ? "replay" : "menu";
    if (this.simRunning === 0) return "menu";
    if (isPlaceholder(t.lat, t.lon)) return "menu";
    if (this.frozen(s)) return "replay";
    return null;
  }

  /** The speed says the aircraft is moving but the position doesn't change: a replay or an active pause. */
  private frozen(s: Sample): boolean {
    const first = this.recent[0];
    if (!first || s.at - first.at < FROZEN_WINDOW_MS * 0.75 || this.recent.length < 5) return false;
    const avgGs = this.recent.reduce((n, x) => n + x.gs, 0) / this.recent.length;
    if (avgGs < 5) return false; // parked: a still position is right
    const expectedNm = (avgGs * (s.at - first.at)) / 3_600_000;
    const moved = nm(first.lat, first.lon, s.lat, s.lon);
    return moved < expectedNm * 0.2;
  }

  private notFlying(why: GateReason, at: number) {
    this.setFlying(false, why, at);
    if (!this.open) return;
    if (this.notFlyingSince === null) this.notFlyingSince = at;
    if (why === "menu") {
      if (this.menuSince === null) this.menuSince = at;
      if (at - this.menuSince >= this.menuEndMs) return this.end(at, "menu");
    } else this.menuSince = null;
    if (at - this.notFlyingSince >= this.idleEndMs) this.end(at, "idle");
  }

  private setFlying(flying: boolean, reason: GateReason, at: number) {
    const changed = flying !== this.flying;
    this.reason = reason;
    this.flying = flying;
    if (changed && this.open) this.emit({ kind: "flying", at, flying, reason });
  }

  private end(at: number, reason: EndReason) {
    if (!this.open) return;
    this.setFlying(false, reason === "menu" ? "menu" : "settling", at);
    this.open = false;
    this.flying = false;
    this.lastGood = null;
    this.notFlyingSince = null;
    this.menuSince = null;
    this.emit({ kind: "end", at, reason });
  }
}
