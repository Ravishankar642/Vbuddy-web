import { test } from "node:test";
import assert from "node:assert/strict";
import { envelope, parseClientMessage, parseServerMessage, PROTOCOL_VERSION } from "./index.js";

test("hello round-trips", () => {
  const raw = JSON.stringify(envelope({ t: "hello", client: "test", resume: { sessionId: "abc", lastSeq: 41 } }));
  const r = parseClientMessage(raw);
  assert.ok(r.ok);
  if (r.ok && r.msg.t === "hello") assert.equal(r.msg.resume?.lastSeq, 41);
});

test("rejects wrong protocol version", () => {
  const r = parseClientMessage(JSON.stringify({ v: PROTOCOL_VERSION + 1, ts: 0, t: "ping", nonce: "x" }));
  assert.equal(r.ok, false);
});

test("rejects unknown message type and junk", () => {
  assert.equal(parseClientMessage(JSON.stringify({ v: 1, ts: 0, t: "launchMissiles" })).ok, false);
  assert.equal(parseClientMessage("{not json").ok, false);
  assert.equal(parseServerMessage("null").ok, false);
});

test("getLanding, landingList and landing messages validate", async () => {
  const { LandingSchema } = await import("./index.js");
  assert.ok(parseClientMessage(JSON.stringify(envelope({ t: "getLanding", id: "abc" }))).ok);
  assert.equal(parseClientMessage(JSON.stringify(envelope({ t: "getLanding" } as never))).ok, false);
  assert.ok(parseServerMessage(JSON.stringify(envelope({ t: "landingList", landings: [] }))).ok);
  assert.ok(parseServerMessage(JSON.stringify(envelope({ t: "error", code: "not-found", message: "x" }))).ok);
  assert.equal(LandingSchema.safeParse({ id: "x" }).success, false);
});
