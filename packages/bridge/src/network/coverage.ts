import { UNICOM_FREQ, type AtcAlert, type AtcPosition, type AtcStation } from "@vbuddy/protocol";
import { randomUUID } from "node:crypto";
import type { PlacedStation } from "./atc.js";
import { areaSize, destination, distNm, inArea } from "./geo.js";

export interface OwnPosition {
  lat: number;
  lon: number;
  altMsl: number;
  altAgl: number;
  onGround: boolean;
  gs: number;
  track: number;
}

/** Below this, an approach unit is assumed to own the airspace inside its area. */
export const APP_CEILING_FT = 18_000;
/** A tower without a published shape covers this far round its airport, below TWR_CEILING_AGL. */
export const TWR_RADIUS_NM = 8;
export const TWR_CEILING_AGL = 3_000;
const GND_RADIUS_NM = 4;

const near = (s: AtcStation, p: OwnPosition, nm: number) => s.lat !== null && s.lon !== null && distNm(s.lat, s.lon, p.lat, p.lon) <= nm;

/**
 * The station you should be talking to: the lowest online unit whose airspace you
 * are in. On VATSIM, a controller covers every position below theirs that is
 * offline, so if there is no tower the approach controller covers the airport, and so on.
 */
export function covering(stations: PlacedStation[], p: OwnPosition): AtcStation | null {
  const pick = (facility: string, test: (s: PlacedStation) => boolean) => {
    let best: PlacedStation | null = null;
    for (const s of stations) {
      if (s.station.facility !== facility || !test(s)) continue;
      // More than one match (a whole-FIR sector and a split sector): the smaller one is more specific.
      if (!best || (s.area && best.area && areaSize(s.area) < areaSize(best.area))) best = s;
    }
    return best?.station ?? null;
  };
  const inside = (s: PlacedStation) => !!s.area && inArea(s.area, p.lat, p.lon);
  const twr = (s: PlacedStation) => (p.onGround || p.altAgl < TWR_CEILING_AGL) && (s.area ? inside(s) : near(s.station, p, TWR_RADIUS_NM));
  const app = (s: PlacedStation) => p.altMsl < APP_CEILING_FT && inside(s);
  const gnd = (s: PlacedStation) => p.onGround && near(s.station, p, GND_RADIUS_NM);

  const order: Array<[string, (s: PlacedStation) => boolean]> = p.onGround
    ? [["gnd", gnd], ["twr", twr], ["del", gnd], ["app", app], ["ctr", inside], ["fss", inside]]
    : [["twr", twr], ["app", app], ["ctr", inside], ["fss", inside]];
  for (const [f, test] of order) {
    const s = pick(f, test);
    if (s) return s;
  }
  return null;
}

const keyOf = (s: AtcStation | null) => (s ? s.callsign : "UNICOM");
const REANNOUNCE_MS = 10 * 60_000;

export interface WatcherOptions {
  /** A change must hold this long before it counts (avoids flapping on a boundary). */
  stableMs?: number;
  /** How far ahead (seconds) to look along the track for the next boundary. */
  lookAheadSec?: number;
  /** An "ahead" alert is raised once the boundary is this close (seconds); the look-ahead can be longer. */
  alertAheadSec?: number;
  stepSec?: number;
}

/**
 * Turns positions and the online station list into "who covers you now", "what's
 * next on your track" and alerts when either needs action.
 */
export class AtcWatcher {
  private confirmed: string | null = null; // key of the confirmed current station
  private candidate: { key: string; since: number } | null = null;
  /** Last "ahead" announcement, so a wobble near a boundary doesn't repeat it (allowed again after REANNOUNCE_MS). */
  private aheadAlerted: { key: string; at: number } | null = null;
  private lastSent: AtcPosition = { current: null, ahead: null };
  private stableMs: number;
  private lookAheadSec: number;
  private alertAheadSec: number;
  private stepSec: number;

  constructor(opts: WatcherOptions = {}) {
    this.stableMs = opts.stableMs ?? 5_000;
    this.lookAheadSec = opts.lookAheadSec ?? 1200;
    this.alertAheadSec = opts.alertAheadSec ?? Math.min(600, opts.lookAheadSec ?? 600);
    this.stepSec = opts.stepSec ?? 20;
  }

