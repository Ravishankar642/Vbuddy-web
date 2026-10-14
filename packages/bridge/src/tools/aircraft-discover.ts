/**
 * Aircraft control discovery (PMDG 737 / 777, iniBuilds A350 / A340 / A380, iFly 737 MAX, FSLabs A321 neo, anything else).
 *
 *   pnpm aircraft:discover                    watch everything it can find; operate the cockpit; Ctrl+C when done
 *   pnpm aircraft:discover -- --seconds 180   stop by itself after 3 minutes
 *   pnpm aircraft:discover -- --label pmdg737 name for the report file (default: made from the aircraft title)
 *   pnpm aircraft:discover -- --vars-file x.txt   also watch these L:vars (one per line, "L:" optional)
 *   pnpm aircraft:discover -- --lvar-filter REGEX   only watch listed L:vars whose name matches (case-insensitive), e.g. "ifly|mcp|fcu"
 *   pnpm aircraft:discover -- --area NAME     also watch this SimConnect client data area (repeatable)
 *   pnpm aircraft:discover -- --no-lvars | --no-input-events | --no-areas   skip a method
 *
 * Tests (run on the ground, autopilot off). Each puts the old value back afterwards:
 *   --test-lvar NAME [--delta 1]      add to an L:var
 *   --test-input NAME --value N       set a "B:" input event (the simulator's own list of cockpit controls)
 *   --test-event N [--param P]        send a PMDG-style third-party event number (e.g. 69632 + offset from the PMDG SDK header)
 *
 * Three independent ways to find controls are used, because add-on aircraft differ:
 *   1. INPUT EVENTS: the simulator lists these itself (names + current values). Reliable when the aircraft has them.
 *   2. CLIENT DATA AREAS: PMDG publishes its whole cockpit as a block of bytes. Watches which bytes change.
 *   3. L:VARS: SimConnect can't list them, so it asks the MobiFlight WASM module for the list (if installed)
 *      plus any names you give it, then watches them.
 *
 * Marking key presses (for finding what an MCDU / FMC key does): type a label in this window and press Enter, then press
 * that key once in the cockpit. Everything that changes in the next 2 seconds is printed under the label, and the report
 * gets a "marks" list and a "timeline" so each press can be matched to its variable. Example session:
 *     DIR <Enter>   (press DIR on the MCDU)     A <Enter>   (press the A key)     LSK1L <Enter>   (press line key 1 left) ...
 *
 * On exit it prints a summary and saves aircraft-report-<label>-<time>.json in the folder you ran it from. Share that file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ClientDataPeriod,
  ClientDataRequestFlag,
  DataRequestFlag,
  RawBuffer,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  type ConnectionHandle,
} from "node-simconnect";
import { connectSim, errText } from "../sim/connect.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clean = (n: string) => n.replace(/^L:/i, "").trim();
const fmt = (v: number | string | null) => (v === null ? "-" : typeof v === "string" ? JSON.stringify(v) : Number.isInteger(v) ? String(v) : v.toFixed(3));
const hex = (b: number) => b.toString(16).padStart(2, "0");

/** Client data areas published by add-ons. Sizes are probed in 64-byte chunks up to MAX_AREA_BYTES. */
const KNOWN_AREAS = ["PMDG_NG3_Data", "PMDG_NG3_Control", "PMDG_777X_Data", "PMDG_777X_Control", "PMDG_NG3_Data2", "PMDG_777X_Data2"];
/** L:var names known from other people's MobiFlight work, always watched (an aircraft's own variables often only appear in the module's list after they are first used). */
const KNOWN_LVARS = [
  // iFly 737 MAX (names from the community; MCP names come from the "add lvar for iFly 737 MAX8" mod if installed)
  "VC_Parking_Brake_SW_VAL",
  "VC_Parking_Brake_LIGHT_VAL",
  "VC_Gear_trigger_VAL",
  "VC_Miscellaneous_trigger_VAL",
  "VC_Autobrake_SW_VAL",
  "VC_Dome_Light_Display_VAL",
  "add_iFly_std_status",
  "add_iFly_bank_value",
];
const RELIST_EVERY_MS = 10_000;
const CHUNK = 64;
const MAX_AREA_BYTES = 16384;

