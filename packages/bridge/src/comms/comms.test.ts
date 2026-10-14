import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { envelope, parseServerMessage, toHz, parseMhz, type BridgeToPlugin, type ServerMessage } from "@vbuddy/protocol";
import { CommsService, type PluginLink } from "./service.js";
import { MockRadios } from "./mock-radios.js";
import { logger } from "../log.js";
import { TelemetryHub } from "../hub.js";
import { startServer } from "../server.js";
import { LandingStore } from "../landing/store.js";
import { Pairing } from "../control/pairing.js";
import { FakeSource } from "../test-helpers.js";

const log = logger("test");

function fakePlugin() {
  const sent: BridgeToPlugin[] = [];
  const link: PluginLink = { send: (m) => sent.push(m), close() {} };
  return { sent, link };
}

test("frequency formats from vPilot are normalised to Hz", () => {
  assert.equal(toHz(122_800_000), 122_800_000);
  assert.equal(toHz(122_800), 122_800_000);
  assert.equal(toHz(22_800), 122_800_000);
  assert.equal(toHz(118.5), 118_500_000);
  assert.equal(parseMhz("122.8"), 122_800_000);
  assert.equal(parseMhz("118,500"), 118_500_000);
  assert.equal(parseMhz("122800"), 122_800_000);
  assert.equal(parseMhz("99.0"), null);
});

test("chat: threads, attention rules and sending", async () => {
  const radios = new MockRadios();
  const svc = new CommsService(radios, log);
  const { sent, link } = fakePlugin();
  const got: string[] = [];
  svc.onChat((m) => got.push(`${m.thread}|${m.attention}`));
  assert.deepEqual(await svc.run({ op: "send", to: { kind: "radio" }, text: "hi" }), { ok: false, error: "The VBuddy Link plugin isn't connected. Start vPilot with the plugin installed (see the README)." });

  svc.attachPlugin(link, "test");
  svc.fromPlugin({ t: "net", connected: true, callsign: "BAW123", type: "A320", selcal: "ABCD", observer: false });
  assert.equal(svc.state().net.connected, true);
  got.length = 0;
  svc.fromPlugin({ t: "chat", kind: "radio", from: "egll_app", freqs: [118_500], text: "BAW123, descend 4000" });
  svc.fromPlugin({ t: "chat", kind: "radio", from: "EGLL_APP", freqs: [118_500], text: "Speedbird 456 turn left" });
  svc.fromPlugin({ t: "chat", kind: "radio", from: "N123", freqs: [122_800], text: "baw 123 is that you?" });
  svc.fromPlugin({ t: "chat", kind: "private", from: "EGLL_TWR", freqs: [], text: "call me" });
  svc.fromPlugin({ t: "chat", kind: "selcal", from: "EGLL_CTR", freqs: [], text: "" });
  assert.deepEqual(got, ["freq:118500000|true", "freq:118500000|false", "freq:122800000|true", "dm:EGLL_TWR|true", "system|true"]);

  // Sending on a frequency neither radio is tuned to is refused before it can go out on the wrong one.
  const bad = await svc.run({ op: "send", to: { kind: "radio", freqHz: 121_900_000 }, text: "hello" });
  assert.equal(bad.ok, false);
  const p = svc.run({ op: "send", to: { kind: "radio", freqHz: 118_500_000 }, text: "Approach, BAW123 with you" });
  assert.equal(sent.at(-1)!.op, "sendRadio");
  svc.fromPlugin({ t: "result", id: sent.at(-1)!.id, ok: true });
  assert.deepEqual(await p, { ok: true });
  const dm = svc.run({ op: "send", to: { kind: "private", callsign: "egll_twr" }, text: "ok" });
  svc.fromPlugin({ t: "result", id: sent.at(-1)!.id, ok: true });
  await dm;
  const hist = svc.history();
  assert.deepEqual(hist.slice(-2).map((m) => `${m.thread}|${m.dir}`), ["freq:118500000|out", "dm:EGLL_TWR|out"]);

  // Radios and transponder go to the simulator, not the plugin.
  assert.deepEqual(await svc.run({ op: "com", radio: 1, action: "standby", hz: 119_100_000 }), { ok: true });
  await svc.run({ op: "com", radio: 1, action: "swap" });
  assert.equal(svc.state().radios!.com1.active, 119_100_000);
  assert.equal(svc.state().radios!.com1.standby, 118_500_000);
  assert.equal(svc.state().radios!.com2.rx, true);
  await svc.run({ op: "com", radio: 2, action: "listen", on: false });
  assert.equal(svc.state().radios!.com2.rx, false);
  await svc.run({ op: "com", radio: 2, action: "listen" }); // no value = toggle
  assert.equal(svc.state().radios!.com2.rx, true);
  await svc.run({ op: "xpdr", action: "code", code: "7000" });
  assert.equal(svc.state().xpdr!.code, "7000");
  const ident = svc.run({ op: "xpdr", action: "ident" });
  assert.equal(sent.at(-1)!.op, "ident");
  svc.fromPlugin({ t: "result", id: sent.at(-1)!.id, ok: true });
  await ident;

  // Connect reuses the last identity; disconnect goes through the plugin too.
  const d = svc.run({ op: "net", action: "disconnect" });
  svc.fromPlugin({ t: "result", id: sent.at(-1)!.id, ok: true });
  await d;
  svc.fromPlugin({ t: "net", connected: false, callsign: null, type: null, selcal: null, observer: false });
  const c = svc.run({ op: "net", action: "connect" });
  const last = sent.at(-1)!;
  assert.ok(last.op === "connect" && last.callsign === "BAW123" && last.type === "A320" && last.selcal === "ABCD");
  svc.fromPlugin({ t: "result", id: last.id, ok: false, error: "Not ready" });
  assert.deepEqual(await c, { ok: false, error: "Not ready" });
  svc.detachPlugin(link);
  assert.equal(svc.state().net.pluginLinked, false);
});