  reset() {
    this.confirmed = null;
    this.candidate = null;
    this.aheadAlerted = null;
    this.lastSent = { current: null, ahead: null };
  }

  position() {
    return this.lastSent;
  }

  /** Where the track first leaves the current station's coverage, within the look-ahead window. */
  private ahead(stations: PlacedStation[], p: OwnPosition, current: AtcStation | null): AtcPosition["ahead"] {
    if (p.onGround || p.gs < 60) return null;
    const curKey = keyOf(current);
    for (let t = this.stepSec; t <= this.lookAheadSec; t += this.stepSec) {
      const d = (p.gs * t) / 3600;
      const [lat, lon] = destination(p.lat, p.lon, p.track, d);
      const s = covering(stations, { ...p, lat, lon });
      if (keyOf(s) !== curKey) return { station: s, etaSec: t, distNm: Math.round(d) };
    }
    return null;
  }

  /**
   * @returns position: set when it changed enough to be worth sending; alerts: things to tell the pilot.
   */
  update(stations: PlacedStation[], p: OwnPosition | null, now: number): { position: AtcPosition | null; alerts: AtcAlert[] } {
    const alerts: AtcAlert[] = [];
    if (!p) {
      const had = this.lastSent.current || this.lastSent.ahead;
      this.reset();
      return { position: had ? this.lastSent : null, alerts };
    }

    const cur = covering(stations, p);
    const key = keyOf(cur);
    if (this.confirmed === null) {
      // First fix: take it as is, no alert (you already know who you're talking to).
      this.confirmed = key;
      this.candidate = null;
    } else if (key !== this.confirmed) {
      if (!this.candidate || this.candidate.key !== key) this.candidate = { key, since: now };
      if (now - this.candidate.since >= this.stableMs) {
        this.confirmed = key;
        this.candidate = null;
        alerts.push(
          cur
            ? { id: randomUUID(), kind: "contact", station: cur, text: `Contact ${cur.name} on ${cur.freq} (${cur.callsign}).` }
            : { id: randomUUID(), kind: "unicom", station: null, text: `No ATC here now. Monitor UNICOM ${UNICOM_FREQ}.` },
        );
        this.aheadAlerted = null; // arrived: the next boundary gets its own announcement
      }
    } else this.candidate = null;

    // The confirmed station is what we report; a not-yet-stable change keeps the old one for a few seconds.
    const shown = this.confirmed === key ? cur : (stations.find((s) => s.station.callsign === this.confirmed)?.station ?? null);
    // Look ahead from where you really are, so a change still settling isn't announced as "ahead".
    const ahead = this.ahead(stations, p, cur);
    if (ahead && ahead.etaSec <= this.alertAheadSec) {
      const aKey = keyOf(ahead.station);
      if (!this.aheadAlerted || this.aheadAlerted.key !== aKey || now - this.aheadAlerted.at > REANNOUNCE_MS) {
        this.aheadAlerted = { key: aKey, at: now };
        const mins = Math.max(1, Math.round(ahead.etaSec / 60));
        alerts.push({
          id: randomUUID(),
          kind: "ahead",
          station: ahead.station,
          etaSec: ahead.etaSec,
          text: ahead.station
            ? `${ahead.station.name} in about ${mins} min: ${ahead.station.freq} (${ahead.station.callsign}).`
            : `Leaving ATC coverage in about ${mins} min. Then UNICOM ${UNICOM_FREQ}.`,
        });
      }
    }

    const next: AtcPosition = { current: shown, ahead };
    const prev = this.lastSent;
    const changed =
      keyOf(prev.current) !== keyOf(next.current) ||
      !!prev.ahead !== !!next.ahead ||
      (prev.ahead && next.ahead && (keyOf(prev.ahead.station) !== keyOf(next.ahead.station) || Math.abs(prev.ahead.etaSec - next.ahead.etaSec) >= 60)) ||
      JSON.stringify(prev.current) !== JSON.stringify(next.current);
    if (changed) this.lastSent = next;
    return { position: changed ? next : null, alerts };
  }
}
