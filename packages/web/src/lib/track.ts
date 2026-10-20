import type { SimStatus, TelemetryFrame } from "@vbuddy/protocol";
import { apiFetch } from "./api";

/** One point of your own track: [lat, lon, time ms]. */
export type TrackPoint = [number, number, number];

const MAX_POINTS = 20_000;
const MIN_STEP_DEG = 0.0004; // ~40 m: closer points add nothing to a line on a map
const MIN_STEP_MS = 15_000; // ...but keep at least one every 15 s (holding, taxiing)

type FlightInfo = NonNullable<SimStatus["flight"]>;

/**
 * Your track for the flight in progress, kept outside React so it survives tab switches.
 *
 * The bridge says which flight is being recorded and from when the trail counts (once the aircraft has spawned
 * and, with vPilot linked, you're connected to VATSIM). Frames before that, in the menu, while loading or during
 * a replay aren't drawn. A new flight starts a new line. On first use the flight's saved track is loaded from the
 * bridge so a page reload doesn't lose the line. An older bridge that doesn't say draws everything since it started.
 */
class TrackStore {
  private pts: TrackPoint[] = [];
  private session: string | null = null;
  private listeners = new Set<(added: TrackPoint[], reset: boolean) => void>();
  private historyFor: string | null = null;
  /** undefined = the bridge doesn't report flights (older version); null = no flight right now. */
  private flight: FlightInfo | null | undefined = undefined;
  private flying: boolean | null = null;

  points() {
    return this.pts;
  }
  subscribe(fn: (added: TrackPoint[], reset: boolean) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(added: TrackPoint[], reset: boolean) {
    for (const l of this.listeners) l(added, reset);
  }
  private clear() {
    if (!this.pts.length) return;
    this.pts = [];
    this.emit([], true);
  }

  setSession(id: string | null) {
    if (id === this.session) return;
    this.session = id;
    this.historyFor = null;
    this.clear();
  }

  /** What the bridge says about the flight (from its sim status). */
  setFlight(f: FlightInfo | null | undefined, inFlight: boolean | null) {
    this.flying = inFlight;
    const was = this.flight;
    this.flight = f;
    if (f === undefined) return; // older bridge
    const key = (x: FlightInfo | null | undefined) => (x ? `${x.id}:${x.startedAt}` : "none");
    if (key(was) !== key(f)) {
      this.historyFor = null;
      this.clear();
    }
    // The trail start moved (connected to VATSIM later): drop what's before it.
    if (f && f.trackSince !== null && this.pts.length && this.pts[0]![2] < f.trackSince) {
      this.pts = this.pts.filter((p) => p[2] >= f.trackSince!);
      this.emit([], true);
    }
    if (f && f.id !== null && f.trackSince !== null) void this.loadHistory(f.id, f.trackSince);
  }

  private accepts(f: TelemetryFrame): boolean {
    if (this.flight === undefined) return true;
    if (!this.flight || this.flight.trackSince === null || this.flying === false) return false;
    return f.ts >= this.flight.trackSince;
  }

  addFrames = (frames: TelemetryFrame[]) => {
    const added: TrackPoint[] = [];
    for (const f of frames) {
      if (!this.accepts(f)) continue;
      const last = this.pts[this.pts.length - 1];
      if (last && f.ts <= last[2]) continue;
      if (last && Math.abs(f.data.lat - last[0]) < MIN_STEP_DEG && Math.abs(f.data.lon - last[1]) < MIN_STEP_DEG && f.ts - last[2] < MIN_STEP_MS) continue;
      const p: TrackPoint = [f.data.lat, f.data.lon, f.ts];
      this.pts.push(p);
      added.push(p);
    }
    if (this.pts.length > MAX_POINTS) {
      this.pts = this.pts.filter((_, i) => i % 2 === 0 || i === this.pts.length - 1);
      this.emit([], true);
    } else if (added.length) this.emit(added, false);
  };

  /** Prepends the flight's saved track from the bridge (once per flight), from the trail start on. */
  private async loadHistory(flightId: number, since: number) {
    const key = `${flightId}:${since}`;
    if (this.historyFor === key) return;
    this.historyFor = key;
    try {
      const body = (await (await apiFetch(`/api/flights/${flightId}/track?max=4000`)).json()) as { points: number[][] };
      if (this.historyFor !== key) return;
      const first = this.pts[0]?.[2] ?? Infinity;
      const older = body.points.filter((p) => p[0]! >= since && p[0]! < first).map((p): TrackPoint => [p[1]!, p[2]!, p[0]!]);
      if (!older.length) return;
      this.pts = [...older, ...this.pts];
      this.emit([], true);
    } catch {
      /* no flight log (mock without --data-dir, or offline): the live track still builds */
    }
  }

  /** Older bridges: prepends the newest flight's track from this bridge run. */
  async loadSessionHistory(sessionId: string) {
    if (this.flight !== undefined || this.historyFor === sessionId) return;
    this.historyFor = sessionId;
    try {
      const flights = (await (await apiFetch("/api/flights?limit=1")).json()) as Array<{ id: number; sessionId: string }>;
      const f = flights[0];
      if (!f || f.sessionId !== sessionId) return;
      const body = (await (await apiFetch(`/api/flights/${f.id}/track?max=4000`)).json()) as { points: number[][] };
      if (this.session !== sessionId) return;
      const first = this.pts[0]?.[2] ?? Infinity;
      const older = body.points.filter((p) => p[0]! < first).map((p): TrackPoint => [p[1]!, p[2]!, p[0]!]);
      if (!older.length) return;
      this.pts = [...older, ...this.pts];
      this.emit([], true);
    } catch {
      /* the live track still builds */
    }
  }
}

export const track = new TrackStore();
