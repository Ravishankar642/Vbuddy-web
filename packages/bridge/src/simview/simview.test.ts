import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { envelope, parseServerMessage, type ServerMessage } from "@vbuddy/protocol";
import { logger } from "../log.js";
import { TelemetryHub } from "../hub.js";
import { startServer } from "../server.js";
import { LandingStore } from "../landing/store.js";
import { FakeSource, sampleTelemetry } from "../test-helpers.js";
import { Pairing } from "../control/pairing.js";
import { MockCapture, parse, type CaptureResult, type FrameSource } from "./capture.js";
import { SimViewFeed } from "./feed.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("helper replies are understood", () => {
  assert.deepEqual(parse("F 1024 576 QUJD"), { ok: true, w: 1024, h: 576, jpeg: "QUJD" });
  assert.equal((parse("N") as { reason: string }).reason, "no-window");
  assert.equal((parse("M") as { reason: string }).reason, "minimized");
  const e = parse("E Access denied") as { reason: string; message: string };
  assert.equal(e.reason, "unavailable");
  assert.match(e.message, /Access denied/);
});

test("feed: runs only while watched, skips while busy, frees the helper when nobody watches", async () => {
  let grabs = 0;
  let released = 0;
  let slow = false;
  const src: FrameSource = {
    async grab(): Promise<CaptureResult> {
      grabs++;
      if (slow) await wait(120);
      return { ok: true, jpeg: "x", w: 1, h: 1 };
    },
    release: () => void released++,
  };
  const frames: number[] = [];
  const states: string[] = [];
  const feed = new SimViewFeed(src, (f) => frames.push(f.seq), (s) => states.push(s), logger("test"), 20);
  await wait(60);
  assert.equal(grabs, 0, "nothing captured without viewers");
  feed.setViewers(2);
  await wait(110);
  assert.ok(frames.length >= 3, `frames ${frames.length}`);
  assert.equal(states[0], "live");
  slow = true;
  const before = grabs;
  await wait(130);
  assert.ok(grabs - before <= 2, "a slow capture isn't stacked up");
  feed.setViewers(0);
  const after = grabs;
  await wait(200);
  assert.ok(grabs - after <= 1);
  assert.equal(released, 0, "helper kept for a moment in case the viewer comes back");
  feed.stop();
  assert.equal(released, 1);
});

test("feed: reports why there is no picture", async () => {
  const src: FrameSource = { grab: async () => ({ ok: false, reason: "minimized", message: "min" }), release() {} };
  const states: string[] = [];
  const feed = new SimViewFeed(src, () => {}, (s) => states.push(s), logger("test"), 20);
  feed.setViewers(1);
  await wait(60);
  feed.stop();
  assert.deepEqual(states, ["minimized"]);
});

async function client(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
  const msgs: ServerMessage[] = [];
  ws.on("message", (d) => {
    const r = parseServerMessage(d.toString());
    if (r.ok) msgs.push(r.msg);
  });
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  ws.send(JSON.stringify(envelope({ t: "hello", client: "t" } as never)));
  const sendMsg = (b: object) => ws.send(JSON.stringify(envelope(b as never)));
  return { ws, msgs, sendMsg };
}

test("server: this PC gets frames after asking, and stops when it says so", async () => {
  const web = mkdtempSync(join(tmpdir(), "vbuddy-web-"));
  writeFileSync(join(web, "index.html"), "<h1>x</h1>");
  const src = new FakeSource();
  const hub = new TelemetryHub(src, 50, 1);
  const server = await startServer({ hub, landings: new LandingStore(null, logger("test")), pairing: new Pairing(null, logger("test")), simView: new MockCapture(), host: "127.0.0.1", port: 0, webDir: web });
  const port = (server.http.address() as { port: number }).port;
  hub.start();
  src.emit(sampleTelemetry());
  try {
    const c = await client(port);
    await wait(150);
    assert.equal(c.msgs.filter((m) => m.t === "simViewFrame").length, 0, "no frames before asking");
    c.sendMsg({ t: "simView", on: true });
    await wait(900);
    const frames = c.msgs.filter((m) => m.t === "simViewFrame");
    assert.ok(frames.length >= 2, `got ${frames.length}`);
    const f = frames[0] as Extract<ServerMessage, { t: "simViewFrame" }>;
    assert.equal(f.w, 1024);
    assert.ok(f.jpeg.startsWith("/9j/"), "a JPEG");
    assert.ok(c.msgs.some((m) => m.t === "simViewStatus" && m.state === "live"));
    c.sendMsg({ t: "simView", on: false });
    await wait(150);
    const n = c.msgs.filter((m) => m.t === "simViewFrame").length;
    await wait(500);
    assert.equal(c.msgs.filter((m) => m.t === "simViewFrame").length, n, "stopped");
    c.ws.close();
  } finally {
    hub.stop();
    await server.close();
  }
});
