import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalFrame, mockGroundChart, type Telemetry } from "@vbuddy/protocol";
import { logger } from "../log.js";
import { sampleTelemetry } from "../test-helpers.js";
import { TaxiGuideService, type TaxiNotice } from "./guide.js";
import { CommsService } from "../comms/service.js";
import { MockRadios } from "../comms/mock-radios.js";

const chart = mockGroundChart("VBDY");
const f = new LocalFrame(chart.lat, chart.lon);
const at = (x: number, y: number, extra: Partial<Telemetry> = {}): Telemetry => {
  const [lat, lon] = f.ll(x, y);
  return { ...sampleTelemetry(), lat, lon, onGround: true, altAgl: 0, gs: 12, hdgTrue: 0, ...extra };
};

function setup() {
  let clock = 1_000_000;
  const guide = new TaxiGuideService({ get: async () => ({ chart }) }, () => "VBDY", logger("test"), () => clock);
  const notices: TaxiNotice[] = [];
  guide.onNotice((n) => notices.push(n));
  const tick = (t: Telemetry) => {
    clock += 1100;
    guide.sample(t);
  };
  return { guide, notices, tick };
}

test("a taxi clearance heard on the ground becomes the route, and the pilot is told", async () => {
  const { guide, notices, tick } = setup();
  tick(at(600, -950, { gs: 0 })); // at gate G6
  const said = await guide.clearance("Speedbird one two three, taxi to holding point runway two seven right via Bravo, Charlie two, Alpha, November three", "EGLL_GND");
  assert.ok(said);
  const g = guide.guide()!;
  assert.equal(g.source, "atc");
  assert.equal(g.from, "EGLL_GND");
  assert.ok(g.plan.via.includes("A") && g.plan.via.includes("N3"), g.plan.via.join(","));
  assert.equal(g.plan.runway, "27R");
  assert.equal(notices[0]!.title, "Taxi route ready");
  // Not a clearance, or in the air: nothing.
  assert.equal(await guide.clearance("climb flight level three five zero", "EGTT_CTR"), null);
});

test("progressive guidance: the turn, the crossing and the holding point are each announced once, ahead of time", async () => {
  const { guide, notices, tick } = setup();
  tick(at(600, -950, { gs: 0 }));
  await guide.request({ op: "plan", icao: "VBDY", to: { kind: "runway", runway: "27R" }, via: ["B", "C2", "A", "N3"] });
  notices.length = 0;
  // Up C2 towards the southern runway.
  tick(at(600, -780));
  tick(at(600, -760));
  assert.ok(notices.some((n) => n.title === "Hold short of runway 09R/27L"), JSON.stringify(notices));
  const before = notices.length;
  tick(at(600, -750));
  assert.equal(notices.length, before, "said once");
  // Along A, the turn onto N3 is coming.
  tick(at(1380, -300, { hdgTrue: 90 }));
  assert.ok(notices.some((n) => /onto N3/.test(n.title)), JSON.stringify(notices.map((n) => n.title)));
  // On N3, short of 27R.
  tick(at(1500, -200));
  assert.ok(notices.some((n) => n.title === "Holding point ahead"));
  assert.ok(guide.guide()!.progress!.remainingM < 150);
  // Wheels up: done.
  tick(at(1500, 0, { onGround: false, altAgl: 200 }));
  assert.equal(guide.guide(), null);
});

test("leaving the route for a while plans it again from where you are", async () => {
  const { guide, notices, tick } = setup();
  tick(at(600, -950, { gs: 0 }));
  await guide.request({ op: "plan", icao: "VBDY", to: { kind: "runway", runway: "27R" }, via: [] });
  const first = guide.guide()!.setAt;
  for (let i = 0; i < 10; i++) tick(at(-900, -300));
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(notices.some((n) => n.title === "Taxi route updated"));
  assert.notEqual(guide.guide()!.setAt, first);
});

test("only clearances for you: a call to another aircraft doesn't change your route", async () => {
  const { guide, tick } = setup();
  const comms = new CommsService(new MockRadios(), logger("test"));
  comms.setExtras(() => ({}), () => "BAW123");
  tick(at(600, -950, { gs: 0 }));
  let heard = 0;
  comms.onChat((m) => {
    if (m.dir === "in" && m.kind === "radio" && (m.attention || !comms.myCallsign())) {
      heard++;
      void guide.clearance(m.text, m.from);
    }
  });
  comms.addExternal({ source: "voice", text: "Emirates five, taxi to holding point runway 27R via A", from: "GND" });
  assert.equal(heard, 0);
  comms.addExternal({ source: "voice", text: "Speedbird 123, taxi to holding point runway 27R via A", from: "GND" });
  assert.equal(heard, 1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(guide.guide()?.plan.runway, "27R");
});