interface Args {
  seconds: number;
  label: string | null;
  varsFile: string[];
  areas: string[];
  noLvars: boolean;
  noInput: boolean;
  noAreas: boolean;
  testLvar: string | null;
  testInput: string | null;
  testEvent: number | null;
  value: number | null;
  delta: number;
  param: number;
  lvarFilter: RegExp | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { seconds: 0, label: null, varsFile: [], areas: [], noLvars: false, noInput: false, noAreas: false, testLvar: null, testInput: null, testEvent: null, value: null, delta: 1, param: 0, lvarFilter: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${k} needs a value`);
      return v;
    };
    if (k === "--") continue;
    else if (k === "--seconds") a.seconds = Number(next());
    else if (k === "--label") a.label = next().replace(/[^\w.-]+/g, "_");
    else if (k === "--vars-file")
      a.varsFile.push(
        ...readFileSync(next(), "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#"))
          .map(clean),
      );
    else if (k === "--var") a.varsFile.push(clean(next()));
    else if (k === "--lvar-filter") a.lvarFilter = new RegExp(next(), "i");
    else if (k === "--area") a.areas.push(next());
    else if (k === "--no-lvars") a.noLvars = true;
    else if (k === "--no-input-events") a.noInput = true;
    else if (k === "--no-areas") a.noAreas = true;
    else if (k === "--test-lvar") a.testLvar = clean(next());
    else if (k === "--test-input") a.testInput = next();
    else if (k === "--test-event") a.testEvent = Number(next());
    else if (k === "--value") a.value = Number(next());
    else if (k === "--delta") a.delta = Number(next());
    else if (k === "--param") a.param = Number(next());
    else if (k === "--help" || k === "-h") {
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${k} (try --help)`);
  }
  return a;
}

interface Watched {
  name: string;
  first: number | string | null;
  value: number | string | null;
  changes: number;
  min: number;
  max: number;
}
const newWatched = (name: string): Watched => ({ name, first: null, value: null, changes: 0, min: Infinity, max: -Infinity });
/** Every change seen after watching started, in order, so a labelled key press can be matched to what moved. */
const timeline: Array<{ t: number; name: string; from: number | string; to: number | string }> = [];
const TIMELINE_MAX = 30_000;
function update(w: Watched, v: number | string, live: boolean, out: string[]) {
  if (w.first === null) w.first = v;
  if (w.value !== null && v !== w.value) {
    w.changes++;
    if (live) {
      out.push(`  ${w.name.padEnd(44)} ${fmt(w.value)} -> ${fmt(v)}`);
      if (timeline.length < TIMELINE_MAX) timeline.push({ t: Date.now(), name: w.name, from: w.value, to: v });
    }
  }
  w.value = v;
  if (typeof v === "number") {
    w.min = Math.min(w.min, v);
    w.max = Math.max(w.max, v);
  }
}

interface AreaState {
  name: string;
  id: number;
  chunks: Map<number, Buffer>; // chunk index -> latest bytes
  first: Map<number, Buffer>;
  changed: Map<number, { from: number; to: number; times: number }>; // byte offset -> change
  errors: number;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log("Connecting to MSFS...");
  let handle: ConnectionHandle;
  let simName: string;
  try {
    ({ handle, simName } = await connectSim("VBuddy Aircraft Discovery", null));
  } catch (e) {
    console.error(`Could not connect to MSFS: ${errText(e)}\nStart MSFS, load the aircraft into a flight (powered up), then run this again.`);
    process.exit(1);
  }
  console.log(`Connected to ${simName}.`);

  /* ---------- aircraft identity ---------- */
  const DEF_ID = 5;
  const REQ_ID = 5;
  const idVars = ["TITLE", "ATC MODEL", "ATC TYPE", "ATC AIRLINE", "ATC ID"];
  for (const v of idVars) handle.addToDataDefinition(DEF_ID, v, null, SimConnectDataType.STRING256);
  const ident: Record<string, string> = {};
  let title = "";
  handle.requestDataOnSimObject(REQ_ID, DEF_ID, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED);

