import { test } from "node:test";
import assert from "node:assert/strict";
import { healthItems, redactLog, type HealthInput } from "./health.js";

const OK: HealthInput = {
  version: "2.2.0",
  sim: { connected: true, aircraft: "FenixA320" },
  vpilot: { linked: true, installed: true },
  voice: { state: "listening", message: null, model: "large-v3-turbo" },
  relay: { available: true, enabled: true, state: "connected", error: "" },
  simbrief: { set: true, plan: { dep: "WAAA", arr: "WADL", matched: true }, error: null },
  network: { network: "vatsim", state: "ok" },
  update: { kind: "current", latest: null },
  perf: { lite: false, background: false, landing: false },
};

test("health: all green when everything works; a fix for each problem", () => {
  assert.ok(healthItems(OK).every((i) => i.state === "ok"));
  const bad = healthItems({ ...OK, sim: { connected: false, aircraft: null }, vpilot: { linked: false, installed: false }, simbrief: { set: false, plan: null, error: null }, update: { kind: "ready", latest: "2.2.1" } });
  const by = Object.fromEntries(bad.map((i) => [i.id, i]));
  assert.equal(by.sim!.state, "bad");
  assert.match(by.vpilot!.fix!, /Install/);
  assert.match(by.simbrief!.fix!, /SimBrief name/);
  assert.match(by.update!.text, /2\.2\.1 is ready/);
});

test("diagnostics: pairing codes, relay links and tokens are hidden", () => {
  assert.equal(redactLog("Pairing code for a new device: 128869 (valid 10 min)"), "Pairing code for a new device: •••••• (valid 10 min)");
  assert.equal(redactLog("Phone link: https://vbuddy.duckdns.org/?r=iyivz4w5jebv"), "Phone link: https://vbuddy.duckdns.org/?r=••••");
});
