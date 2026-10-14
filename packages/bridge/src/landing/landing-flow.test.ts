import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { envelope, parseServerMessage, type Landing, type ServerMessage } from "@vbuddy/protocol";
import { TelemetryHub } from "../hub.js";
import { startServer } from "../server.js";
import { LandingAnalyzer } from "./analyzer.js";
import { FlightDb } from "../db/flight-db.js";
import { LandingStore } from "./store.js";
import { flyLanding } from "./test-flight.js";
import { logger } from "../log.js";
import { FakeSource } from "../test-helpers.js";

const log = logger("test");

function makeLanding(sink: number, t0 = 1_000_000): Landing {
  let n = 0;
  const an = new LandingAnalyzer(() => ({ aircraftTitle: "Test", source: "simconnect" }), () => `L${t0}-${++n}`);
  const { landings } = flyLanding(an, { sink, latch: "fresh" }, t0);
  assert.equal(landings.length, 1);
  return landings[0]!;
}

test("store keeps newest first, returns traces only by id, ignores duplicates", () => {
  const store = new LandingStore(null, log);
  const a = makeLanding(120, 1_000_000);
  const b = makeLanding(300, 5_000_000);
  store.add(a);
  store.add(b);
  store.add(b);
  assert.equal(store.size, 2);
  const list = store.list();
  assert.deepEqual(list.map((l) => l.id), [b.id, a.id]);
  assert.ok(!("profile" in list[0]!), "list entries carry no trace");
  assert.ok(store.get(a.id)!.profile.length > 100);
  assert.equal(store.get("nope"), undefined);
});

test("logbook survives a restart (flight database) and skips damaged rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vbuddy-"));
  try {
    const file = join(dir, "sub", "flights.db");
    const db1 = (await FlightDb.open(file, log))!;
    const s1 = new LandingStore({ save: (l) => void db1.insertLanding(l, null), loadRecent: (n) => db1.recentLandingJson(n) }, log);
    const a = makeLanding(120, 1_000_000);
    const b = makeLanding(300, 5_000_000);
    s1.add(a);
    s1.add(b);
    db1.insertLanding({ id: "junk", ts: 6_000_000 } as never, null); // schema-invalid row
    db1.close();

    const db2 = (await FlightDb.open(file, log))!;
    const s2 = new LandingStore({ save: () => {}, loadRecent: (n) => db2.recentLandingJson(n) }, log);
    s2.load();
    assert.equal(s2.size, 2, "only the two valid landings load");
    assert.deepEqual(s2.list().map((l) => l.id), [b.id, a.id]);
    assert.deepEqual(s2.get(a.id), a, "round-trips exactly");
    db2.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a save failure doesn't stop landings being served", () => {
  const store = new LandingStore(
    {
      save: () => {
        throw new Error("disk full");
      },
      loadRecent: () => [],
    },
    log,
  );
  const l = makeLanding(150);
  let seen = 0;
  store.onAdd(() => seen++);
  store.add(l);
  store.add(l); // duplicate: neither stored nor announced twice
  assert.equal(seen, 1);
  assert.equal(store.get(l.id)?.id, l.id);
});

async function connect(port: number, hello: object = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: ServerMessage[] = [];
  ws.on("message", (d) => {
    const r = parseServerMessage(d.toString());
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (r.ok) msgs.push(r.msg);
  });
  await new Promise<void>((res, rej) => {
    ws.once("open", () => res());
    ws.once("error", rej);
  });
  ws.send(JSON.stringify(envelope({ t: "hello", client: "t", ...hello } as never)));
  const waitFor = async (pred: (m: ServerMessage[]) => boolean, ms = 2000) => {
    const end = Date.now() + ms;
    while (!pred(msgs)) {
      if (Date.now() > end) throw new Error(`timeout; got ${msgs.map((m) => m.t).join(",")}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { ws, msgs, waitFor };
}

test("landings are listed on connect, pushed live, fetchable by id, and served over HTTP", async () => {
  const src = new FakeSource();
  const hub = new TelemetryHub(src, 5, 1);
  const store = new LandingStore(null, log);
  const old = makeLanding(110, 1_000_000);
  store.add(old);
  const server = await startServer({ hub, landings: store, host: "127.0.0.1", port: 0, webDir: null });
  const port = (server.http.address() as { port: number }).port;
  try {
    const c = await connect(port);
    await c.waitFor((m) => m.some((x) => x.t === "landingList"));
    const list = c.msgs.find((x) => x.t === "landingList");
    assert.ok(list?.t === "landingList");
    assert.deepEqual(list.landings.map((l) => l.id), [old.id]);
    assert.ok(!("profile" in list.landings[0]!));

    // a new landing is pushed with its trace
    const fresh = makeLanding(420, 9_000_000);
    store.add(fresh);
    await c.waitFor((m) => m.some((x) => x.t === "landing" && x.reason === "new"));
    const pushed = c.msgs.find((x) => x.t === "landing" && x.reason === "new");
    assert.ok(pushed?.t === "landing" && pushed.landing.id === fresh.id && pushed.landing.profile.length > 100);

    // ask for an old one by id
    c.ws.send(JSON.stringify(envelope({ t: "getLanding", id: old.id })));
    await c.waitFor((m) => m.some((x) => x.t === "landing" && x.reason === "requested"));
    const got = c.msgs.find((x) => x.t === "landing" && x.reason === "requested");
    assert.ok(got?.t === "landing" && got.landing.id === old.id && got.landing.profile.length > 100);

    // unknown id
    c.ws.send(JSON.stringify(envelope({ t: "getLanding", id: "nope" })));
    await c.waitFor((m) => m.some((x) => x.t === "error" && x.code === "not-found"));

    // HTTP
    const all = (await (await fetch(`http://127.0.0.1:${port}/api/landings`)).json()) as Array<{ id: string }>;
    assert.deepEqual(all.map((l) => l.id), [fresh.id, old.id]);
    const one = (await (await fetch(`http://127.0.0.1:${port}/api/landings/${old.id}`)).json()) as Landing;
    assert.equal(one.id, old.id);
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/landings/nope`)).status, 404);
    c.ws.close();
  } finally {
    await server.close();
  }
});
