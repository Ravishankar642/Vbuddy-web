import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { envelope, parseServerMessage, type ServerMessage } from "@vbuddy/protocol";
import { startRelay } from "@vbuddy/relay";
import { TelemetryHub } from "../hub.js";
import { startServer } from "../server.js";
import { LandingStore } from "../landing/store.js";
import { logger } from "../log.js";
import { FakeSource, sampleTelemetry } from "../test-helpers.js";
import { CockpitService } from "../cockpit/service.js";
import { MockCockpit } from "../cockpit/mock-cockpit.js";
import { Pairing } from "../control/pairing.js";
import { PushService } from "../push/service.js";
import { RelayClient } from "./relay-client.js";

const ID = "abcd2345wxyz";
const KEY = "test-key-0123456789abcdef0123456789abcdef";
const COOKIE = `vb=${ID}`;
const TAG = "tag-for-this-test-run";

async function rig(access: "paired" | "open" = "paired") {
  const web = mkdtempSync(join(tmpdir(), "vbuddy-web-"));
  writeFileSync(join(web, "index.html"), "<h1>VBuddy test page</h1>");
  const src = new FakeSource();
  const hub = new TelemetryHub(src, 50, 1);
  const cockpit = new CockpitService(new MockCockpit(2), logger("test"), { clickMs: 2, verifyMs: 150 });
  const pairing = new Pairing(null, logger("test"));
  const sent: Array<{ endpoint: string; payload: Record<string, string> }> = [];
  const push = new PushService(null, null, "mailto:t@example.com", logger("test"), async (sub, payload) => {
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  });
  const server = await startServer({ hub, landings: new LandingStore(null, logger("test")), cockpit, pairing, push, relay: { tag: TAG, access }, host: "127.0.0.1", port: 0, webDir: web });
  const bridgePort = (server.http.address() as { port: number }).port;
  const relay = await startRelay({ host: "127.0.0.1", port: 0, trustProxy: true });
  const client = new RelayClient({ url: `ws://127.0.0.1:${relay.port()}`, id: ID, key: KEY, localPort: bridgePort, tag: TAG, name: "test", log: logger("test") });
  const connected = new Promise<void>((res) => client.onState((s) => s === "connected" && res()));
  client.start();
  await connected;
  hub.start();
  src.emit(sampleTelemetry());
  const keep = setInterval(() => src.emit(sampleTelemetry()), 20);
  return {
    src, hub, server, pairing, push, sent, relay, client, bridgePort,
    relayPort: relay.port(),
    async close() {
      clearInterval(keep);
      client.stop();
      hub.stop();
      await relay.close();
      await server.close();
    },
  };
}

