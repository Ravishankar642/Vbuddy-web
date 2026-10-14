import { test } from "node:test";
import assert from "node:assert/strict";
import { LandingAnalyzer } from "./analyzer.js";
import { rateLanding } from "./rating.js";
import { flyLanding } from "./test-flight.js";
import { sampleTelemetry } from "../test-helpers.js";
import { LandingSchema } from "@vbuddy/protocol";

const mk = () => {
  let n = 0;
  return new LandingAnalyzer(() => ({ aircraftTitle: "Test A320", source: "simconnect" }), () => `id-${++n}`);
};
const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b} +/- ${tol}, got ${a}`);

test("smooth landing with the sim's touchdown latch", () => {
  const an = mk();
  const { landings } = flyLanding(an, { sink: 140, latch: "fresh", peakG: 1.12 });
  assert.equal(landings.length, 1);
  const l = landings[0]!;
  assert.equal(l.vsSource, "sim");
  assert.equal(l.vsFpm, -140);
  near(l.vsEstimateFpm!, -140, 25, "estimate");
  assert.equal(l.gPeak, 1.12);
  assert.equal(l.rating, "smooth");
  assert.equal(l.bounces, 0);
  assert.equal(l.touchAndGo, false);
  assert.equal(l.lowConfidence, false);
  assert.equal(l.aircraftTitle, "Test A320");
  // the record must satisfy the wire schema
  assert.ok(LandingSchema.safeParse(l).success);
});

test("latch sign doesn't matter", () => {
  const an = mk();
  an.onLanding(() => {});
  const { landings } = flyLanding(an, { sink: 220, latch: "fresh" });
  assert.equal(landings[0]!.vsFpm, -220);
});

test("no latch, or an unchanged (stale) latch, falls back to the estimate", () => {
  for (const latch of ["none", "stale"] as const) {
    const { landings } = flyLanding(mk(), { sink: 300, latch });
    const l = landings[0]!;
    assert.equal(l.vsSource, "estimated", latch);
    near(l.vsFpm, -300, 25, latch);
    assert.equal(l.vsFpm, l.vsEstimateFpm);
  }
});

test("latch that reaches the analyzer before the ground flag is still recognised", () => {
  const { landings } = flyLanding(mk(), { sink: 180, latch: "early" });
  assert.equal(landings[0]!.vsSource, "sim");
  assert.equal(landings[0]!.vsFpm, -180);
});

test("heights are relative to touchdown when the ground reads non-zero", () => {
  const { landings } = flyLanding(mk(), { sink: 150, latch: "fresh", groundOffset: 11 });
  assert.equal(landings.length, 1);
  const l = landings[0]!;
  const td = l.profile.find((p) => p.t === 0)!;
  near(td.agl, 0, 0.1, "agl at touchdown");
  // sink model is -(sink + 4h): at 50 ft that is -350
  near(l.flare.sinkAt50!, -350, 15, "sink at 50ft");
  near(l.flare.sinkAt30!, -270, 15, "sink at 30ft");
  near(l.flare.sinkAt10!, -190, 15, "sink at 10ft");
});

test("flare numbers: peak sink and how much it eased", () => {
  const { landings } = flyLanding(mk(), { sink: 150, latch: "fresh" });
  const f = landings[0]!.flare;
  assert.ok(f.peakSinkFpm! <= -400, `peak ${f.peakSinkFpm}`); // ~ -150 - 4*100 at the 100 ft edge
  assert.ok(f.peakSinkAtFt! >= 90 && f.peakSinkAtFt! <= 100);
  assert.ok(f.easedByFpm! > 200);
  near(f.pitchChange!, 0, 0.01, "constant pitch in this flight");
});

test("trace covers 20 s before to 3 s after, ordered, with touchdown at t=0", () => {
  const { landings } = flyLanding(mk(), { sink: 150, latch: "fresh", startHeightFt: 3000 });
  const p = landings[0]!.profile;
  assert.ok(p[0]!.t >= -20.05 && p[0]!.t <= -19.8, `starts at ${p[0]!.t}`);
  assert.ok(p[p.length - 1]!.t >= 2.8 && p[p.length - 1]!.t <= 3.05, `ends at ${p[p.length - 1]!.t}`);
  for (let i = 1; i < p.length; i++) assert.ok(p[i]!.t > p[i - 1]!.t);
  assert.ok(p.some((s) => s.t === 0 && s.onGround));
  assert.ok(p.length > 200 && p.length < 260, `~10 Hz, got ${p.length} points`);
  assert.ok(p.filter((s) => s.t < 0).every((s) => !s.onGround));
});

test("a bounce is counted once and the landing is one record", () => {
  const { landings } = flyLanding(mk(), { sink: 400, latch: "fresh", bounce: { heightFt: 5 }, peakG: 1.5 });
  assert.equal(landings.length, 1);
  const l = landings[0]!;
  assert.equal(l.bounces, 1);
  near(l.bounceMaxFt, 5, 0.5, "bounce height");
  assert.equal(l.touchAndGo, false);
  assert.equal(l.vsFpm, -400, "first contact decides the rate");
});

test("flying away right after touchdown is a touch-and-go, recorded once", () => {
  const an = mk();
  const { landings } = flyLanding(an, { sink: 200, latch: "fresh", goAround: true });
  assert.equal(landings.length, 1);
  assert.equal(landings[0]!.touchAndGo, true);
  // and a later, separate landing is its own record
  const second = flyLanding(an, { sink: 120, latch: "fresh" }, 2_000_000).landings;
  assert.equal(second.length, 1);
  assert.equal(second[0]!.touchAndGo, false);
  assert.equal(second[0]!.id, "id-2");
});

test("ground jitter and short hops are not landings", () => {
  const an = mk();
  const got: unknown[] = [];
  an.onLanding((l) => got.push(l));
  let at = 0;
  // taxiing: flag flickers, never airborne long or high
  for (let i = 0; i < 600; i++, at += 16) an.ingest(sampleTelemetry({ onGround: i % 50 < 2 ? false : true, altAgl: 0 }), at);
  // a 1 s hop to 5 ft (below the 3 s / 15 ft bar)
  for (let i = 0; i < 60; i++, at += 16) an.ingest(sampleTelemetry({ onGround: false, altAgl: i < 30 ? i / 6 : (60 - i) / 6 }), at);
  for (let i = 0; i < 300; i++, at += 16) an.ingest(sampleTelemetry({ onGround: true, altAgl: 0 }), at);
  assert.equal(got.length, 0);
});

test("sparse data at touchdown is flagged low confidence", () => {
  const { landings } = flyLanding(mk(), { sink: 200, latch: "none", gapMs: 600 });
  assert.equal(landings[0]!.lowConfidence, true);
  const slow = flyLanding(mk(), { sink: 200, latch: "none", hz: 4 }).landings[0]!;
  assert.equal(slow.lowConfidence, true, "4 Hz is too sparse for a 400 ms window");
});

test("an open landing is finished by flush() when samples stop, and not before", () => {
  const an = mk();
  const r = flyLanding(an, { sink: 250, latch: "fresh", stopAtContact: true });
  assert.equal(r.landings.length, 0);
  assert.ok(an.busy);
  an.flush(r.endAt + 1000);
  assert.equal(r.landings.length, 0, "not stalled yet");
  an.flush(r.endAt + 3500);
  assert.equal(r.landings.length, 1);
  assert.equal(an.busy, false);
});

test("reset() (sim went away) finishes an open landing and forgets the past", () => {
  const an = mk();
  const r = flyLanding(an, { sink: 250, latch: "fresh", stopAtContact: true });
  an.reset();
  assert.equal(r.landings.length, 1);
  // after the reset a ground sample alone can't start a landing
  an.ingest(sampleTelemetry({ onGround: true }), 9_999_999);
  assert.equal(r.landings.length, 1);
});

test("wind components relative to the landing heading", () => {
  // heading 270, wind from 300 at 8 kt: 30 deg off the nose, from the right
  const { landings } = flyLanding(mk(), { sink: 150, latch: "fresh", hdg: 270, wind: { kt: 8, from: 300 } });
  const w = landings[0]!.wind!;
  near(w.headwindKt, 6.9, 0.1);
  near(w.crosswindKt, 4.0, 0.1);
  assert.equal(w.fromDeg, 300);
  // tailwind from behind-left: heading 270, wind from 100 at 10 kt
  const t = flyLanding(mk(), { sink: 150, latch: "fresh", hdg: 270, wind: { kt: 10, from: 100 } }).landings[0]!.wind!;
  assert.ok(t.headwindKt < 0, "tailwind is negative");
  assert.ok(t.crosswindKt < 0, "from the left is negative");
  assert.equal(flyLanding(mk(), { sink: 150, latch: "fresh" }).landings[0]!.wind, null);
});

test("G peak comes from the window around touchdown", () => {
  const { landings } = flyLanding(mk(), { sink: 400, latch: "fresh", peakG: 1.9 });
  assert.equal(landings[0]!.gPeak, 1.9);
  assert.equal(landings[0]!.rating, "hard");
  assert.equal(landings[0]!.ratedBy, "g", "1.9 g is worse than 400 fpm (firm), so G decides");
});

test("rating bands and tie-breaking", () => {
  const cases: Array<[number, number, string, string]> = [
    [-60, 1.05, "butter", "vs"],
    [-100, 1.2, "butter", "vs"],
    [-101, 1.1, "smooth", "vs"],
    [-250, 1.3, "normal", "vs"],
    [-400, 1.3, "firm", "vs"],
    [-550, 1.3, "hard", "vs"],
    [-700, 1.3, "severe", "vs"],
    [-120, 1.7, "firm", "g"],
    [-120, 2.5, "severe", "g"],
    [-300, 1.6, "normal", "vs"],
  ];
  for (const [vs, g, rating, by] of cases) assert.deepEqual(rateLanding(vs, g), { rating, ratedBy: by }, `${vs} fpm, ${g} g`);
});

test("analyzer ignores out-of-order timestamps without crashing", () => {
  const an = mk();
  const r = flyLanding(an, { sink: 150, latch: "fresh", stopAtContact: true });
  an.ingest(sampleTelemetry({ onGround: true }), r.tdAt - 5000); // clock went backwards
  an.flush(r.endAt + 4000);
  assert.equal(r.landings.length, 1);
});

/** Feed samples at 10 Hz from `from` for `ms`, each built by `mkT(i)`. */
const feed = (an: LandingAnalyzer, from: number, ms: number, mkT: (i: number) => ReturnType<typeof sampleTelemetry>) => {
  for (let i = 0; i * 100 <= ms; i++) an.ingest(mkT(i), from + i * 100);
  return from + ms;
};

test("spawning: a few seconds of 'airborne' then on the ground is not a landing", () => {
  const an = mk();
  const landings: unknown[] = [];
  an.onLanding((l) => landings.push(l));
  // normal parked aircraft
  let t = feed(an, 0, 2_000, () => sampleTelemetry({ onGround: true, altAgl: 0, gs: 0, ias: 0 }));
  // the sim loads a new aircraft: it reads airborne and high for 6 s while the position is placed, then on the ground, still moving at 60 kt
  an.spawn();
  t = feed(an, t + 100, 6_000, () => sampleTelemetry({ onGround: false, altAgl: 120, gs: 60 }));
  feed(an, t + 100, 5_000, () => sampleTelemetry({ onGround: true, altAgl: 0, gs: 60 }));
  assert.equal(landings.length, 0);
});

test("a position jump (teleport) is not a landing", () => {
  const an = mk();
  const landings: unknown[] = [];
  an.onLanding((l) => landings.push(l));
  let t = feed(an, 0, 10_000, () => sampleTelemetry({ onGround: false, altAgl: 500, gs: 140, lat: 1 }));
  t = feed(an, t + 100, 3_000, () => sampleTelemetry({ onGround: false, altAgl: 500, gs: 140, lat: 5 }));
  feed(an, t + 100, 4_000, () => sampleTelemetry({ onGround: true, altAgl: 0, gs: 140, lat: 5 }));
  assert.equal(landings.length, 0);
});

test("slow 'flights' (taxi, tow, pushback hops) are not landings", () => {
  const an = mk();
  const landings: unknown[] = [];
  an.onLanding((l) => landings.push(l));
  const t = feed(an, 0, 6_000, () => sampleTelemetry({ onGround: false, altAgl: 40, gs: 5 }));
  feed(an, t + 100, 4_000, () => sampleTelemetry({ onGround: true, altAgl: 0, gs: 5 }));
  assert.equal(landings.length, 0);
});

test("a real approach after a spawn still counts once the quiet period is over", () => {
  const an = mk();
  an.spawn();
  const { landings } = flyLanding(an, { sink: 200, latch: "fresh", startHeightFt: 3000 });
  assert.equal(landings.length, 1);
});
