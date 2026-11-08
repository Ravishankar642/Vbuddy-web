import { test } from "node:test";
import assert from "node:assert/strict";
import { tailscaleServe, tailscaleState } from "./tailscale.js";

test("tailscale: not installed, running without serve, serving this port", async () => {
  assert.equal((await tailscaleState(4789, null)).installed, false);
  const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: "gaming-pc.tail1234.ts.net." } });
  const noServe = await tailscaleState(4789, "ts", async (_f, a) => (a[0] === "status" ? status : "{}"));
  assert.deepEqual([noServe.running, noServe.dnsName, noServe.url], [true, "gaming-pc.tail1234.ts.net", null]);
  const serving = await tailscaleState(4789, "ts", async (_f, a) => (a[0] === "status" ? status : '{"Web":{"gaming-pc.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4789"}}}}}'));
  assert.equal(serving.url, "https://gaming-pc.tail1234.ts.net/");
  assert.match((await tailscaleServe(4789, "ts", async () => Promise.reject(new Error("HTTPS is not enabled")))) ?? "", /HTTPS Certificates/);
  const approve = await tailscaleServe(4789, "ts", async () => Promise.reject(new Error("Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nAbC123\n\nCommand failed")));
  assert.match(approve ?? "", /https:\/\/login\.tailscale\.com\/f\/serve\?node=nAbC123 /);
  const calls: string[][] = [];
  const old = await tailscaleServe(4789, "ts", async (_f, a) => (calls.push(a), a.includes("--bg") ? Promise.reject(new Error("flag provided but not defined: -bg")) : ""));
  assert.equal(old, null);
  assert.deepEqual(calls[1], ["serve", "https", "/", "http://127.0.0.1:4789"]);
});
