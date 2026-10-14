import { type AtcAlert, type AtcPosition, type AtcStation, type NetPilot, type NetworkStatus, type Telemetry } from "@vbuddy/protocol";
import type { Logger } from "../log.js";
import { placeStations, type PlacedStation } from "./atc.js";
import { AtcWatcher, type OwnPosition } from "./coverage.js";
import type { Area } from "./geo.js";
import type { SectorData } from "./sectors.js";
import { detectSelf, filterTraffic } from "./traffic.js";
import type { FeedSnapshot, FeedState, VatsimFeed } from "./vatsim-feed.js";

export interface TrafficArea {
  lat: number;
  lon: number;
  radiusNm: number;
}

/** Traffic around your aircraft when a client hasn't said where its map is. */
export const DEFAULT_RADIUS_NM = 250;
const EVAL_MS = 2_000;

export interface TrafficView {
  network: "vatsim";
  updatedAt: number;
  you: string | null;
  pilots: NetPilot[];
}

/** What the server needs from the network side. */
export interface NetworkHub {
  status(): NetworkStatus;
  stations(): AtcStation[];
  position(): AtcPosition;
  traffic(area: TrafficArea | null): TrafficView | null;
  /** GeoJSON FeatureCollection with the requested online sectors' shapes. */
  boundaries(ids: string[]): unknown;
  /** New feed data or status. */
  onUpdate(cb: () => void): void;
  onPosition(cb: (p: AtcPosition) => void): void;
  onAlert(cb: (a: AtcAlert) => void): void;
}

/**
 * Glues the VATSIM feed, sector data and your aircraft together: online
 * stations with their areas, per-client traffic, who covers you, and alerts.
 */
export class NetworkService implements NetworkHub {
  private feedState: FeedState = { state: "loading" };
  private snap: FeedSnapshot | null = null;
  private placed: PlacedStation[] = [];
  private areas = new Map<string, Area>();
  private stationList: AtcStation[] = [];
  private own: (OwnPosition & { vs: number }) | null = null;
  private you: string | null = null;
  private watcher = new AtcWatcher();
  private timer: NodeJS.Timeout | null = null;
  private updateCbs: Array<() => void> = [];
  private posCbs: Array<(p: AtcPosition) => void> = [];
  private alertCbs: Array<(a: AtcAlert) => void> = [];

  constructor(
    private feed: VatsimFeed,
    private sectors: SectorData | null,
    private log: Logger,
    private fixedCallsign: string | null = null,
  ) {
    feed.onData((s) => {
      this.snap = s;
      this.rebuild();
      this.evaluate();
      this.emitUpdate();
    });
    feed.onState((st) => {
      const changed = st.state !== this.feedState.state || st.detail !== this.feedState.detail;
      this.feedState = st;
      if (changed) this.emitUpdate();
    });
  }

  start() {
    this.feed.start();
    this.timer = setInterval(() => this.evaluate(), EVAL_MS);
    this.timer.unref();
  }
  stop() {
    this.feed.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sector data arrived later (first download) or was refreshed. */
  setSectors(s: SectorData | null) {
    this.sectors = s;
    this.rebuild();
    this.evaluate();
    this.emitUpdate();
  }

  /** Latest own-aircraft data, or null when the sim is gone. */
  setOwn(t: Telemetry | null) {
    this.own = t ? { lat: t.lat, lon: t.lon, altMsl: t.altMsl, altAgl: t.altAgl, onGround: t.onGround, gs: t.gs, track: t.track, vs: t.vs } : null;
    if (!t) this.evaluate();
  }

  private rebuild() {
    const { placed, areas } = placeStations(this.snap?.controllers ?? [], this.snap?.atis ?? [], this.sectors);
    this.placed = placed;
    this.areas = areas;
    this.stationList = placed.map((p) => p.station);
  }

  private emitUpdate() {
    for (const cb of this.updateCbs) cb();
  }

  /** Re-checks coverage for the current aircraft position. Exposed for tests. */
  evaluate(now = Date.now()) {
    if (this.own && this.snap) {
      const found = this.fixedCallsign ?? detectSelf(this.snap.pilots, this.own, this.you);
      if (found !== this.you) {
        if (found) this.log.info(`Found you on VATSIM as ${found}.`);
        this.you = found;
      }
    }
    const usable = this.snap && this.feedState.state !== "error" ? this.own : null;
    const { position, alerts } = this.watcher.update(this.placed, usable, now);
    if (position) for (const cb of this.posCbs) cb(position);
    for (const a of alerts) {
      this.log.info(`ATC: ${a.text}`);
      for (const cb of this.alertCbs) cb(a);
    }
  }

  status(): NetworkStatus {
    return {
      network: "vatsim",
      state: this.feedState.state,
      ...(this.feedState.detail ? { detail: this.feedState.detail } : {}),
      updatedAt: this.snap?.updatedAt ?? null,
      boundaries: !!this.sectors,
    };
  }
  stations() {
    return this.stationList;
  }
  position() {
    return this.watcher.position();
  }

  traffic(area: TrafficArea | null): TrafficView | null {
    if (!this.snap) return null;
    const a = area ?? (this.own ? { lat: this.own.lat, lon: this.own.lon, radiusNm: DEFAULT_RADIUS_NM } : null);
    return {
      network: "vatsim",
      updatedAt: this.snap.updatedAt,
      you: this.you,
      pilots: a ? filterTraffic(this.snap.pilots, a.lat, a.lon, a.radiusNm, this.you) : [],
    };
  }

  boundaries(ids: string[]) {
    const features = [];
    for (const id of ids) {
      const area = this.areas.get(id);
      if (!area) continue;
      features.push({ type: "Feature", properties: { id }, geometry: { type: "MultiPolygon", coordinates: area.polys } });
    }
    return { type: "FeatureCollection", features };
  }

  onUpdate(cb: () => void) {
    this.updateCbs.push(cb);
  }
  onPosition(cb: (p: AtcPosition) => void) {
    this.posCbs.push(cb);
  }
  onAlert(cb: (a: AtcAlert) => void) {
    this.alertCbs.push(cb);
  }
}

