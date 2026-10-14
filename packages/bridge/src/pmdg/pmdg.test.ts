import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { LightId, PanelState, SimStatus } from "@vbuddy/protocol";
import { logger } from "../log.js";
import type { PanelBackend } from "../panel/backend.js";
import { PmdgPanel } from "./pmdg-panel.js";
import { parseHeader, readField } from "./sdk.js";

/** A made-up header in the same shape as PMDG's (not PMDG's file). */
const HEADER = `
// synthetic test header
#define THIRD_PARTY_EVENT_ID_MIN 0x00011000
#define MOUSE_FLAG_RIGHTSINGLE 0x80000000
#define MOUSE_FLAG_LEFTSINGLE  0x20000000 /* comment */
#define PMDG_NG3_DATA_NAME "PMDG_NG3_Data"
#define PMDG_NG3_CONTROL_NAME "PMDG_NG3_Control"
#define N_RESERVED 400
#define EVT_OH_ELEC_BATTERY_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 1)
#define EVT_MCP_CMD_A_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 402)
#define EVT_MCP_HEADING_SELECTOR (THIRD_PARTY_EVENT_ID_MIN + 390)
#define EVT_MCP_ALTITUDE_SELECTOR (THIRD_PARTY_EVENT_ID_MIN + 392)
#define EVT_MCP_HDG_SEL_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 404)
#define EVT_MCP_LNAV_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 405)
#define EVT_OH_LIGHT_TAXI_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 50)
#define EVT_OH_LIGHT_POSITION_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 51)
#define EVT_OH_LIGHT_LANDING_RETRACT_L_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 52)
#define EVT_OH_LIGHT_LANDING_FIXED_L_SWITCH (THIRD_PARTY_EVENT_ID_MIN + 53)
#define EVT_OH_LIGHT_DOME_BRIGHT_KNOB (THIRD_PARTY_EVENT_ID_MIN + 54)
#define EVT_CDU_L_L1 (THIRD_PARTY_EVENT_ID_MIN + 534)
#define EVT_CDU_L_EXEC (THIRD_PARTY_EVENT_ID_MIN + 556)
#define EVT_CDU_L_A (THIRD_PARTY_EVENT_ID_MIN + 573)
#define EVT_CDU_L_BRITENESS (THIRD_PARTY_EVENT_ID_MIN + 605)
#define EVT_CDU_R_L1 (THIRD_PARTY_EVENT_ID_MIN + 606)

struct PMDG_NG3_Data
{
  float MCP_IASMach;           // Mach if < 10
  unsigned short MCP_Course[2];
  unsigned short MCP_Heading;
  short MCP_VertSpeed;
  unsigned short MCP_Altitude;
  bool MCP_annunCMD_A, MCP_annunCMD_B;
  bool MCP_annunHDG_SEL;
  bool MCP_annunLNAV;
  bool MCP_annunFD[2];
  bool CDU_annunEXEC[2];
  unsigned char MCP_ATArmSw;
  unsigned char reserved[N_RESERVED];
};
`;

const ok = async (p: Promise<{ ok: boolean; error?: string }>) => {
  const r = await p;
  if (!r.ok) console.log("FAILED:", r.error);
  return r.ok;
};

test("the header's events, mouse flags and layout are read", () => {
  const sdk = parseHeader(HEADER, "PMDG_NG3_Data");
  assert.equal(sdk.events.get("EVT_MCP_CMD_A_SWITCH"), 0x11000 + 402);
  assert.equal(sdk.events.get("EVT_MCP_HEADING_SELECTOR"), 70022);
  assert.equal(sdk.mouse.get("MOUSE_FLAG_LEFTSINGLE"), 0x20000000);
  assert.equal(sdk.mouse.get("MOUSE_FLAG_RIGHTSINGLE"), 0x80000000);
  assert.equal(sdk.dataName, "PMDG_NG3_Data");
  assert.equal(sdk.controlName, "PMDG_NG3_Control");
  const l = sdk.layout!;
  assert.equal(l.fields.get("MCP_IASMach")!.offset, 0);
  assert.equal(l.fields.get("MCP_Course")!.offset, 4);
  assert.deepEqual(l.fields.get("MCP_Course")!.dims, [2]);
  assert.equal(l.fields.get("MCP_Heading")!.offset, 8);
  assert.equal(l.fields.get("MCP_VertSpeed")!.offset, 10);
  assert.equal(l.fields.get("MCP_Altitude")!.offset, 12);
  assert.equal(l.fields.get("MCP_annunCMD_B")!.offset, 15);
  assert.equal(l.fields.get("MCP_annunFD")!.offset, 18);
  assert.equal(l.fields.get("reserved")!.dims[0], 400);
  assert.equal(l.size, 424); // 20 + 400 rounded up to 4
  const buf = Buffer.alloc(l.size);
  buf.writeInt16LE(-1500, 10);
  assert.equal(readField(l, buf, l.fields.get("MCP_VertSpeed")!), -1500);
});

