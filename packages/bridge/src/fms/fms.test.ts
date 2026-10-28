import assert from "node:assert/strict";
import { test } from "node:test";
import { CDU_COLUMNS, CDU_ROWS, CduScreenSchema } from "@vbuddy/protocol";
import { logger } from "../log.js";
import { FenixMcdu, fenixCells, fenixKey, fenixScreen } from "./fenix-mcdu.js";
import { FmsHub, fmsKindFor, type FmsProvider } from "./hub.js";
import { MockMcdu } from "./mock-mcdu.js";
import { fbwCells, fbwKey, fbwScreen, SimBridgeMcdu, type FbwSide } from "./simbridge-mcdu.js";

const log = logger("test");

test("FlyByWire markup: colours, small font, spaces, nesting", () => {
  const c = fbwCells("{green}FL{small}370{end}{end}{sp}{amber}X");
  assert.equal(c.map((x) => x.ch).join(""), "FL370 X");
  assert.deepEqual(c.map((x) => x.color), [2, 2, 2, 2, 2, 0, 4]);
  assert.deepEqual(c.map((x) => x.small), [false, false, true, true, true, false, false]);
});

test("an A32NX screen lands in the 24 x 14 grid: title centred, labels small, columns aligned", () => {
  const side: FbwSide = {
    title: "INIT",
    titleLeft: "",
    page: "",
    scratchpad: "KSEA",
    arrows: [false, false, false, true],
    lines: [[" CO RTE", "FROM/TO  ", ""], ["{amber}__________{end}", "{cyan}VABB/OMDB{end}", ""], ...Array.from({ length: 10 }, () => ["", "", ""])],
  };
  const s = fbwScreen(side, 0, null);
  assert.ok(CduScreenSchema.safeParse(s).success);
  assert.equal(s.rows.length, CDU_ROWS);
  assert.ok(s.rows.every((r) => r.length === CDU_COLUMNS));
  assert.equal(s.rows[0]!.trim().startsWith("INIT"), true);
  assert.equal(s.rows[0]![23], "→");
  assert.equal(s.rows[2]!.slice(-9), "VABB/OMDB");
  assert.equal(s.colors[2]!.slice(-9), "111111111");
  assert.equal(s.flags[1]![1], "1"); // label line: small
  assert.equal(s.rows[13]!.slice(0, 4), "KSEA");
  assert.equal(fbwScreen(null, 1, "not running").message, "not running");
});

test("Fenix codes: lowercase letters set colour and size, specials become arrows and boxes", () => {
  const c = fenixCells("c£wINIT sFROMl/gTO#");
  assert.equal(c.map((x) => x.ch).join(""), "←INIT FROM/TO□");
  assert.equal(c[0]!.color, 1);
  assert.equal(c[1]!.color, 0);
  assert.equal(c.find((x) => x.ch === "F")!.small, true);
  assert.equal(c.find((x) => x.ch === "/")!.small, false);
  assert.equal(c[11]!.ch, "T");
  assert.equal(c[11]!.color, 2);
  const xml = `<root><title>wsl     INIT</title>${Array.from({ length: 12 }, (_, i) => `<line>${i === 1 ? "a##########" : ""}</line>`).join("")}<scratchpad>KSEA &amp; 1</scratchpad></root>`;
  const s = fenixScreen(xml, 1, null);
  assert.ok(CduScreenSchema.safeParse(s).success);
  assert.equal(s.live, true);
  assert.equal(s.rows[2]!.slice(0, 10), "□□□□□□□□□□");
  assert.equal(s.colors[2]![0], "4");
  assert.equal(s.rows[13]!.slice(0, 8), "KSEA Δ 1");
  assert.equal(fenixScreen(null, 0, "waiting").live, false);
});

test("key names: VBuddy's Airbus keys to FlyByWire's and the Fenix's", () => {
  assert.equal(fbwKey("SLASH"), "DIV");
  assert.equal(fbwKey("L3"), "L3");
  assert.equal(fbwKey("FUEL_PRED"), "FUEL");
  assert.equal(fenixKey("R6"), "LSK6R");
  assert.equal(fenixKey("CLR"), "CLEAR");
  assert.equal(fenixKey("OVFY"), "OVFLY");
  assert.equal(fenixKey("A"), "A");
});

