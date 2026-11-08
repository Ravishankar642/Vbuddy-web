import { test } from "node:test";
import assert from "node:assert/strict";
import { WatchLinks } from "./watch-link.js";

test("watch link: one at a time, 24 hours, ends when switched off", () => {
  const w = new WatchLinks(null);
  assert.equal(w.verify("x"), false);
  const a = w.create(1000);
  assert.ok(w.verify(a.token, 2000));
  assert.equal(w.verify(a.token, 1000 + 25 * 3_600_000), false, "expired");
  const b = w.create(3000);
  assert.equal(w.verify(a.token, 4000), false, "replaced");
  assert.ok(w.verify(b.token, 4000));
  w.revoke();
  assert.equal(w.verify(b.token, 5000), false);
});

test("watch link: a friend through the relay follows the flight without pairing, read only", async () => {
  const { WebSocket } = await import("ws");
  const { WS_PATH } = await import("@vbuddy/protocol");
  const { TelemetryHub } = await import("./hub.js");
  const { startServer } = await import("./server.js");
  const { LandingStore } = await import("./landing/store.js");
  const { logger } = await import("./log.js");
  const { FakeSource } = await import("./test-helpers.js");
  const links = new WatchLinks(null);
  const tok = links.create().token;
  const server = await startServer({ relay: { tag: "tag", access: "paired", id: "abcd2345wxyz" }, watch: { links, base: () => "https://relay.example/?r=abcd2345wxyz" }, hub: new TelemetryHub(new FakeSource(), 50, 1), landings: new LandingStore(null, logger("test")), host: "127.0.0.1", port: 0, webDir: null });
  const port = (server.http.address() as { port: number }).port;
  const relayed = { "x-vbuddy-relay": "tag", "x-vbuddy-remote": "203.0.113.5" };
  try {
    const hello = (watch?: string) =>
      new Promise<string[]>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`, { headers: relayed });
        const got: string[] = [];
        ws.on("open", () => ws.send(JSON.stringify({ v: 1, ts: Date.now(), t: "hello", client: "friend", ...(watch ? { watch } : {}) })));
        ws.on("message", (d) => got.push((JSON.parse(String(d)) as { t: string }).t));
        setTimeout(() => (ws.close(), resolve(got)), 400);
      });
    const viewer = await hello(tok);
    assert.ok(viewer.includes("shareLinkState"), viewer.join());
    assert.ok(!viewer.includes("chatHistory"));
    const stranger = await hello("wrong-token-xx");
    assert.ok(!stranger.includes("shareLinkState"));
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/landings`, { headers: relayed })).status, 401);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/landings`, { headers: { ...relayed, "x-vbuddy-watch": tok } })).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/diagnostics`, { headers: { ...relayed, "x-vbuddy-watch": tok } })).status, 401);
  } finally {
    await server.close();
  }
});
