import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { envelope, parseServerMessage, type ServerMessage } from "@vbuddy/protocol";
import { TelemetryHub } from "./hub.js";
import { startServer } from "./server.js";
import { LandingStore } from "./landing/store.js";
import { logger } from "./log.js";
import { FakeSource, sampleTelemetry } from "./test-helpers.js";

/** Connects, sends hello, and collects messages. */
async function connect(port: number, hello: object) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.on("message", (d) => {
    const r = parseServerMessage(d.toString());
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (r.ok) msgs.push(r.msg);
    waiters.splice(0).forEach((w) => w());
  });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  ws.send(JSON.stringify(envelope({ t: "hello", ...hello } as never)));
  const waitFor = async (pred: (m: ServerMessage[]) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred(msgs)) {
      if (Date.now() > end) throw new Error(`timeout; got ${msgs.map((m) => m.t).join(",")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { ws, msgs, waitFor };
}

test("welcome, live telemetry, and resume replay over a real socket", async () => {
  const src = new FakeSource();
  const hub = new TelemetryHub(src, 50, 1);
  const server = await startServer({ hub, landings: new LandingStore(null, logger("test")), host: "127.0.0.1", port: 0, webDir: null });
  const port = (server.http.address() as { port: number }).port;
  try {
    src.emit(sampleTelemetry());
    hub.start();

    const a = await connect(port, { client: "test-a" });
    await a.waitFor((m) => m.filter((x) => x.t === "telemetry").length >= 3);
    const welcome = a.msgs[0];
    assert.equal(welcome?.t, "welcome");
    const lastSeen = a.msgs.filter((x) => x.t === "telemetry").at(-1);
    assert.ok(lastSeen?.t === "telemetry");
    a.ws.close();

    // Keep the sim "alive" while the client is away so the hub keeps producing frames.
    const keepAlive = setInterval(() => src.emit(sampleTelemetry()), 20);
    await new Promise((r) => setTimeout(r, 300));
    const b = await connect(port, { client: "test-b", resume: { sessionId: hub.sessionId, lastSeq: lastSeen.frame.seq } });
    await b.waitFor((m) => m.some((x) => x.t === "telemetryBatch"));
    clearInterval(keepAlive);
    const w = b.msgs[0];
    assert.ok(w?.t === "welcome" && w.resume?.status === "ok");
    const batch = b.msgs.find((x) => x.t === "telemetryBatch");
    assert.ok(batch?.t === "telemetryBatch");
    assert.equal(batch.frames[0]?.seq, lastSeen.frame.seq + 1, "replay starts right after the last frame seen");
    assert.ok(batch.frames.length >= 5, `replayed ${batch.frames.length}`);
    for (let i = 1; i < batch.frames.length; i++) assert.equal(batch.frames[i]!.seq, batch.frames[i - 1]!.seq + 1);

    // ping/pong + status push
    b.ws.send(JSON.stringify(envelope({ t: "ping", nonce: "n1" })));
    src.setStatus({ paused: true });
    await b.waitFor((m) => m.some((x) => x.t === "pong") && m.some((x) => x.t === "simStatus"));
    b.ws.close();
  } finally {
    hub.stop();
    await server.close();
  }
});

test("rejects garbage and messages before hello", async () => {
  const hub = new TelemetryHub(new FakeSource(), 5, 1);
  const server = await startServer({ hub, landings: new LandingStore(null, logger("test")), host: "127.0.0.1", port: 0, webDir: null });
  const port = (server.http.address() as { port: number }).port;
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once("open", r));
    const closed = new Promise<number>((r) => ws.once("close", (code) => r(code)));
    ws.send(JSON.stringify(envelope({ t: "ping", nonce: "x" })));
    assert.equal(await closed, 4001);
  } finally {
    await server.close();
  }
});

test("network: atc list on hello, traffic for the client's area, alerts pushed", async () => {
  const updates: Array<() => void> = [];
  const alerts: Array<(a: never) => void> = [];
  const areas: unknown[] = [];
  const station = { callsign: "XAAA_TWR", name: "Alpha Tower", freq: "118.700", facility: "twr", lat: 1, lon: 2, boundaryId: null } as const;
  const network = {
    status: () => ({ network: "vatsim", state: "ok", updatedAt: 5, boundaries: true }) as const,
    stations: () => [station],
    position: () => ({ current: station, ahead: null }),
    traffic: (area: unknown) => {
      areas.push(area);
      return { network: "vatsim" as const, updatedAt: 5, you: null, pilots: area ? [{ callsign: "P1", lat: 1, lon: 2, alt: 1000, gs: 100, hdg: 0, distNm: 1 }] : [] };
    },
    boundaries: (ids: string[]) => ({ type: "FeatureCollection", features: [], ids }),
    onUpdate: (cb: () => void) => updates.push(cb),
    onPosition: () => {},
    onAlert: (cb: (a: never) => void) => alerts.push(cb),
  };
  const hub = new TelemetryHub(new FakeSource(), 5, 1);
  const server = await startServer({ hub, landings: new LandingStore(null, logger("test")), network, host: "127.0.0.1", port: 0, webDir: null });
  const port = (server.http.address() as { port: number }).port;
  try {
    const c = await connect(port, { client: "map" });
    await c.waitFor((m) => m.some((x) => x.t === "atcList") && m.some((x) => x.t === "atcPosition") && m.some((x) => x.t === "traffic"));
    const list = c.msgs.find((x) => x.t === "atcList");
    assert.ok(list?.t === "atcList" && list.stations[0]?.callsign === "XAAA_TWR");
    c.ws.send(JSON.stringify(envelope({ t: "trafficArea", lat: 1, lon: 2, radiusNm: 50 })));
    await c.waitFor((m) => m.some((x) => x.t === "traffic" && x.pilots.length === 1));
    assert.deepEqual(areas.at(-1), { lat: 1, lon: 2, radiusNm: 50 });
    // a feed update re-sends traffic (atcList only if it changed)
    const before = c.msgs.filter((x) => x.t === "atcList").length;
    updates.forEach((u) => u());
    await c.waitFor((m) => m.filter((x) => x.t === "traffic").length >= 3);
    assert.equal(c.msgs.filter((x) => x.t === "atcList").length, before + 1, "first broadcast after hello is sent once");
    updates.forEach((u) => u());
    await c.waitFor((m) => m.filter((x) => x.t === "traffic").length >= 4);
    assert.equal(c.msgs.filter((x) => x.t === "atcList").length, before + 1, "unchanged list isn't repeated");
    alerts.forEach((a) => a({ id: "a1", kind: "contact", station, text: "Contact Alpha Tower on 118.700 (XAAA_TWR)." } as never));
    await c.waitFor((m) => m.some((x) => x.t === "atcAlert"));
    const geo = (await (await fetch(`http://127.0.0.1:${port}/api/network/boundaries?ids=a,b`)).json()) as { ids: string[] };
    assert.deepEqual(geo.ids, ["a", "b"]);
    c.ws.close();
  } finally {
    await server.close();
  }
});