  /* ---------- state ---------- */
  const live: string[] = [];
  let started = false;
  const inputs = new Map<string, Watched>(); // by name
  const inputMeta = new Map<string, { hash: bigint; type: number }>();
  const hashToName = new Map<bigint, string>();
  const lvars = new Map<string, Watched>();
  const lvarOrder: string[] = [];
  const areas: AreaState[] = [];
  let mfStatus = "not tried";
    let writeResult: unknown = null;

  /* ---------- L:var watching (chunks of 250 per definition) ---------- */
  const LV_BASE_DEF = 100;
  const LV_BASE_REQ = 100;
  const LV_PER = 250;
  const lvChunks: string[][] = [];
  let lvStarted = false;
  function watchLvars(names: string[]) {
    const fresh = names.filter((n) => !lvars.has(n));
    if (!fresh.length) return;
    for (let i = 0; i < fresh.length; i += LV_PER) {
      const chunk = fresh.slice(i, i + LV_PER);
      const idx = lvChunks.length;
      lvChunks.push(chunk);
      for (const n of chunk) {
        lvars.set(n, newWatched(n));
        lvarOrder.push(n);
        handle.addToDataDefinition(LV_BASE_DEF + idx, `L:${n}`, "number", SimConnectDataType.FLOAT64);
      }
      handle.requestDataOnSimObject(LV_BASE_REQ + idx, LV_BASE_DEF + idx, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME);
    }
    lvStarted = true;
  }

  handle.on("simObjectData", (r) => {
    if (r.requestID === REQ_ID) {
      const vals = idVars.map(() => r.data.readString256().trim());
      idVars.forEach((v, i) => (ident[v] = vals[i]!));
      const t = vals[0]!;
      if (t !== title) {
        title = t;
        console.log(`Aircraft: ${title || "(none loaded)"}   [model ${ident["ATC MODEL"] || "?"}, type ${ident["ATC TYPE"] || "?"}]`);
      }
      return;
    }
    const idx = r.requestID - LV_BASE_REQ;
    if (idx >= 0 && idx < lvChunks.length) {
      for (const n of lvChunks[idx]!) update(lvars.get(n)!, r.data.readFloat64(), started, live);
    }
  });

  /* ---------- 1. input events ---------- */
  if (!args.noInput) {
    handle.on("inputEventsList", (r) => {
      for (const d of r.inputEventDescriptors) {
        if (inputs.has(d.name)) continue;
        inputs.set(d.name, newWatched(d.name));
        inputMeta.set(d.name, { hash: d.inputEventIdHash, type: d.type });
        hashToName.set(d.inputEventIdHash, d.name);
      }
      if (r.entryNumber + r.arraySize >= r.outOf) {
        console.log(`Input events: the simulator lists ${inputs.size} for this aircraft.`);
        let n = 0;
        for (const [name, m] of inputMeta) {
          if (n++ >= 3000) break;
          handle.subscribeInputEvent(m.hash);
          void name;
        }
      }
    });
    const onValue = (hash: bigint, v: number | string) => {
      const name = hashToName.get(hash);
      if (name) update(inputs.get(name)!, v, started, live);
    };
    handle.on("subscribeInputEvent", (r) => onValue(r.inputEventIdHash, r.value));
    handle.enumerateInputEvents(1);
  }

  /* ---------- 2. client data areas (PMDG and friends) ---------- */
  const CD_BASE = 300;
  const areaNames = args.noAreas ? [] : [...new Set([...KNOWN_AREAS, ...args.areas])];
  areaNames.forEach((name, ai) => {
    const id = CD_BASE + ai;
    const a: AreaState = { name, id, chunks: new Map(), first: new Map(), changed: new Map(), errors: 0 };
    areas.push(a);
    handle.mapClientDataNameToID(name, id);
    for (let c = 0; c < MAX_AREA_BYTES / CHUNK; c++) {
      const def = 1000 + ai * 1000 + c;
      handle.addToClientDataDefinition(def, c * CHUNK, CHUNK);
      handle.requestClientData(id, 1000 + ai * 1000 + c, def, ClientDataPeriod.SECOND, ClientDataRequestFlag.CLIENT_DATA_REQUEST_FLAG_CHANGED);
    }
  });

