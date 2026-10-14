import { test } from "node:test";
import assert from "node:assert/strict";
import { HoppieService, parseCpdlc, parseReply, type HoppieFetch } from "./hoppie.js";
import { logger } from "../log.js";
import type { Briefing } from "@vbuddy/protocol";

test("hoppie: parses ok, error and braced messages", () => {
  assert.deepEqual(parseReply("ok"), { ok: true, messages: [] });
  assert.deepEqual(parseReply("error {illegal logon code}"), { ok: false, error: "illegal logon code" });
  const r = parseReply("ok {EGLL_DEL telex {PDC RECEIVED CLRD TO OTHH}} {SERVER inforeq {METAR EGLL 131150Z 24012KT}} {EDDF cpdlc {/data2/5//WU/CLIMB TO @FL340@}}");
  assert.ok(r.ok);
  assert.deepEqual(r.messages.map((m) => [m.from, m.type]), [["EGLL_DEL", "telex"], ["SERVER", "inforeq"], ["EDDF", "cpdlc"]]);
  assert.equal(r.messages[1]!.packet, "METAR EGLL 131150Z 24012KT");
  assert.equal(parseReply("").ok, false);
  assert.equal(parseReply("<html>").ok, false);
});

test("hoppie: cpdlc packets", () => {
  assert.deepEqual(parseCpdlc("/data2/5//WU/CLIMB TO @FL340@"), { min: 5, mrn: null, ra: "WU", text: "CLIMB TO FL340" });
  assert.deepEqual(parseCpdlc("/data2/7/3/NE/LOGON ACCEPTED"), { min: 7, mrn: 3, ra: "NE", text: "LOGON ACCEPTED" });
  assert.equal(parseCpdlc("garbage"), null);
});

const BRIEF = {
  source: "simbrief", fetchedAt: 0, error: null, problem: null, fixes: [],
  ofp: { aircraft: "A320", callsign: "QTR1" },
  airports: [{ role: "origin", icao: "OMDB" }, { role: "destination", icao: "OTHH" }],
} as unknown as Briefing;

function rig(replies: string[] = ["ok"], code = "LOGONCODE1", callsign: string | null = "QTR1") {
  const calls: URLSearchParams[] = [];
  const queue = [...replies];
  const f: HoppieFetch = async (_u, init) => {
    calls.push(new URLSearchParams(init.body));
    return { ok: true, status: 200, text: async () => queue.shift() ?? "ok" };
  };
  let now = 1_000_000;
  const svc = new HoppieService(f, () => code, () => callsign, () => true, async () => BRIEF, logger("test"), () => now);
  return { svc, calls, advance: (ms: number) => (now += ms) };
}

test("hoppie: telex goes out upper-cased with the logon code and callsign, and is logged", async () => {
  const { svc, calls } = rig();
  const r = await svc.run({ op: "telex", to: "eddf_twr", text: "request {frequency}" });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls[0]!.get("logon"), "LOGONCODE1");
  assert.equal(calls[0]!.get("from"), "QTR1");
  assert.equal(calls[0]!.get("to"), "EDDF_TWR");
  assert.equal(calls[0]!.get("type"), "telex");
  assert.equal(calls[0]!.get("packet"), "REQUEST FREQUENCY");
  assert.equal(svc.state().messages[0]!.dir, "out");
});

test("hoppie: nothing is sent without a code or a callsign, with a helpful reason", async () => {
  const noCode = rig(["ok"], "");
  const a = await noCode.svc.run({ op: "telex", to: "EDDF", text: "HI" });
  assert.ok(!a.ok && /logon code/.test(a.error));
  assert.equal(noCode.calls.length, 0);
  const noCs = rig(["ok"], "CODE123456", null);
  const b = await noCs.svc.run({ op: "telex", to: "EDDF", text: "HI" });
  assert.ok(!b.ok && /callsign/i.test(b.error));
});

test("hoppie: a poll collects telex, CPDLC and information, and hands each to listeners", async () => {
  const { svc } = rig(["ok {EGLL_DEL telex {CLEARED TO OTHH VIA DET1A}} {SERVER inforeq {METAR EGLL 131150Z 24012KT}} {EGLL_CTR cpdlc {/data2/9//WU/CONTACT @LONDON@ 132.050}} {QTR1 telex {ECHO}}"]);
  const heard: string[] = [];
  svc.onMessage((m) => heard.push(m.kind));
  await svc.poll();
  const s = svc.state();
  assert.deepEqual(s.messages.map((m) => m.kind), ["telex", "info", "cpdlc"], "own echo ignored");
  assert.deepEqual(heard, ["telex", "info", "cpdlc"]);
  assert.deepEqual(s.messages[2]!.answers, ["WILCO", "UNABLE", "STANDBY"]);
  assert.equal(s.messages[2]!.text, "CONTACT LONDON 132.050");
  assert.equal(s.error, null);
  assert.ok(s.lastPollAt);
});

test("hoppie: a wrong logon code is reported plainly", async () => {
  const { svc } = rig(["error {illegal logon code}"]);
  await svc.poll();
  assert.match(svc.state().error!, /logon code/);
  const r = await svc.run({ op: "poll" });
  assert.equal(r.ok, false);
});

test("hoppie: a CPDLC answer points back at the message, once, and only with a valid answer", async () => {
  const { svc, calls } = rig(["ok {EGLL_CTR cpdlc {/data2/9//WU/CLIMB TO FL340}}", "ok"]);
  await svc.poll();
  const id = svc.state().messages[0]!.id;
  const bad = await svc.run({ op: "cpdlcReply", id, answer: "AFFIRM" });
  assert.ok(!bad.ok);
  const ok = await svc.run({ op: "cpdlcReply", id, answer: "WILCO" });
  assert.deepEqual(ok, { ok: true });
  const last = calls[calls.length - 1]!;
  assert.equal(last.get("type"), "cpdlc");
  assert.equal(last.get("to"), "EGLL_CTR");
  assert.match(last.get("packet")!, /^\/data2\/\d+\/9\/N\/WILCO$/);
  assert.equal(svc.state().messages[0]!.answered, "WILCO");
  const again = await svc.run({ op: "cpdlcReply", id, answer: "UNABLE" });
  assert.ok(!again.ok && /Already answered/.test(again.error));
});

test("hoppie: PDC text comes from the SimBrief plan; weather requests go to SERVER", async () => {
  const { svc, calls } = rig();
  await svc.run({ op: "pdc", to: "omdb_del", stand: "b12", atis: "k" });
  assert.equal(calls[0]!.get("packet"), "REQUEST PREDEP CLEARANCE QTR1 A320 TO OTHH AT OMDB STAND B12 ATIS K");
  await svc.run({ op: "info", kind: "metar", icao: "othh" });
  assert.equal(calls[1]!.get("to"), "SERVER");
  assert.equal(calls[1]!.get("type"), "inforeq");
  assert.equal(calls[1]!.get("packet"), "metar OTHH");
  await svc.run({ op: "cpdlcLogon", to: "EGLL" });
  assert.match(calls[2]!.get("packet")!, /REQUEST LOGON$/);
  assert.equal(svc.state().logon, "EGLL");
});

test("hoppie: manual checks are spaced out", async () => {
  const { svc, calls, advance } = rig(["ok", "ok"]);
  assert.deepEqual(await svc.run({ op: "poll" }), { ok: true });
  const soon = await svc.run({ op: "poll" });
  assert.ok(!soon.ok);
  assert.equal(calls.length, 1);
  advance(25_000);
  assert.deepEqual(await svc.run({ op: "poll" }), { ok: true });
});