test("a layout it can't work out is reported, not guessed", () => {
  const sdk = parseHeader("struct PMDG_NG3_Data { struct Inner { int a; } x; };", "PMDG_NG3_Data");
  assert.equal(sdk.layout, null);
  assert.ok(sdk.layoutError);
});

/* ---------------------------------------------------------------- a pretend simulator with a pretend PMDG in it */

interface Opts {
  /** +1 if a right click raises the window, -1 if it lowers it. */
  rightIs?: 1 | -1;
  /** Position-light positions that turn the nav light on (3-position switch). */
  navOn?: number[];
  /** The aircraft sends its CDU screens (EnableCDUBroadcast on). */
  cdu?: boolean;
}

function rig(title: string, opts: Opts = {}, header: string | null = HEADER) {
  const sdk = parseHeader(HEADER, "PMDG_NG3_Data");
  const l = sdk.layout!;
  const aircraft = Buffer.alloc(l.size);
  const set = (name: string, v: number, i = 0) => {
    const f = l.fields.get(name)!;
    const at = f.offset + i * f.size;
    if (f.float) aircraft.writeFloatLE(v, at);
    else if (f.size === 1) aircraft.writeUInt8(v, at);
    else if (f.signed) aircraft.writeInt16LE(v, at);
    else aircraft.writeUInt16LE(v, at);
  };
  const get = (name: string, i = 0) => readField(l, aircraft, l.fields.get(name)!, i);
  set("MCP_IASMach", 250);
  set("MCP_Heading", 90);
  set("MCP_Altitude", 10000);
  set("MCP_VertSpeed", 0);

  const requests: Array<{ id: number; off: number; len: number; cd: number }> = [];
  const defs = new Map<number, { off: number; len: number }>();
  const sent: Array<{ event: number; param: number }> = [];
  const lights: Record<string, boolean> = {};
  let position = 1;
  const rightIs = opts.rightIs ?? 1;
  const navOn = opts.navOn ?? [2, 0];

  const h = new EventEmitter() as EventEmitter & Record<string, unknown>;
  // CDU 0's screen: 24 x 14 cells of (symbol, colour, flags), column by column, then Powered.
  const cdu = Buffer.alloc(24 * 14 * 3 + 1);
  const areaNames = new Map<number, string>();
  const emitAll = () =>
    setImmediate(() => {
      for (const r of requests) {
        const area = areaNames.get(r.cd) ?? "";
        if (/_CDU_/.test(area) && (!opts.cdu || !area.endsWith("_0"))) continue;
        const src = /_CDU_/.test(area) ? cdu : aircraft;
        h.emit("clientData", { requestID: r.id, data: { readBytes: (n: number) => src.subarray(r.off, r.off + n) } });
      }
    });
  h.mapClientDataNameToID = (name: string, id: number) => (areaNames.set(id, name), 0);
  h.addToClientDataDefinition = (def: number, off: number, len: number) => (defs.set(def, { off, len }), 0);
  h.requestClientData = (cd: number, id: number, def: number) => {
    const d = defs.get(def)!;
    requests.push({ id, off: d.off, len: d.len, cd });
    emitAll();
    return 0;
  };
  const ev = (n: string) => sdk.events.get(n)!;
  // PMDG's "method 2": events mapped as "#<number>" and transmitted (as PMDG_NG3_ConnectionTest.cpp does).
  const evMap = new Map<number, number>();
  const flags: number[] = [];
  h.mapClientEventToSimEvent = (id: number, name: string) => (evMap.set(id, Number(name.replace("#", ""))), 0);
  h.transmitClientEvent = (_obj: number, id: number, param: number, group: number, flag: number) => {
    flags.push(group, flag);
    apply(evMap.get(id)!, param);
    return 0;
  };
  const apply = (event: number, param: number) => {
    sent.push({ event, param });
    // Knobs turn with the mouse wheel (PMDG's sample); switches act on the left click.
    const right = param === 0x4000;
    const wheelDown = param === 0x2000;
    const left = param === 0x20000000;
    if (event === ev("EVT_MCP_HEADING_SELECTOR") && (right || wheelDown)) set("MCP_Heading", (get("MCP_Heading") + (right ? rightIs : -rightIs) + 360) % 360);
    if (event === ev("EVT_MCP_ALTITUDE_SELECTOR") && (right || wheelDown)) set("MCP_Altitude", get("MCP_Altitude") + (right ? rightIs : -rightIs) * 100);
    // PMDG's direct "set" events (only in the headers that define them)
    if (event === 0x11000 + 14504) set("MCP_Heading", param);
    if (event === 0x11000 + 14505) set("MCP_Altitude", param);
    if (event === 0x11000 + 14506) set("MCP_VertSpeed", param - 10000);
    if (event === ev("EVT_MCP_CMD_A_SWITCH") && left) set("MCP_annunCMD_A", get("MCP_annunCMD_A") ? 0 : 1);
    // HDG SEL does nothing (mode not available); LNAV works
    if (event === ev("EVT_MCP_LNAV_SWITCH") && left) set("MCP_annunLNAV", get("MCP_annunLNAV") ? 0 : 1);
    if (event === ev("EVT_OH_LIGHT_TAXI_SWITCH") && param <= 1) lights.taxi = param === 1;
    if (event === ev("EVT_OH_LIGHT_POSITION_SWITCH") && param <= 2) {
      position = param;
      lights.nav = navOn.includes(position);
      lights.strobe = position === 0;
      base.fire();
    }
    if (event === ev("EVT_OH_LIGHT_LANDING_RETRACT_L_SWITCH")) lights.landing = param === 2 ? true : param === 0 ? false : !!lights.landing;
    if (event === ev("EVT_OH_LIGHT_LANDING_FIXED_L_SWITCH") && param <= 1) lights.landing = param === 1 ? true : !!lights.landing && false;
    base.fire();
    emitAll();
    return 0;
  };

  const baseCbs: Array<() => void> = [];
  const base = {
    stdCalls: [] as string[],
    state(): PanelState {
      return {
        aircraft: status.aircraftTitle,
        family: "other",
        lights: Object.fromEntries(["nav", "beacon", "strobe", "landing", "taxi", "wing", "logo", "recognition", "cabin", "panel"].map((k) => [k, !!lights[k]])) as PanelState["lights"],
        ap: null,
        note: null,
      };
    },
    onChange: (cb: () => void) => void baseCbs.push(cb),
    fire: () => baseCbs.forEach((cb) => cb()),
    async setLight(id: LightId) {
      this.stdCalls.push(`light ${id}`);
      return { ok: false as const, error: "base: ignored" };
    },
    async press(ctl: string) {
      this.stdCalls.push(`press ${ctl}`);
      return { ok: true as const };
    },
    async set(ctl: string) {
      this.stdCalls.push(`set ${ctl}`);
      return { ok: true as const };
    },
    async sys() {
      return { ok: true as const };
    },
  } satisfies PanelBackend & { fire(): void; stdCalls: string[] };

  const status: SimStatus = { connected: true, source: "simconnect", paused: false, aircraftTitle: "", detail: "" };
  let onHandle: (x: unknown) => void = () => {};
  let onStatus: (s: SimStatus) => void = () => {};
  const sim = {
    onHandle: (cb: (x: unknown) => void) => (onHandle = cb),
    onStatus: (cb: (s: SimStatus) => void) => (onStatus = cb),
    status: () => status,
  };
  const panel = new PmdgPanel(sim as never, base as never, logger("test"), { load: () => (header === null ? null : { path: "test.h", text: header }), speed: 80 });
  onHandle(h);
  const load = async () => {
    status.aircraftTitle = title;
    onStatus({ ...status });
    for (let i = 0; i < 60 && !panel.state()?.ap && title.startsWith("737"); i++) await new Promise((r) => setTimeout(r, 5));
  };
  const poke = (name: string, v: number) => {
    set(name, v);
    emitAll();
  };
  const cduWrite = (x: number, y: number, text: string, color = 0, flag = 0) => {
    for (let i = 0; i < text.length; i++) {
      const at = ((x + i) * 14 + y) * 3;
      cdu[at] = text.charCodeAt(i);
      cdu[at + 1] = color;
      cdu[at + 2] = flag;
    }
  };
  const cduPower = (on: boolean) => {
    cdu[cdu.length - 1] = on ? 1 : 0;
    emitAll();
  };
  return { panel, base, sent, get, poke, lights, load, sdk, flags, cduWrite, cduPower, areaNames };
}