test("cockpit: remote devices are view-only until paired; the PC sees the code; revoke works", async () => {
  const { CockpitService } = await import("./cockpit/service.js");
  const { MockCockpit } = await import("./cockpit/mock-cockpit.js");
  const { Pairing } = await import("./control/pairing.js");
  const cockpit = new CockpitService(new MockCockpit(2), logger("test"), { clickMs: 2, verifyMs: 150 });
  const pairing = new Pairing(null, logger("test"));
  const hub = new TelemetryHub(new FakeSource(), 5, 1);
  const server = await startServer({ hub, landings: new LandingStore(null, logger("test")), cockpit, pairing, host: "127.0.0.1", port: 0, webDir: null });
  const port = (server.http.address() as { port: number }).port;
  /** Connects as if from another device (the header is trusted only because the socket is local, like the dev proxy). */
  const connectAs = async (ip: string | null, hello: object) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ip ? { headers: { "x-forwarded-for": ip } } : {});
    const msgs: ServerMessage[] = [];
    ws.on("message", (d) => {
      const r = parseServerMessage(d.toString());
      if (r.ok) msgs.push(r.msg);
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify(envelope({ t: "hello", ...hello } as never)));
    const waitFor = async (pred: (m: ServerMessage[]) => boolean) => {
      const end = Date.now() + 3000;
      while (!pred(msgs)) {
        if (Date.now() > end) throw new Error(`timeout; got ${msgs.map((m) => m.t).join(",")}`);
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    const sendMsg = (b: object) => ws.send(JSON.stringify(envelope(b as never)));
    return { ws, msgs, waitFor, sendMsg };
  };
  const last = <T extends ServerMessage["t"]>(m: ServerMessage[], t: T) => m.filter((x) => x.t === t).at(-1) as Extract<ServerMessage, { t: T }> | undefined;
  try {
    const pc = await connectAs(null, { client: "pc" });
    await pc.waitFor((m) => m.some((x) => x.t === "pairingInfo") && m.some((x) => x.t === "cockpit"));
    assert.equal(last(pc.msgs, "cockpit")!.control.reason, "localhost");
    assert.equal(last(pc.msgs, "cockpit")!.state?.aircraft, "mock");

    const tab = await connectAs("192.168.1.50", { client: "tablet" });
    await tab.waitFor((m) => m.some((x) => x.t === "cockpit"));
    assert.equal(tab.msgs.some((x) => x.t === "pairingInfo"), false, "the code is never sent to other devices");
    assert.equal(last(tab.msgs, "cockpit")!.control.allowed, false);
    tab.sendMsg({ t: "cmd", id: "c1", cmd: { op: "press", ctl: "ap1" } });
    await tab.waitFor((m) => m.some((x) => x.t === "cmdResult"));
    assert.equal(last(tab.msgs, "cmdResult")!.ok, false);
    tab.sendMsg({ t: "revokeDevice", id: "x" });
    await tab.waitFor((m) => m.some((x) => x.t === "error" && x.code === "not-allowed"));

    tab.sendMsg({ t: "pair", code: last(pc.msgs, "pairingInfo")!.code, device: "Galaxy Tab" });
    await tab.waitFor((m) => m.some((x) => x.t === "pairResult"));
    const pr = last(tab.msgs, "pairResult")!;
    assert.ok(pr.ok && pr.token);
    await tab.waitFor((m) => last(m, "cockpit")?.control.allowed === true);
    tab.sendMsg({ t: "cmd", id: "c2", cmd: { op: "press", ctl: "ap1" } });
    await tab.waitFor((m) => m.some((x) => x.t === "cmdResult" && x.id === "c2"));
    assert.equal(last(tab.msgs, "cmdResult")!.ok, true);
    await tab.waitFor((m) => last(m, "cockpit")?.state?.lights.ap1 === true);
    tab.ws.close();

    // Comes back later with its token: still allowed.
    const tab2 = await connectAs("192.168.1.50", { client: "tablet", token: pr.token });
    await tab2.waitFor((m) => last(m, "cockpit")?.control.allowed === true);
    assert.equal(last(tab2.msgs, "cockpit")!.control.deviceName, "Galaxy Tab");
    // The PC removes it: it drops to view-only at once.
    await pc.waitFor((m) => (last(m, "pairingInfo")?.devices.length ?? 0) === 1);
    pc.sendMsg({ t: "revokeDevice", id: last(pc.msgs, "pairingInfo")!.devices[0]!.id });
    await tab2.waitFor((m) => last(m, "cockpit")?.control.allowed === false);
    tab2.ws.close();
    pc.ws.close();
  } finally {
    await server.close();
  }
});
