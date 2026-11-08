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
});