test("a PMDG 737 reports its autopilot from the aircraft's own data", async () => {
  const r = rig("737-800 PAX BW SC");
  await r.load();
  const st = r.panel.state()!;
  assert.equal(st.family, "boeing");
  assert.equal(st.ap!.hdg, 90);
  assert.equal(st.ap!.alt, 10000);
  assert.equal(st.ap!.spd, 250);
  assert.equal(st.ap!.master, false);
});

test("knobs find out which way a click turns and how far", async () => {
  const r = rig("737-800 PAX BW SC", { rightIs: -1 });
  await r.load();
  const res = await r.panel.set("hdg", 100);
  assert.equal(res.ok, true);
  assert.equal(r.get("MCP_Heading"), 100);
  const alt = await r.panel.set("alt", 12000);
  assert.equal(alt.ok, true);
  assert.equal(r.get("MCP_Altitude"), 12000);
  assert.equal(await ok(r.panel.set("hdg", 80)), true);
  assert.equal(r.get("MCP_Heading"), 80);
});

test("heading wraps the short way round", async () => {
  const r = rig("737-800 PAX BW SC");
  await r.load();
  r.poke("MCP_Heading", 355);
  await new Promise((x) => setTimeout(x, 20));
  assert.equal(await ok(r.panel.set("hdg", 5)), true);
  assert.equal(r.get("MCP_Heading"), 5);
});

