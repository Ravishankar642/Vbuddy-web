import type { Landing, Telemetry } from "@vbuddy/protocol";
import { sampleTelemetry } from "../test-helpers.js";
import { EMPTY_EXTRAS, type SimExtras } from "../sim/source.js";
import type { LandingAnalyzer } from "./analyzer.js";

export interface FlightOpts {
  /** Descent rate at touchdown, fpm, positive number. */
  sink: number;
  hz?: number;
  /** "fresh" = latch updates just after first contact; "early" = it reaches the analyzer a frame before the ground flag; "none" = never; "stale" = unchanged. */
  latch?: "fresh" | "early" | "none" | "stale";
  /** What "altitude above ground" reads when the wheels are on the runway. */
  groundOffset?: number;
  bounce?: { heightFt: number };
  goAround?: boolean;
  peakG?: number;
  hdg?: number;
  wind?: { kt: number; from: number };
  startHeightFt?: number;
  /** Silence between the last airborne sample and the first on-ground one. */
  gapMs?: number;
  /** How long to keep sending on-ground samples after contact. */
  tailMs?: number;
  /** Stop sending right after the first on-ground sample. */
  stopAtContact?: boolean;
}

export interface FlightResult {
  landings: Landing[];
  /** Time of the last sample sent. */
  endAt: number;
  /** Time of first contact. */
  tdAt: number;
}

/** Feeds the analyzer a synthetic approach, touchdown and rollout. */
export function flyLanding(an: LandingAnalyzer, o: FlightOpts, t0 = 1_000_000): FlightResult {
  const hz = o.hz ?? 60;
  const dt = 1000 / hz;
  const off = o.groundOffset ?? 0;
  const landings: Landing[] = [];
  an.onLanding((l) => landings.push(l));

  const newLatch = -o.sink / 60;
  const extras = (latch: number | null): SimExtras => ({
    ...EMPTY_EXTRAS,
    touchdownNormalVelFps: latch,
    windKt: o.wind?.kt ?? null,
    windFromDeg: o.wind?.from ?? null,
  });
  an.setExtras(extras(o.latch === "stale" ? -2.5 : o.latch === "none" ? null : -1.1));

  let at = t0;
  const emit = (over: Partial<Telemetry>) => {
    an.ingest(sampleTelemetry({ hdgTrue: o.hdg ?? 270, ias: 138, gs: 135, pitch: 3, ...over }), at);
    at += dt;
  };

  // approach: sink rate eases with height, like the mock flight does
  let h = o.startHeightFt ?? 400;
  while (h > 0) {
    const vs = -(o.sink + 4 * h);
    const nextH = h + (vs / 60) * (dt / 1000);
    if (nextH <= 0 && o.latch === "early") an.setExtras(extras(newLatch));
    emit({ onGround: false, altAgl: h + off, vs });
    h = nextH;
  }
  if (o.gapMs) at += o.gapMs;

  const tdAt = at;
  emit({ onGround: true, altAgl: off, vs: 0, gForce: o.peakG ?? 1.15 });
  if (o.latch === "fresh") an.setExtras(extras(newLatch));
  if (o.stopAtContact) return { landings, endAt: at - dt, tdAt };

  let tAfter = 0;
  const ground = (ms: number) => {
    for (const end = tAfter + ms; tAfter < end; tAfter += dt) emit({ onGround: true, altAgl: off, vs: 0, gForce: tAfter < 150 ? 1.1 : 1.0 });
  };

  if (o.goAround) {
    ground(400);
    for (let ms = 0; ms < 10_000; ms += dt, tAfter += dt) emit({ onGround: false, altAgl: off + (ms / 1000) * 25, vs: 1500, pitch: 12 });
    return { landings, endAt: at - dt, tdAt };
  }
  if (o.bounce) {
    ground(150);
    const hopMs = 1000;
    for (let ms = 0; ms < hopMs; ms += dt, tAfter += dt) {
      const x = ms / hopMs;
      emit({ onGround: false, altAgl: off + 4 * x * (1 - x) * o.bounce.heightFt, vs: 200, gForce: 0.95 });
    }
    emit({ onGround: true, altAgl: off, vs: 0, gForce: 1.05 });
  }
  ground(o.tailMs ?? 6000);
  return { landings, endAt: at - dt, tdAt };
}