test("a Fenix key is a write of 1 then 0 on the switch, keys one after another", async () => {
  const writes: string[] = [];
  const fx = new FenixMcdu(
    () => 8083,
    log,
    (async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body)) as { variables: { name: string; value: number } };
      writes.push(`${b.variables.name}=${b.variables.value}`);
      return new Response(JSON.stringify({ data: { dataRef: { writeInt: true } } }), { status: 200 });
    }) as typeof fetch,
  );
  const [a, b2] = await Promise.all([fx.key(0, "L1"), fx.key(1, "CLR")]);
  assert.ok(a.ok && b2.ok);
  assert.deepEqual(writes, ["system.switches.S_CDU1_KEY_LSK1L=1", "system.switches.S_CDU1_KEY_LSK1L=0", "system.switches.S_CDU2_KEY_CLEAR=1", "system.switches.S_CDU2_KEY_CLEAR=0"]);
  assert.equal((await fx.key(0, "NOPE")).ok, false);
});

test("Fenix subscription messages update the right screen", () => {
  const fx = new FenixMcdu(() => 8083, log);
  const seen: number[] = [];
  fx.onCdu((s) => seen.push(s));
  fx.onMessage(JSON.stringify({ type: "next", id: "x", payload: { data: { dataRefs: [{ name: "aircraft.mcdu2.display", value: "<r><title>wDIR</title></r>" }] } } }));
  assert.deepEqual(seen, [1]);
  assert.equal(fx.screen(1).live, true);
  assert.equal(fx.screen(0).live, false);
});

test("SimBridge updates land per side; a key goes out as event:<side>:<KEY>", async () => {
  const sent: string[] = [];
  const fake = { readyState: 1, send: (m: string) => sent.push(m), on: () => fake, close: () => {} } as unknown as import("ws").WebSocket;
  const sb = new SimBridgeMcdu(log, "ws://x", () => fake);
  sb.setActive(true);
  const blank = { lines: Array.from({ length: 12 }, () => ["", "", ""]), scratchpad: "", title: "PERF", titleLeft: "", page: "", arrows: [false, false, false, false] };
  sb.onMessage(`update:${JSON.stringify({ left: blank, right: { ...blank, title: "FPLN" } })}`);
  assert.match(sb.screen(1).rows[0]!, /FPLN/);
  assert.ok((await sb.key(1, "SLASH")).ok);
  assert.equal(sent.at(-1), "event:right:DIV");
  sb.setActive(false);
});

test("the hub follows the aircraft: PMDG, FlyByWire, Fenix, or nothing", async () => {
  assert.equal(fmsKindFor("FenixA320 IAE"), "fenix");
  assert.equal(fmsKindFor("FlyByWire A320neo (LEAP)"), "fbw");
  assert.equal(fmsKindFor("Headwind A330-900neo"), "fbw");
  assert.equal(fmsKindFor("PMDG 737-800"), "pmdg");
  assert.equal(fmsKindFor("Cessna 172"), null);
  const active: string[] = [];
  const mk = (label: string): FmsProvider => {
    const m = new MockMcdu();
    return { label, sides: () => 2, screen: (s) => m.screen(s), key: (s, k) => m.key(s, k), onCdu: (cb) => m.onCdu(cb), setActive: (on) => on && active.push(label) };
  };
  const hub = new FmsHub({ fenix: mk("Fenix MCDU"), fbw: mk("FlyByWire MCDU") }, () => null, log);
  let infos = 0;
  hub.onInfo(() => infos++);
  assert.equal(hub.info(), null);
  hub.aircraft("FenixA320");
  assert.deepEqual(hub.info(), { sides: 2, kind: "mcdu", name: "Fenix MCDU" });
  hub.aircraft("FlyByWire A320neo");
  assert.deepEqual(active, ["Fenix MCDU", "FlyByWire MCDU"]);
  assert.equal(infos, 2);
  hub.aircraft("Cessna 172");
  assert.equal(hub.screen(0), null);
  assert.equal((await hub.key(0, "A")).ok, false);
});