test("knobs use PMDG's direct set events when the header has them: one event, no turning", async () => {
  const withSet = HEADER.replace("#define EVT_MCP_HDG_SEL_SWITCH", "#define EVT_MCP_HDG_SET (THIRD_PARTY_EVENT_ID_MIN + 14504)\n#define EVT_MCP_ALT_SET (THIRD_PARTY_EVENT_ID_MIN + 14505)\n#define EVT_MCP_VS_SET (THIRD_PARTY_EVENT_ID_MIN + 14506)\n#define EVT_MCP_HDG_SEL_SWITCH");
  const r = rig("737-800 PAX BW SC", {}, withSet);
  await r.load();
  assert.equal(await ok(r.panel.set("hdg", 275)), true);
  assert.equal(r.get("MCP_Heading"), 275);
  assert.equal(await ok(r.panel.set("alt", 37000)), true);
  assert.equal(r.get("MCP_Altitude"), 37000);
  assert.equal(await ok(r.panel.set("vs", -1800)), true);
  assert.equal(r.get("MCP_VertSpeed"), -1800);
  assert.deepEqual(r.sent.map((x) => x.param), [275, 37000, 8200]);
});

test("the CDU screen is read the way PMDG's CDU sample reads it", async () => {
  const r = rig("737-800 PAX BW SC", { cdu: true });
  r.cduWrite(0, 0, "ROUTE", 2);
  r.cduWrite(0, 1, "\xa1ABC\xa2", 1, 1);
  await r.load();
  assert.ok([...r.areaNames.values()].includes("PMDG_NG3_CDU_0") && [...r.areaNames.values()].includes("PMDG_NG3_CDU_1"));
  r.cduPower(true);
  const changed = await new Promise<number>((done) => r.panel.onCdu(done));
  assert.equal(changed, 0);
  const s = r.panel.screen(0)!;
  assert.equal(s.live, true);
  assert.equal(s.powered, true);
  assert.equal(s.rows.length, 14);
  assert.equal(s.rows[0], "ROUTE".padEnd(24));
  assert.equal(s.colors[0]!.slice(0, 5), "22222");
  assert.equal(s.rows[1]!.slice(0, 5), "←ABC→");
  assert.equal(s.flags[1]![0], "1");
  assert.deepEqual(s.keys, ["L1", "EXEC", "A"]);
  assert.equal(r.panel.state()!.cdu?.sides, 2);
});

