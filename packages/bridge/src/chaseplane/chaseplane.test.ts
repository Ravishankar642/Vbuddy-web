import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { logger } from "../log.js";
import { ChasePlaneClient, parseViews } from "./client.js";

/** A stand-in for ChasePlane's local API, answering the way ComSpotter expects it to. */
function fakeChasePlane() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const seen: Array<Record<string, unknown>> = [];
  let current = "";
  wss.on("connection", (ws) => {
    ws.send(JSON.stringify({ message: "airport_changed", payload: { activeIdent: "eddf" } }));
    ws.on("message", (d) => {
      const m = JSON.parse(d.toString());
      seen.push(m);
      if (m.message !== "api_request") return;
      if (m.command === "get_views") {
        ws.send(JSON.stringify({ message: "api_reply", request_id: m.request_id, status: 200, payload: { message: "get_views", payload: { views: [
          { name: "Captain", icao: "", guid: "c1", profile_theme: "", position: { x: 0, y: 0, z: 0 } },
          { name: "East Apron", icao: "EDDF", guid: "g1", profile_theme: "WORLD_TOWER", skip_cycle: true, position: { x: 8.58, y: 155.4, z: 50.05 } },
          { name: "", guid: "g2", position: {} },
          { name: "broken" },
        ] } } }));
      } else if (m.command === "set_view_by_guid") {
        const ok = m.payload.guid === "c1" || m.payload.guid === "g1";
        if (ok) current = m.payload.guid;
        ws.send(JSON.stringify({ message: "api_reply", request_id: m.request_id, status: ok ? 200 : 404, payload: {} }));
      }
    });
  });
  const port = () => (wss.address() as { port: number }).port;
  return { wss, seen, port, current: () => current };
}

test("parses ChasePlane's view list (ComSpotter's shape), skipping entries without an id", () => {
  const v = parseViews({ payload: { views: [{ guid: "a", name: " Wing ", profile_theme: "X", position: { x: 1, z: 2 } }, { name: "no id" }] } });
  assert.deepEqual(v, [{ guid: "a", name: "Wing", theme: "X", icao: "", lat: 2, lon: 1, skipCycle: false }]);
  assert.deepEqual(parseViews({ views: [{ guid: "b" }] })[0]!.name, "Unnamed view");
  assert.deepEqual(parseViews(null), []);
});

test("lists views and switches to one through the local API", async () => {
  const cp = fakeChasePlane();
  await new Promise((r) => cp.wss.once("listening", r));
  const client = new ChasePlaneClient(logger("test"), `ws://127.0.0.1:${cp.port()}/`);
  try {
    const r = await client.views();
    assert.equal(r.views.length, 3);
    assert.equal(r.views[1]!.lat, 50.05);
    assert.equal(r.views[1]!.skipCycle, true);
    assert.equal(r.airport, "EDDF");
    assert.equal(cp.seen[0]!.message, "api_connect");
    assert.deepEqual(cp.seen[0]!.payload, { client_name: "vbuddy" });
    await client.setView("g1");
    assert.equal(cp.current(), "g1");
    await assert.rejects(client.setView("nope"), /doesn't have that view/);
  } finally {
    client.close();
    cp.wss.close();
  }
});

test("says plainly when ChasePlane isn't running", async () => {
  const client = new ChasePlaneClient(logger("test"), "ws://127.0.0.1:1/");
  await assert.rejects(client.views(), /ChasePlane isn't running/);
});