async function open(url: string, ip: string, hello: object) {
  const ws = new WebSocket(url, { headers: { "x-forwarded-for": ip, cookie: COOKIE } });
  const msgs: ServerMessage[] = [];
  ws.on("message", (d) => {
    const r = parseServerMessage(d.toString());
    if (r.ok) msgs.push(r.msg);
  });
  await new Promise((res, rej) => {
    ws.once("open", res);
    ws.once("error", rej);
  });
  ws.send(JSON.stringify(envelope({ t: "hello", ...hello } as never)));
  const waitFor = async (pred: (m: ServerMessage[]) => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred(msgs)) {
      if (Date.now() > end) throw new Error(`timeout; got ${msgs.map((m) => m.t).join(",")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const sendMsg = (b: object) => ws.send(JSON.stringify(envelope(b as never)));
  return { ws, msgs, waitFor, sendMsg };
}
const last = <T extends ServerMessage["t"]>(m: ServerMessage[], t: T) => m.filter((x) => x.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;

test("relay: pages pass through, data is locked until the device pairs, relayed clients are never 'local'", async () => {
  const r = await rig();
  const base = `http://127.0.0.1:${r.relayPort}`;
  try {
    // The app itself is public; the data API is not.
    const page = await fetch(base + "/", { headers: { cookie: COOKIE, "x-forwarded-for": "203.0.113.9" } });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /VBuddy test page/);
    assert.equal((await fetch(base + "/api/landings", { headers: { cookie: COOKIE, "x-forwarded-for": "203.0.113.9" } })).status, 401);
    assert.equal((await fetch(base + "/relay/health")).status, 200);
    assert.equal((await fetch(base + "/", { method: "POST" })).status, 405);

    // Someone claiming to be the PC through the relay is still just a relayed, unpaired device.
    const pcLocal = await open(`ws://127.0.0.1:${r.bridgePort}/ws`, "127.0.0.1", { client: "pc" });
    await pcLocal.waitFor((m) => m.some((x) => x.t === "pairingInfo"));
    const code = last(pcLocal.msgs, "pairingInfo")!.code;

    const liar = await open(`ws://127.0.0.1:${r.relayPort}/ws`, "127.0.0.1", { client: "liar" });
    await liar.waitFor((m) => m.some((x) => x.t === "cockpit"));
    const lc = last(liar.msgs, "cockpit")!.control;
    assert.equal(lc.locked, true);
    assert.equal(lc.allowed, false);
    await new Promise((res) => setTimeout(res, 250));
    assert.deepEqual([...new Set(liar.msgs.map((m) => m.t))], ["cockpit"], "no telemetry, no pairing code, nothing but the lock");
    liar.sendMsg({ t: "cmd", id: "x", cmd: { op: "press", ctl: "ap1" } });
    await liar.waitFor((m) => m.some((x) => x.t === "error"));
    liar.sendMsg({ t: "pair", code: "000000", device: "Liar" });
    await liar.waitFor((m) => m.some((x) => x.t === "pairResult" && !x.ok));
    liar.ws.close();

    // A proper tablet pairs with the code from the PC and the lock opens.
    const tab = await open(`ws://127.0.0.1:${r.relayPort}/ws`, "203.0.113.9", { client: "tablet" });
    await tab.waitFor((m) => m.some((x) => x.t === "cockpit"));
    tab.sendMsg({ t: "pair", code, device: "Galaxy Tab" });
    await tab.waitFor((m) => m.some((x) => x.t === "pairResult") && m.some((x) => x.t === "welcome") && m.some((x) => x.t === "telemetry"));
    const pr = last(tab.msgs, "pairResult")!;
    assert.ok(pr.ok && pr.token);
    assert.equal(last(tab.msgs, "cockpit")!.control.reason, "paired");
    assert.equal(last(tab.msgs, "cockpit")!.control.allowed, true);
    assert.equal(tab.msgs.some((x) => x.t === "pairingInfo"), false);
    tab.ws.close();

    // With the token it gets in at once, and the API accepts it.
    const again = await open(`ws://127.0.0.1:${r.relayPort}/ws`, "203.0.113.9", { client: "tablet", token: pr.token });
    await again.waitFor((m) => m.some((x) => x.t === "welcome"));
    const api = await fetch(base + "/api/landings", { headers: { cookie: COOKIE, authorization: `Bearer ${pr.token}` } });
    assert.equal(api.status, 200);

    // Notifications: only for a paired device, delivered by the bridge.
    again.sendMsg({ t: "pushSubscribe", subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "k", auth: "a" } }, prefs: { atc: true, landing: false, chat: true } });
    await again.waitFor((m) => last(m, "pushInfo")?.subscribed === true);
    await r.push.notifyAtc({ id: "1", kind: "contact", station: null, text: "Contact Mumbai Approach on 127.900" });
    await r.push.notifyLanding({ id: "L", rating: "smooth", vsFpm: -140, gPeak: 1.1, bounces: 0, touchAndGo: false } as never);
    assert.equal(r.sent.length, 1, "landing alerts were switched off for this device");
    assert.equal(r.sent[0]!.payload.kind, "atc");
    assert.match(r.sent[0]!.payload.body ?? "", /Mumbai Approach/);
    await r.push.notifyChat({ id: "m1", ts: 1, kind: "private", dir: "in", from: "EGLL_TWR", to: "BAW123", freqHz: [], text: "call me", thread: "dm:EGLL_TWR", attention: true });
    assert.equal(r.sent.length, 2);
    assert.equal(r.sent[1]!.payload.kind, "chat");
    assert.match(r.sent[1]!.payload.title ?? "", /EGLL_TWR/);
    again.sendMsg({ t: "pushTest" });
    await again.waitFor(() => r.sent.length === 3);

    // The PC removes the device: the relayed connection is cut and its subscription is gone.
    await pcLocal.waitFor((m) => (last(m, "pairingInfo")?.devices.length ?? 0) === 1);
    const closed = new Promise<number>((res) => again.ws.once("close", (c) => res(c)));
    pcLocal.sendMsg({ t: "revokeDevice", id: last(pcLocal.msgs, "pairingInfo")!.devices[0]!.id });
    assert.equal(await closed, 4003);
    assert.equal(r.push.count(), 0);
    assert.equal((await fetch(base + "/api/landings", { headers: { cookie: COOKIE, authorization: `Bearer ${pr.token}` } })).status, 401);
    pcLocal.ws.close();
  } finally {
    await r.close();
  }
});

