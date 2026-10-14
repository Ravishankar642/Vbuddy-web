import type { TelemetryFrame } from "@vbuddy/protocol";
import { apiFetch } from "./api";

/** One point of your own track: [lat, lon, time ms]. */
export type TrackPoint = [number, number, number];

const MAX_POINTS = 20_000;
const MIN_STEP_DEG = 0.0004; // ~40 m: closer points add nothing to a line on a map
const MIN_STEP_MS = 15_000; // ...but keep at least one every 15 s (holding, taxiing)

/**
 * Your track for the current bridge run, kept outside React so it survives tab
 * switches. Filled from the live/replayed frame stream and, on first use, from
 * the bridge's flight log so a page reload doesn't lose the line.
 */
class TrackStore {
  private pts: TrackPoint[] = [];
  private session: string | null = null;
  private listeners = new Set<(added: TrackPoint[], reset: boolean) => void>();
  private historyFor: string | null = null;

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

  setSession(id: string | null) {
    if (id === this.session) return;
    this.session = id;
    this.pts = [];
    this.emit([], true);
  }

  addFrames = (frames: TelemetryFrame[]) => {
    const added: TrackPoint[] = [];
    for (const f of frames) {
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

  /** Prepends the current flight's saved track from the bridge (once per bridge run). */
  async loadHistory(sessionId: string) {
    if (this.historyFor === sessionId) return;
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
      /* no flight log (mock without --data-dir, or offline): the live track still builds */
    }
  }
}

export const track = new TrackStore();
