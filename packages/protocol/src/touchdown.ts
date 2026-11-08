import { LocalFrame, type GroundChart } from "./ground.js";

/** Where on the runway a touchdown was. */
export interface RunwayTouchdown {
  /** Runway end landed on ("27R"). */
  runway: string;
  /** From the landing threshold along the centreline, m (negative = short of it). */
  fromThresholdM: number;
  /** Off the centreline, m: + right of it, looking down the runway. */
  offsetM: number;
  /** Runway left ahead, m. */
  remainingM: number;
  lengthM: number;
  widthM: number;
  /** For drawing: the threshold and far end in the frame (metres east/north of the threshold). */
  frame: LocalFrame;
  far: [number, number];
}

const rad = Math.PI / 180;

/**
 * Which runway end a touchdown at lat/lon on heading `hdgTrue` was on, and where on it. The runway whose direction is
 * within 30° of the heading and whose centreline is nearest (within the runway's width plus 60 m); null otherwise.
 */
export function touchdownOnRunway(runways: GroundChart["runways"], lat: number, lon: number, hdgTrue: number): RunwayTouchdown | null {
  let best: RunwayTouchdown | null = null;
  for (const r of runways) {
    for (const k of [0, 1] as const) {
      const thr = r.ends[k];
      const end = r.ends[k === 0 ? 1 : 0];
      const f = new LocalFrame(thr.lat, thr.lon);
      const far = f.xy(end.lat, end.lon);
      const len = Math.hypot(far[0], far[1]);
      if (len < 100) continue;
      const dir = Math.atan2(far[0], far[1]) / rad; // true course down the runway
      const dh = Math.abs(((hdgTrue - dir + 540) % 360) - 180);
      if (dh > 30) continue;
      const [px, py] = f.xy(lat, lon);
      const ux = far[0] / len;
      const uy = far[1] / len;
      const along = px * ux + py * uy;
      const right = px * uy - py * ux; // + to the right of the direction of travel
      if (along < -500 || along > len + 300 || Math.abs(right) > r.widthM / 2 + 60) continue;
      if (best && Math.abs(right) >= Math.abs(best.offsetM)) continue;
      best = { runway: thr.id, fromThresholdM: Math.round(along), offsetM: Math.round(right * 10) / 10, remainingM: Math.round(len - along), lengthM: Math.round(len), widthM: r.widthM, frame: f, far };
    }
  }
  return best;
}