  /* ---------- 3. L:vars through MobiFlight ----------
   * Protocol (MobiFlight WASM module README): send "MF.Clients.Add.<name>" on "MobiFlight.Command"; the module answers
   * "MF.Clients.Add.<name>.Finished" on "MobiFlight.Response" and creates "<name>.Command", "<name>.Response", "<name>.LVars".
   * Then send "MF.LVars.List" on "<name>.Command"; the names arrive one per message on "<name>.Response",
   * between "MF.LVars.List.Start" and "MF.LVars.List.End". */
  const CD_MF_CMD = 90;
  const CD_MF_RESP = 91;
  const CD_CL_CMD = 92;
  const CD_CL_RESP = 93;
  const CD_CL_LVARS = 94;
  const DEF_MF_WRITE = 80;
  const DEF_MF_READ = 81;
  const REQ_MF_RESP = 70;
  const REQ_CL_RESP = 71;
  const MF_CLIENT = "VBuddyDiscover";
  const MF_SIZE = 1024;
  const READ_SIZE = 256;
  let allListedLvars: string[] = [];
  const mfMessages: string[] = [];
  const mfClientMessages: string[] = [];
  const mfSend = (cd: number, text: string) => {
    const buf = Buffer.alloc(MF_SIZE);
    buf.write(text, "ascii");
    handle.setClientData(cd, DEF_MF_WRITE, 0, 0, MF_SIZE, buf);
  };
  const waitFor = async (list: string[], text: string, ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      if (list.includes(text)) return true;
      await sleep(100);
    }
    return list.includes(text);
  };
  async function mobiflightList() {
    mfStatus = "asked MobiFlight to register";
    handle.mapClientDataNameToID("MobiFlight.Command", CD_MF_CMD);
    handle.mapClientDataNameToID("MobiFlight.Response", CD_MF_RESP);
    handle.addToClientDataDefinition(DEF_MF_WRITE, 0, MF_SIZE);
    handle.addToClientDataDefinition(DEF_MF_READ, 0, READ_SIZE);
    handle.requestClientData(CD_MF_RESP, REQ_MF_RESP, DEF_MF_READ, ClientDataPeriod.ON_SET, ClientDataRequestFlag.CLIENT_DATA_REQUEST_FLAG_DEFAULT);
    await sleep(300);
    mfSend(CD_MF_CMD, "MF.DummyCmd"); // the module ignores the first command from a new connection
    await sleep(300);
    mfSend(CD_MF_CMD, `MF.Clients.Add.${MF_CLIENT}`);
    if (!(await waitFor(mfMessages, `MF.Clients.Add.${MF_CLIENT}.Finished`, 6000))) {
      mfStatus = "the MobiFlight WASM module didn't answer (not installed in the Community folder, or still loading); use --vars-file with names instead";
      console.log(`L:vars: ${mfStatus}.`);
      return;
    }
    handle.mapClientDataNameToID(`${MF_CLIENT}.Command`, CD_CL_CMD);
    handle.mapClientDataNameToID(`${MF_CLIENT}.Response`, CD_CL_RESP);
    handle.mapClientDataNameToID(`${MF_CLIENT}.LVars`, CD_CL_LVARS);
    handle.requestClientData(CD_CL_RESP, REQ_CL_RESP, DEF_MF_READ, ClientDataPeriod.ON_SET, ClientDataRequestFlag.CLIENT_DATA_REQUEST_FLAG_DEFAULT);
    await sleep(300);
    mfSend(CD_CL_CMD, "MF.DummyCmd");
    await sleep(300);
    mfSend(CD_CL_CMD, "MF.LVars.List");
    if (!(await waitFor(mfClientMessages, "MF.LVars.List.End", 15000))) {
      mfStatus = `MobiFlight answered but the list didn't finish (got ${mfClientMessages.length} messages)`;
    }
    const names = new Set<string>();
    let on = false;
    for (const m of mfClientMessages) {
      if (m === "MF.LVars.List.Start") on = true;
      else if (m === "MF.LVars.List.End") on = false;
      else if (on && /^[A-Za-z_][\w.:-]{1,}$/.test(m)) names.add(m.replace(/^L:/, ""));
    }
    allListedLvars = [...names];
    // Other add-ons' helper variables (GSX, camera and graphics tools) swamp the list; skip them unless a filter says otherwise.
    const NOISE = /^(FSDT_|GFX_|p42_|SIAI_|SIAI$)/;
    const wanted = [...names].filter((n) => (args.lvarFilter ? args.lvarFilter.test(n) : !NOISE.test(n)));
    if (names.size) {
      mfStatus = `MobiFlight listed ${names.size} L:vars (watching ${wanted.length})`;
      watchLvars(wanted);
      console.log(`L:vars: ${mfStatus}. Watching them.`);
    } else {
      console.log(`L:vars: ${mfStatus}; no names received (this aircraft may have none, or send them with --vars-file).`);
    }
    // An aircraft's own variables often only join the module's list once a control has been used, so ask again while you work.
    const relist = setInterval(() => {
      if (done) return clearInterval(relist);
      mfClientMessages.length = 0;
      mfSend(CD_CL_CMD, "MF.LVars.List");
      setTimeout(() => {
        const fresh = new Set<string>();
        let on = false;
        for (const m of mfClientMessages) {
          if (m === "MF.LVars.List.Start") on = true;
          else if (m === "MF.LVars.List.End") on = false;
          else if (on && /^[A-Za-z_][\w.:-]{1,}$/.test(m)) fresh.add(m.replace(/^L:/, ""));
        }
        const added = [...fresh].filter((n) => !lvars.has(n));
        if (added.length) {
          watchLvars(added);
          console.log(`L:vars: ${added.length} new name(s) appeared in the list (now watching ${lvars.size}): ${added.slice(0, 12).join(", ")}${added.length > 12 ? ", ..." : ""}`);
        }
      }, 3000);
    }, RELIST_EVERY_MS);
    relist.unref();
  }

  handle.on("clientData", (r) => {
    if (r.requestID === REQ_MF_RESP || r.requestID === REQ_CL_RESP) {
      const text = (r.data.readBytes(READ_SIZE).toString("latin1").split("\0")[0] ?? "").trim();
      if (text) (r.requestID === REQ_MF_RESP ? mfMessages : mfClientMessages).push(text);
      return;
    }
    // add-on client data areas: request id = 1000 + areaIndex*1000 + chunkIndex
    if (r.requestID >= 1000) {
      const ai = Math.floor((r.requestID - 1000) / 1000);
      const c = (r.requestID - 1000) % 1000;
      const a = areas[ai];
      if (!a) return;
      const bytes = Buffer.from(r.data.readBytes(CHUNK));
      const prev = a.chunks.get(c);
      if (!prev) a.first.set(c, bytes);
      else
        for (let i = 0; i < CHUNK; i++)
          if (prev[i] !== bytes[i]) {
            const off = c * CHUNK + i;
            const e = a.changed.get(off);
            if (e) {
              e.to = bytes[i]!;
              e.times++;
            } else a.changed.set(off, { from: prev[i]!, to: bytes[i]!, times: 1 });
            if (started) live.push(`  ${a.name} +0x${off.toString(16).padStart(4, "0")}`.padEnd(46) + ` ${hex(prev[i]!)} -> ${hex(bytes[i]!)}`);
          }
      a.chunks.set(c, bytes);
    }
  });

  handle.on("exception", (ex) => {
    // While probing, out-of-range chunks of a client data area and unknown names are expected; stay quiet about them.
    if (!started) return;
    console.warn(`SimConnect exception ${ex.exceptionName} (index ${ex.index})`);
  });
  handle.on("quit", () => finish("MSFS closed"));
  handle.on("close", () => finish("connection closed"));

  /* ---------- labelled key presses ---------- */
  const marks: Array<{ t: number; label: string }> = [];
  const MARK_WINDOW_MS = 2000;
  if (process.stdin.isTTY || process.env.VBUDDY_MARKS_FROM_STDIN) {
    process.stdin.setEncoding("utf8");
    let buf = "";
    process.stdin.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const label = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!label) continue;
        const t = Date.now();
        marks.push({ t, label });
        console.log(`  [mark ${label}] now press the key once...`);
        setTimeout(() => {
          const hits = timeline.filter((e) => e.t >= t && e.t < t + MARK_WINDOW_MS);
          const names = [...new Set(hits.map((e) => e.name))];
          console.log(`  [mark ${label}] ${names.length ? `${names.length} thing(s) changed: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", ..." : ""}` : "nothing changed (try again, or this key isn't visible this way)"}`);
        }, MARK_WINDOW_MS + 100);
      }
    });
  }

  const printer = setInterval(() => {
    if (live.length) console.log(live.splice(0, 200).join("\n"));
  }, 250);

  let done = false;
  function finish(reason: string) {
    if (done) return;
    done = true;
    clearInterval(printer);
    if (live.length) console.log(live.splice(0).join("\n"));
    console.log(`\nStopped (${reason}).\n`);

    const confirmedInputs = [...inputs.values()].filter((w) => w.changes > 0);
    const confirmedL = [...lvars.values()].filter((w) => w.changes > 0);
    console.log(`INPUT EVENTS: ${inputs.size} listed, ${confirmedInputs.length} changed while watching`);
    for (const w of confirmedInputs.slice(0, 80)) console.log(`  ${w.name.padEnd(48)} ${fmt(w.first)} .. ${fmt(w.value)}   changes ${w.changes}`);
    console.log(`\nL:VARS: ${lvars.size} watched (${mfStatus}), ${confirmedL.length} changed`);
    for (const w of confirmedL.slice(0, 80)) console.log(`  ${w.name.padEnd(48)} ${fmt(w.first)} .. ${fmt(w.value)}   changes ${w.changes}`);
    console.log("\nCLIENT DATA AREAS:");
    for (const a of areas) {
      const bytes = a.chunks.size * CHUNK;
      console.log(`  ${a.name.padEnd(20)} ${a.chunks.size ? `${bytes} bytes seen, ${a.changed.size} bytes changed` : "no data (not present, or the aircraft isn't broadcasting)"}`);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const label = args.label ?? (title.replace(/[^\w]+/g, "_").slice(0, 40) || "aircraft");
    const report = {
      generatedAt: new Date().toISOString(),
      sim: simName,
      aircraft: { title, ...ident },
      testResult: writeResult,
      marks,
      timeline: timeline.map((e) => ({ ...e, mark: marks.filter((m) => e.t >= m.t && e.t < m.t + MARK_WINDOW_MS).map((m) => m.label)[0] ?? null })).filter((e) => e.mark !== null || marks.length === 0).slice(0, 5000),
      inputEvents: {
        count: inputs.size,
        all: [...inputs.values()].map((w) => ({ name: w.name, type: inputMeta.get(w.name)?.type, first: w.first, last: w.value, changes: w.changes })),
      },
      lvars: {
        method: mfStatus,
        count: lvars.size,
        /** Every name MobiFlight listed, watched or not, so the right ones can be picked from it. */
        listed: allListedLvars,
        all: [...lvars.values()].map((w) => ({ name: w.name, first: w.first, last: w.value, min: w.min === Infinity ? null : w.min, max: w.max === -Infinity ? null : w.max, changes: w.changes })),
      },
      clientDataAreas: areas.map((a) => ({
        name: a.name,
        bytesSeen: a.chunks.size * CHUNK,
        changedBytes: [...a.changed.entries()]
          .sort((x, y) => x[0] - y[0])
          .map(([offset, e]) => ({ offset, hex: "0x" + offset.toString(16).padStart(4, "0"), from: e.from, to: e.to, times: e.times })),
        // first 256 bytes, to recognise the structure
        head: a.first.get(0)?.toString("hex") ?? null,
      })),
    };
    const file = join(process.env.INIT_CWD ?? process.cwd(), `aircraft-report-${label}-${stamp}.json`);
    try {
      writeFileSync(file, JSON.stringify(report, null, 1));
      console.log(`\nSaved ${file}`);
    } catch (e) {
      console.error(`Couldn't save the report: ${errText(e)}`);
    }
    try {
      handle.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  }
  process.on("SIGINT", () => finish("Ctrl+C"));
  if (args.seconds > 0) setTimeout(() => finish(`${args.seconds}s elapsed`), args.seconds * 1000);

  /* ---------- go ---------- */
  watchLvars([...KNOWN_LVARS, ...args.varsFile]);
  if (args.testLvar) watchLvars([args.testLvar]);
  if (!args.noLvars) void mobiflightList().catch((e) => (mfStatus = `MobiFlight step failed: ${errText(e)}`));
  await sleep(4000);
  started = true;

  /* ---------- tests ---------- */
  if (args.testLvar) {
    const name = args.testLvar;
    const DEF_W = 12;
    handle.addToDataDefinition(DEF_W, `L:${name}`, "number", SimConnectDataType.FLOAT64);
    const write = (v: number) => {
      const b = new RawBuffer(8);
      b.writeFloat64(v);
      handle.setDataOnSimObject(DEF_W, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
    };
    const before = Number(lvars.get(name)?.value ?? 0);
    console.log(`\nTEST L:${name}: ${fmt(before)} -> ${fmt(before + args.delta)} (watch the cockpit)`);
    write(before + args.delta);
    await sleep(2500);
    const after = lvars.get(name)?.value ?? null;
    write(before);
    await sleep(1000);
    writeResult = { kind: "lvar", name, delta: args.delta, before, afterWrite: after };
    console.log(`TEST: variable read back ${fmt(after)}; restored ${fmt(before)}. Did the control move in the cockpit?\n`);
  }
  if (args.testInput) {
    const m = inputMeta.get(args.testInput);
    if (!m) console.log(`\nTEST: no input event named "${args.testInput}" in this aircraft's list.`);
    else if (args.value === null) console.log("\nTEST: add --value N.");
    else {
      const before = inputs.get(args.testInput)?.value ?? null;
      console.log(`\nTEST input ${args.testInput}: ${fmt(before)} -> ${args.value}`);
      handle.setInputEvent(m.hash, args.value);
      await sleep(2500);
      const after = inputs.get(args.testInput)?.value ?? null;
      if (before !== null) handle.setInputEvent(m.hash, before);
      await sleep(1000);
      writeResult = { kind: "input", name: args.testInput, before, requested: args.value, afterWrite: after };
      console.log(`TEST: read back ${fmt(after)}; restored ${fmt(before)}. Did the control move in the cockpit?\n`);
    }
  }
  if (args.testEvent !== null) {
    const EVT = 9000;
    handle.mapClientEventToSimEvent(EVT, `#${args.testEvent}`);
    handle.addClientEventToNotificationGroup(61, EVT, false);
    handle.setNotificationGroupPriority(61, 1);
    handle.transmitClientEvent(SimConnectConstants.OBJECT_ID_USER, EVT, args.param, 61, 0);
    console.log(`\nTEST event #${args.testEvent} param ${args.param} sent. Did the control move in the cockpit?\n`);
    writeResult = { kind: "event", number: args.testEvent, param: args.param };
    await sleep(2500);
  }

  console.log("\nNow operate the cockpit: turn each knob a few clicks both ways, push/pull, press every button you want in the app,");
  console.log("flip switches (autopilot, autothrottle, FD, gear, flaps lever, lights). Changes print below. Press Ctrl+C when done.\n");
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
