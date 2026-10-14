import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryHub } from "./hub.js";
import { startServer, type ConsoleHooks } from "./server.js";
import { LandingStore } from "./landing/store.js";
import { logger, recentLogs } from "./log.js";
import { autostartState, installPlugin, installRoot, pluginState } from "./host/windows.js";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { FakeSource } from "./test-helpers.js";
import { loadRelayIdentity, makeIdentity, phoneLink } from "./relay/identity.js";
import { readPrefs, writePrefs } from "./relay/console-prefs.js";
import { isBridgeId, isBridgeKey } from "@vbuddy/protocol";

async function rig() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const hooks: ConsoleHooks = { info: () => ({ version: "t", relay: { enabled: false } }), act: (a, b) => void calls.push([a, b]), activity: () => recentLogs() };
  const server = await startServer({ console: hooks, relay: { tag: "tag", access: "paired", id: "abcd2345wxyz" }, hub: new TelemetryHub(new FakeSource(), 50, 1), landings: new LandingStore(null, logger("test")), host: "127.0.0.1", port: 0, webDir: null });
  return { server, calls, base: `http://127.0.0.1:${(server.http.address() as { port: number }).port}` };
}

test("console: only a browser on this PC, opened as localhost, may read or change things", async () => {
  const { server, calls, base } = await rig();
  try {
    const ok = await fetch(base + "/api/console");
    assert.equal(ok.status, 200);
    assert.equal(((await ok.json()) as { version: string }).version, "t");
    // Through the relay (it presents this run's tag), the window is not reachable.
    assert.equal((await fetch(base + "/api/console", { headers: { "x-vbuddy-relay": "tag", "x-vbuddy-remote": "203.0.113.5" } })).status, 404);
    // Forwarded by a proxy, or reached by another host name (DNS rebinding): refused.
    assert.equal((await fetch(base + "/api/console", { headers: { "x-forwarded-for": "203.0.113.5" } })).status, 404);
    // Changes need the custom header (a web page can't send it without a preflight) and a same-origin Origin.
    const post = (headers: Record<string, string>, body = "{}") => fetch(base + "/api/console/relay", { method: "POST", headers, body });
    assert.equal((await post({})).status, 405);
    assert.equal((await post({ "x-vbuddy-console": "1", origin: "https://evil.example" })).status, 404);
    assert.equal(calls.length, 0);
    assert.equal((await post({ "x-vbuddy-console": "1", origin: new URL(base).origin }, '{"enabled":true}')).status, 200);
    assert.deepEqual(calls, [["relay", { enabled: true }]]);
    assert.equal((await fetch(base + "/api/console/nonsense", { method: "POST", headers: { "x-vbuddy-console": "1" } })).status, 405);
  } finally {
    await server.close();
  }
});

test("relay identity: made once, kept, and valid; the phone link carries only the id", () => {
  const dir = mkdtempSync(join(tmpdir(), "vbuddy-id-"));
  const file = join(dir, "relay-identity.json");
  const a = loadRelayIdentity(file);
  assert.ok(isBridgeId(a.id) && isBridgeKey(a.key));
  assert.deepEqual(loadRelayIdentity(file), a);
  assert.notDeepEqual(makeIdentity(), makeIdentity());
  const link = phoneLink("wss://vbuddy.duckdns.org/", a.id);
  assert.equal(link, `https://vbuddy.duckdns.org/?r=${a.id}`);
  assert.ok(!link.includes(a.key));
  assert.equal(phoneLink("ws://127.0.0.1:9", "abcd2345wxyz"), "http://127.0.0.1:9/?r=abcd2345wxyz");
});

test("console choices are saved and read back", () => {
  const file = join(mkdtempSync(join(tmpdir(), "vbuddy-prefs-")), "console-settings.json");
  assert.deepEqual(readPrefs(file), {});
  writePrefs(file, { relay: true });
  assert.deepEqual(readPrefs(file), { relay: true });
  writePrefs(file, { relay: false });
  assert.deepEqual(readPrefs(file), { relay: false });
  assert.deepEqual(readPrefs(null), {});
});

test("console: the accounts action is reachable and passes the body through", async () => {
  const { server, calls, base } = await rig();
  try {
    const r = await fetch(base + "/api/console/integrations", { method: "POST", headers: { "x-vbuddy-console": "1", origin: new URL(base).origin }, body: '{"simbrief":"jsmith"}' });
    assert.equal(r.status, 200);
    assert.deepEqual(calls, [["integrations", { simbrief: "jsmith" }]]);
  } finally {
    await server.close();
  }
});

test("console: the Activity page gets recent log lines, only from this PC", async () => {
  const { server, base } = await rig();
  try {
    logger("activity-test").info("hello from the test");
    const r = await fetch(base + "/api/console/activity");
    assert.equal(r.status, 200);
    const lines = (await r.json()) as Array<{ msg: string; scope: string; level: string }>;
    assert.ok(lines.some((l) => l.scope === "activity-test" && l.msg === "hello from the test" && l.level === "info"));
    assert.equal((await fetch(base + "/api/console/activity", { headers: { "x-vbuddy-relay": "tag", "x-vbuddy-remote": "203.0.113.5" } })).status, 404);
  } finally {
    await server.close();
  }
});

test("host: the vPilot plugin is copied in only when vPilot is there, and the page can tell if it is current", () => {
  const dir = mkdtempSync(join(tmpdir(), "vbuddy-host-"));
  const root = join(dir, "VBuddy");
  mkdirSync(join(root, "plugin"), { recursive: true });
  mkdirSync(join(root, "app"), { recursive: true });
  writeFileSync(join(root, "VBuddy.vbs"), "");
  writeFileSync(join(root, "plugin", "VBuddyLink.dll"), "v1");
  writeFileSync(join(root, "plugin", "VBuddyLink.ini"), "[x]");
  assert.equal(installRoot(join(root, "app", "vbuddy-bridge.mjs")), root);
  assert.equal(installRoot(join(dir, "elsewhere", "index.js")), null, "running from source has no install folder");
  const local = join(dir, "local");
  const env = { LOCALAPPDATA: local, VBUDDY_TEST_PLUGIN: "1" } as NodeJS.ProcessEnv;
  assert.match(String(installPlugin(root, env)), /vPilot doesn't seem to be installed/);
  mkdirSync(join(local, "vPilot"), { recursive: true });
  assert.deepEqual(pluginState(root, env), { available: true, dir: join(local, "vPilot", "Plugins"), installed: false, upToDate: false });
  assert.equal(installPlugin(root, env), undefined);
  assert.equal(readFileSync(join(local, "vPilot", "Plugins", "VBuddyLink.dll"), "utf8"), "v1");
  assert.equal(pluginState(root, env)!.upToDate, true);
  writeFileSync(join(root, "plugin", "VBuddyLink.dll"), "v2 is longer");
  assert.deepEqual([pluginState(root, env)!.installed, pluginState(root, env)!.upToDate], [true, false], "a newer plugin ships with this version");
  assert.equal(autostartState(null), null, "no install folder: not changeable");
});