test("a CDU that isn't broadcasting says which lines to add to the options file", async () => {
  const r = rig("737-800 PAX BW SC");
  await r.load();
  await new Promise((x) => setTimeout(x, 80));
  const s = r.panel.screen(1)!;
  assert.equal(s.live, false);
  assert.match(s.message ?? "", /737_Options\.ini.*EnableCDUBroadcast\.0=1, EnableCDUBroadcast\.1=1/);
});

test("CDU keys are pressed like PMDG's sample presses a switch: click, then release", async () => {
  const r = rig("737-800 PAX BW SC", { cdu: true });
  await r.load();
  assert.equal((await r.panel.key(1, "L1")).ok, true);
  const n = r.sdk.events.get("EVT_CDU_R_L1");
  assert.deepEqual(r.sent.filter((x) => x.event === n).map((x) => x.param), [0x20000000, 0x00020000]);
  assert.equal((await r.panel.key(0, "NOPE")).ok, false);
});

test("buttons send the click and are checked against the MCP light", async () => {
  const r = rig("737-800 PAX BW SC");
  await r.load();
  assert.equal(await ok(r.panel.press("cmd")), true);
  assert.equal(r.panel.state()!.ap!.master, true);
  assert.equal(await ok(r.panel.press("lnav")), true);
  const bad = await r.panel.press("hdgSel");
  assert.equal(bad.ok, false);
  assert.match((bad as { error: string }).error, /HDG SEL.*light didn't change/);
  // the click carried PMDG's left-click flag and the event number from the header
  assert.ok(r.sent.some((s) => s.event === r.sdk.events.get("EVT_MCP_CMD_A_SWITCH") && s.param === 0x20000000));
  // ...followed by the release, as PMDG's sample does
  assert.ok(r.sent.some((s) => s.event === r.sdk.events.get("EVT_MCP_CMD_A_SWITCH") && s.param === 0x00020000));
  // Sent at the highest priority with GROUPID_IS_PRIORITY (16), as PMDG's sample does.
  assert.deepEqual([...new Set(r.flags)].sort(), [1, 16]);
});

test("a button the header doesn't have says so", async () => {
  const r = rig("737-800 PAX BW SC");
  await r.load();
  const res = await r.panel.press("vs");
  assert.equal(res.ok, false);
  assert.match((res as { error: string }).error, /Couldn't find the V\/S button/);
});

test("lights use the PMDG switch events and are checked against the simulator", async () => {
  const r = rig("737-800 PAX BW SC");
  await r.load();
  assert.equal(await ok(r.panel.setLight("taxi", true)), true);
  assert.equal(r.lights.taxi, true);
  assert.equal(await ok(r.panel.setLight("taxi", false)), true);
  assert.equal(r.lights.taxi, false);
  // retractable landing light needs position 2
  assert.equal(await ok(r.panel.setLight("landing", true)), true);
  assert.equal(r.lights.landing, true);
});

test("a three-position light switch is searched for the position that works", async () => {
  const r = rig("737-800 PAX BW SC", { navOn: [2] });
  await r.load();
  assert.equal(await ok(r.panel.setLight("nav", true)), true);
  assert.equal(r.lights.nav, true);
  assert.equal(await ok(r.panel.setLight("nav", false)), true);
  assert.equal(r.lights.nav, false);
});

test("a light PMDG has no switch for falls back to the standard command", async () => {
  const r = rig("737-800 PAX BW SC");
  await r.load();
  const res = await r.panel.setLight("cabin", true);
  assert.equal(res.ok, false);
  assert.deepEqual(r.base.stdCalls, ["light cabin"]);
});

test("another aircraft is left to the standard panel", async () => {
  const r = rig("Fenix A320");
  await r.load();
  assert.equal(r.panel.state()!.family, "other");
  await r.panel.press("cmd");
  assert.deepEqual(r.base.stdCalls, ["press cmd"]);
});

test("without the SDK file the standard panel (Cobalt's PMDG event numbers) takes over and the app says where the file goes", async () => {
  const r = rig("737-800 PAX BW SC", {}, null);
  await r.load();
  const st = r.panel.state()!;
  assert.equal(st.family, "boeing");
  assert.match(st.note ?? "", /PMDG_NG3_SDK\.h.*%APPDATA%\\VBuddy\\sdk/);
  await r.panel.press("cmd");
  assert.deepEqual(r.base.stdCalls, ["press cmd"]);
});
