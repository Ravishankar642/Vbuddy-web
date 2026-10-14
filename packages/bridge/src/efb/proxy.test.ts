import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { startRelay } from "@vbuddy/relay";
import { TelemetryHub } from "../hub.js";
import { startServer } from "../server.js";
import { LandingStore } from "../landing/store.js";
import { logger } from "../log.js";
import { FakeSource } from "../test-helpers.js";
import { CockpitService } from "../cockpit/service.js";
import { MockCockpit } from "../cockpit/mock-cockpit.js";
import { Pairing } from "../control/pairing.js";
import { RelayClient } from "../relay/relay-client.js";
import { EfbProxy, rewriteCss, rewriteHtml, rewriteJs } from "./proxy.js";

function fakeEfb(): Promise<{ srv: Server; port: number }> {
  const srv = createServer((req, res) => {
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": "default-src 'self'" });
      return res.end('<html><head></head><body><script src="/app.js"></script></body></html>');
    }
    if (req.url === "/sub/page.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end('<html><head></head><body><iframe src="inner.html"></iframe></body></html>');
    }
    if (req.url === "/sub/inner.html") return res.writeHead(200, { "content-type": "text/html" }).end("<p>inner</p>");
    if (req.url === "/style.css") return res.writeHead(200, { "content-type": "text/css" }).end("a{background:url(/img.png)}");
    if (req.url === "/api/echo") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => res.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.concat([Buffer.from(req.method + ":"), ...chunks])));
      return;
    }
    res.writeHead(404).end("nope");
  });
  const wss = new WebSocketServer({ server: srv });
  wss.on("connection", (ws) => ws.on("message", (d, bin) => ws.send(d, { binary: bin })));
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: (srv.address() as { port: number }).port })));
}

function get(port: number, path: string, method = "GET", body?: Buffer, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
  return new Promise((res, rej) => {
    const r = httpRequest({ host: "127.0.0.1", port, path, method, headers }, (x) => {
      const c: Buffer[] = [];
      x.on("data", (d) => c.push(d));
      x.on("end", () => res({ status: x.statusCode ?? 0, headers: x.headers, body: Buffer.concat(c) }));
    });
    r.on("error", rej);
    r.end(body);
  });
}

test("rewrites root-absolute urls in html and css", () => {
  const h = rewriteHtml('<head></head><img src="/a.png"><a href="https://x.com/">', "/efb/T", 8083);
  assert.match(h, /src="\/efb\/T\/a\.png"/);
  assert.match(h, /href="https:\/\/x\.com\/"/);
  assert.doesNotMatch(h, /<base /);
  assert.match(rewriteHtml('<iframe src="http://192.168.1.20:8083/mcdu/screen"></iframe><script>var u="http://192.168.1.20:8083";</script>', "/efb/T", 8083), /src="\/efb\/T\/mcdu\/screen"[\s\S]*var u="\/efb\/T";/);
  assert.equal(rewriteJs('a.src="/img/x.png?v=1";b="/api/data";c="https://h/x.png"', "/efb/T"), 'a.src="/efb/T/img/x.png?v=1";b="/api/data";c="https://h/x.png"');
  assert.match(rewriteHtml('<img srcset="/a.png 1x, /b.png 2x">', "/efb/T", 1), /srcset="\/efb\/T\/a\.png 1x, \/efb\/T\/b\.png 2x"/);
  assert.equal(rewriteCss("a{background:url(/i.png)}@import '/b.css';", "/efb/T"), "a{background:url(/efb/T/i.png)}@import '/efb/T/b.css';");
});

async function rig() {
  const up = await fakeEfb();
  const web = mkdtempSync(join(tmpdir(), "vbuddy-web-"));
  writeFileSync(join(web, "index.html"), "<h1>x</h1>");
  const efb = new EfbProxy(() => up.port, logger("test"));
  const src = new FakeSource();
  const hub = new TelemetryHub(src, 50, 1);
  const server = await startServer({
    hub, landings: new LandingStore(null, logger("test")),
    cockpit: new CockpitService(new MockCockpit(2), logger("test"), { clickMs: 2, verifyMs: 150 }),
    pairing: new Pairing(null, logger("test")), efb, efbPort: up.port,
    relay: { tag: "t", access: "open" }, host: "127.0.0.1", port: 0, webDir: web,
  });
  const port = (server.http.address() as { port: number }).port;
  return { up, efb, server, port, async close() { await server.close(); up.srv.close(); } };
}

test("efb: session token, html, css, POST body and expiry", async () => {
  const r = await rig();
  try {
    assert.equal((await get(r.port, "/efb/" + "a".repeat(30) + "/")).status, 403);
    const path = r.efb.mint();
    const page = await get(r.port, path);
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], undefined);
    assert.match(page.body.toString(), new RegExp(`src="${path}app\\.js"`));
    const css = await get(r.port, path + "style.css");
    assert.match(css.body.toString(), new RegExp(`url\\(${path}img\\.png\\)`));
    const echo = await get(r.port, path + "api/echo", "POST", Buffer.from([0, 1, 2, 255]));
    assert.deepEqual([...echo.body], [...Buffer.from("POST:"), 0, 1, 2, 255]);
    // a sub-page's relative addresses stay beside it
    assert.match((await get(r.port, path + "sub/page.html")).body.toString(), /src="inner\.html"/);
    assert.equal((await get(r.port, path + "sub/inner.html")).status, 200);
    assert.equal(await r.efb.probe(), true);
  } finally { await r.close(); }
});

test("efb: websocket text + binary, direct and through the relay tunnel", async () => {
  const r = await rig();
  const relay = await startRelay({ host: "127.0.0.1", port: 0, trustProxy: true });
  const ID = "abcd2345wxyz";
  const client = new RelayClient({ url: `ws://127.0.0.1:${relay.port()}`, id: ID, key: "test-key-0123456789abcdef0123456789abcdef", localPort: r.port, tag: "t", name: "t", log: logger("test") });
  const up = new Promise<void>((res) => client.onState((s) => s === "connected" && res()));
  client.start();
  await up;
  try {
    const path = r.efb.mint();
    for (const [base, hdr] of [[`ws://127.0.0.1:${r.port}`, {}], [`ws://127.0.0.1:${relay.port()}`, { cookie: `vb=${ID}`, "x-forwarded-for": "9.9.9.9" }]] as const) {
      const ws = new WebSocket(base + path + "sock", ["proto-a"], { headers: hdr });
      const got: Array<{ s: string; bin: boolean }> = [];
      ws.on("message", (d, bin) => got.push({ s: Buffer.from(d as Buffer).toString("hex"), bin }));
      await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      assert.equal(ws.protocol, "proto-a");
      ws.send("hi");
      ws.send(Buffer.from([1, 2, 3, 250]));
      const end = Date.now() + 3000;
      while (got.length < 2 && Date.now() < end) await new Promise((x) => setTimeout(x, 20));
      assert.deepEqual(got, [{ s: Buffer.from("hi").toString("hex"), bin: false }, { s: "010203fa", bin: true }]);
      ws.close();
    }
    // HTTP incl. POST body through the relay
    const via = await get(relay.port(), path + "api/echo", "POST", Buffer.from("payload"), { cookie: `vb=${ID}`, "x-forwarded-for": "9.9.9.9" });
    assert.equal(via.body.toString(), "POST:payload");
    const blocked = await get(relay.port(), "/api/landings", "POST", Buffer.from("x"), { cookie: `vb=${ID}`, "x-forwarded-for": "9.9.9.9" });
    assert.ok(blocked.status >= 400);
  } finally { client.stop(); await relay.close(); await r.close(); }
});