test("plugin socket: only from this PC; chat reaches the PC but not an unpaired remote device", async () => {
  const comms = new CommsService(new MockRadios(), log);
  const hub = new TelemetryHub(new FakeSource(), 5, 1);
  const server = await startServer({ comms, pairing: new Pairing(null, log), hub, landings: new LandingStore(null, log), host: "127.0.0.1", port: 0, webDir: null });
  const port = (server.http.address() as { port: number }).port;
  const client = async (ip: string | null) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, ip ? { headers: { "x-forwarded-for": ip } } : {});
    const msgs: ServerMessage[] = [];
    ws.on("message", (d) => {
      const r = parseServerMessage(d.toString());
      if (r.ok) msgs.push(r.msg);
    });
    await new Promise((r) => ws.once("open", r));
    ws.send(JSON.stringify(envelope({ t: "hello" })));
    return { ws, msgs, send: (b: object) => ws.send(JSON.stringify(envelope(b as never))) };
  };
  const until = async (f: () => boolean) => {
    const end = Date.now() + 3000;
    while (!f()) {
      if (Date.now() > end) throw new Error("timeout");
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  try {
    // Not from the plugin path with a forwarded address.
    const refused = await new Promise<boolean>((res) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/plugin`, { headers: { "x-forwarded-for": "203.0.113.5" } });
      w.on("open", () => res(false));
      w.on("error", () => res(true));
    });
    assert.equal(refused, true);

    const pc = await client(null);
    const tab = await client("192.168.1.50");
    await until(() => pc.msgs.some((m) => m.t === "commsState") && tab.msgs.some((m) => m.t === "commsState"));
    assert.equal(pc.msgs.find((m) => m.t === "commsState" && m.state.net.pluginLinked), undefined);

    const plugin = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
    const fromBridge: unknown[] = [];
    plugin.on("message", (d) => fromBridge.push(JSON.parse(d.toString())));
    await new Promise((r) => plugin.once("open", r));
    plugin.send(JSON.stringify({ t: "hello", protocol: 1, plugin: "test" }));
    plugin.send(JSON.stringify({ t: "net", connected: true, callsign: "BAW123", type: "A320", selcal: "ABCD", observer: false }));
    plugin.send(JSON.stringify({ t: "chat", kind: "private", from: "EGLL_TWR", freqs: [], text: "secret" }));
    await until(() => pc.msgs.some((m) => m.t === "chat" && m.message.text === "secret"));
    await until(() => tab.msgs.some((m) => m.t === "commsState" && m.state.net.connected));
    assert.equal(tab.msgs.some((m) => m.t === "chat" || m.t === "chatHistory"), false, "DMs are not shown to unpaired devices");

    // Commands: the PC may, an unpaired device may not.
    tab.send({ t: "commsCmd", id: "1", cmd: { op: "xpdr", action: "code", code: "1234" } });
    await until(() => tab.msgs.some((m) => m.t === "commsResult" && !m.ok));
    pc.send({ t: "commsCmd", id: "2", cmd: { op: "send", to: { kind: "private", callsign: "EGLL_TWR" }, text: "on my way" } });
    await until(() => fromBridge.some((m) => (m as { op?: string }).op === "sendPrivate"));
    const req = fromBridge.find((m) => (m as { op?: string }).op === "sendPrivate") as { id: string };
    plugin.send(JSON.stringify({ t: "result", id: req.id, ok: true }));
    await until(() => pc.msgs.some((m) => m.t === "commsResult" && m.id === "2" && m.ok));
    plugin.close();
    await until(() => pc.msgs.some((m) => m.t === "commsState" && !m.state.net.pluginLinked && m.state !== undefined && pc.msgs.filter((x) => x.t === "commsState").length > 2));
    pc.ws.close();
    tab.ws.close();
  } finally {
    await server.close();
  }
});