test("relay: 'open' access shows data without pairing but still needs pairing for control", async () => {
  const r = await rig("open");
  try {
    const v = await open(`ws://127.0.0.1:${r.relayPort}/ws`, "198.51.100.4", { client: "viewer" });
    await v.waitFor((m) => m.some((x) => x.t === "telemetry"));
    const c = last(v.msgs, "cockpit")!.control;
    assert.equal(c.allowed, false);
    assert.equal(c.locked, undefined);
    assert.equal(v.msgs.some((x) => x.t === "pairingInfo"), false);
    v.ws.close();
  } finally {
    await r.close();
  }
});

function tunnelStatus(port: number, id: string | null, key: string | null): Promise<number> {
  return new Promise((res) => {
    const headers: Record<string, string> = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (id) headers["x-vbuddy-id"] = id;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/tunnel`, { headers });
    ws.on("unexpected-response", (_q, resp) => res(resp.statusCode ?? 0));
    ws.on("open", () => {
      ws.close();
      res(101);
    });
    ws.on("error", () => {});
  });
}

test("relay: a bridge needs an id and key; a known id needs its own key; PC off shows the offline page", async () => {
  const relay = await startRelay({ host: "127.0.0.1", port: 0, trustProxy: false });
  try {
    assert.equal(await tunnelStatus(relay.port(), null, null), 401);
    assert.equal(await tunnelStatus(relay.port(), ID, "short"), 401);
    assert.equal(await tunnelStatus(relay.port(), "NOT-AN-ID", KEY), 401);
    assert.equal(await tunnelStatus(relay.port(), ID, KEY), 101); // first use registers the id
    assert.equal(relay.registeredCount(), 1);
    assert.equal(await tunnelStatus(relay.port(), ID, KEY), 101);
    assert.equal(await tunnelStatus(relay.port(), ID, "other-key-0123456789abcdef0123456789abcdef"), 401, "someone else can't take over a registered id");
    const off = await fetch(`http://127.0.0.1:${relay.port()}/`, { headers: { cookie: COOKIE } });
    assert.equal(off.status, 503);
    assert.match(await off.text(), /isn't connected/);
    assert.equal(relay.bridgeConnected(ID), false);
  } finally {
    await relay.close();
  }
});

test("relay: the phone link sets a cookie and routes to the right PC; many PCs share one relay", async () => {
  const relay = await startRelay({ host: "127.0.0.1", port: 0, trustProxy: false });
  const pcs: Array<{ id: string; server: Awaited<ReturnType<typeof startServer>>; client: RelayClient }> = [];
  try {
    for (const [id, key, name] of [
      ["aaaaaaaaaaaa", "k".repeat(40) + "1", "first"],
      ["bbbbbbbbbbbb", "k".repeat(40) + "2", "second"],
    ] as const) {
      const web = mkdtempSync(join(tmpdir(), "vbuddy-web-"));
      writeFileSync(join(web, "index.html"), `<h1>${name} PC</h1>`);
      writeFileSync(join(web, "manifest.webmanifest"), JSON.stringify({ name: "VBuddy", start_url: "/" }));
      const hub = new TelemetryHub(new FakeSource(), 50, 1);
      const server = await startServer({ hub, landings: new LandingStore(null, logger("test")), relay: { tag: `tag-${name}`, access: "open", id }, host: "127.0.0.1", port: 0, webDir: web });
      const client = new RelayClient({ url: `ws://127.0.0.1:${relay.port()}`, id, key, localPort: (server.http.address() as { port: number }).port, tag: `tag-${name}`, name, log: logger("test") });
      const up = new Promise<void>((r) => client.onState((x) => x === "connected" && r()));
      client.start();
      await up;
      pcs.push({ id, server, client });
    }
    assert.equal(relay.bridgeCount(), 2);
    const base = `http://127.0.0.1:${relay.port()}`;

    // No cookie: asked for the id. A bad id: asked again. A good id: cookie + redirect.
    const ask = await fetch(base + "/");
    assert.equal(ask.status, 200);
    assert.match(await ask.text(), /phone link ID/);
    assert.equal((await fetch(base + "/assets/x.js")).status, 404);
    assert.match(await (await fetch(base + "/?r=nope")).text(), /doesn't look right/);
    const go = await fetch(base + "/?r=BBBBBBBBBBBB", { redirect: "manual" });
    assert.equal(go.status, 302);
    assert.equal(go.headers.get("location"), "/");
    const cookie = /vb=([a-z2-7]{12})/.exec(go.headers.get("set-cookie") ?? "")?.[1];
    assert.equal(cookie, "bbbbbbbbbbbb");

    // Each cookie reaches its own PC.
    assert.match(await (await fetch(base + "/", { headers: { cookie: "vb=aaaaaaaaaaaa" } })).text(), /first PC/);
    assert.match(await (await fetch(base + "/", { headers: { cookie: "vb=bbbbbbbbbbbb" } })).text(), /second PC/);
    // An unknown id looks the same as a PC that is off.
    assert.equal((await fetch(base + "/", { headers: { cookie: "vb=cccccccccccc" } })).status, 503);

    // The installed app's start address carries the id of the PC that served it.
    const mf = (await (await fetch(base + "/manifest.webmanifest", { headers: { cookie: "vb=bbbbbbbbbbbb" } })).json()) as { start_url: string };
    assert.equal(mf.start_url, "/?r=bbbbbbbbbbbb");

    // The WebSocket is routed by the same cookie.
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port()}/ws`, { headers: { cookie: "vb=aaaaaaaaaaaa" } });
    const first = await new Promise<string>((res, rej) => {
      ws.once("open", () => ws.send(JSON.stringify(envelope({ t: "hello", client: "t" } as never))));
      ws.once("message", (d) => res(d.toString()));
      ws.once("error", rej);
    });
    assert.match(first, /"t":"welcome"/);
    ws.close();
  } finally {
    for (const p of pcs) {
      p.client.stop();
      await p.server.close();
    }
    await relay.close();
  }
});

test("relay: registrations are limited per address, and the registry survives a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vbuddy-reg-"));
  const registryFile = join(dir, "bridges.json");
  const key = "z".repeat(40);
  const r1 = await startRelay({ host: "127.0.0.1", port: 0, trustProxy: false, registryFile, registerPerHour: 2 });
  try {
    assert.equal(await tunnelStatus(r1.port(), "dddddddddddd", key), 101);
    assert.equal(await tunnelStatus(r1.port(), "eeeeeeeeeeee", key), 101);
    assert.equal(await tunnelStatus(r1.port(), "ffffffffffff", key), 401, "a third new PC from one address within the hour is refused");
    assert.equal(await tunnelStatus(r1.port(), "dddddddddddd", key), 101, "a known PC can always reconnect");
  } finally {
    await r1.close();
  }
  const r2 = await startRelay({ host: "127.0.0.1", port: 0, trustProxy: false, registryFile });
  try {
    assert.equal(r2.registeredCount(), 2);
    assert.equal(await tunnelStatus(r2.port(), "dddddddddddd", "y".repeat(40)), 401, "the old key is still the owner after a restart");
    assert.equal(await tunnelStatus(r2.port(), "dddddddddddd", key), 101);
  } finally {
    await r2.close();
  }
});
