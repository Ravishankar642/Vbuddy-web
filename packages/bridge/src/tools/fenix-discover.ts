/**
 * Fenix A320 variable discovery.
 *
 *   pnpm fenix:discover                       watch candidates; turn knobs in the cockpit
 *   pnpm fenix:discover -- --seconds 120      stop automatically after 2 minutes
 *   pnpm fenix:discover -- --var MY_LVAR      add extra names (repeatable)
 *   pnpm fenix:discover -- --vars-file x.txt  add names from a file (one per line)
 *   pnpm fenix:discover -- --test-write E_FCU_HEADING
 *        writes +1 to that variable, waits, then writes the old value back,
 *        and reports what moved. This checks whether VBuddy can turn a Fenix
 *        knob directly through SimConnect (no MobiFlight module needed).
 *
 * On exit it prints a summary and saves fenix-report-<time>.json in the folder
 * you ran it from. Share that file to build the Fenix cockpit adapter.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DataRequestFlag, RawBuffer, SimConnectConstants, SimConnectDataType, SimConnectPeriod, type ConnectionHandle } from "node-simconnect";
import { connectSim, errText } from "../sim/connect.js";
import { FENIX_CANDIDATES } from "./fenix-candidates.js";

const DEF_READ = 10;
const DEF_TITLE = 11;
const DEF_WRITE = 12;
const REQ_READ = 10;
const REQ_TITLE = 11;
const PRINT_EVERY_MS = 250;

interface Track {
  name: string;
  group: string;
  first: number | null;
  value: number | null;
  min: number;
  max: number;
  changes: number;
  lastChange: number | null;
}

function parseArgs(argv: string[]) {
  const extra: string[] = [];
  let seconds = 0;
  let testWrite: string | null = null;
  let delta = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--") continue;
    else if (a === "--var") extra.push(next());
    else if (a === "--vars-file")
      extra.push(
        ...readFileSync(next(), "utf8")
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !s.startsWith("#")),
      );
    else if (a === "--seconds") seconds = Number(next());
    else if (a === "--test-write") testWrite = next();
    else if (a === "--delta") delta = Number(next());
    else if (a === "--help" || a === "-h") {
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
      process.exit(0);
    } else throw new Error(`unknown argument ${a} (try --help)`);
  }
  const clean = (n: string) => n.replace(/^L:/i, "").trim();
  return { extra: extra.map(clean), seconds, testWrite: testWrite ? clean(testWrite) : null, delta };
}

const fmt = (v: number | null) => (v === null ? "-" : Number.isInteger(v) ? String(v) : v.toFixed(3));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const tracks: Track[] = [];
  const seen = new Set<string>();
  const add = (name: string, group: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    tracks.push({ name, group, first: null, value: null, min: Infinity, max: -Infinity, changes: 0, lastChange: null });
  };
  for (const [group, names] of Object.entries(FENIX_CANDIDATES)) for (const n of names) add(n, group);
  for (const n of args.extra) add(n, "extra");
  if (args.testWrite) add(args.testWrite, "extra");

  console.log("Connecting to MSFS...");
  let handle: ConnectionHandle;
  let simName: string;
  try {
    ({ handle, simName } = await connectSim("VBuddy Fenix Discovery", null));
  } catch (e) {
    console.error(`Could not connect to MSFS: ${errText(e)}\nStart MSFS, load the Fenix A320 into a flight, then run this again.`);
    process.exit(1);
  }
  console.log(`Connected to ${simName}. Watching ${tracks.length} variables.`);

  let title = "";
  let writeResult: unknown = null;
  let started = false;
  const pending: string[] = [];

  for (const t of tracks) handle.addToDataDefinition(DEF_READ, `L:${t.name}`, "number", SimConnectDataType.FLOAT64);
  handle.addToDataDefinition(DEF_TITLE, "TITLE", null, SimConnectDataType.STRING256);
  handle.requestDataOnSimObject(REQ_READ, DEF_READ, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SIM_FRAME);
  handle.requestDataOnSimObject(REQ_TITLE, DEF_TITLE, SimConnectConstants.OBJECT_ID_USER, SimConnectPeriod.SECOND, DataRequestFlag.DATA_REQUEST_FLAG_CHANGED);

  handle.on("simObjectData", (r) => {
    if (r.requestID === REQ_TITLE) {
      const t = r.data.readString256().trim();
      if (t !== title) {
        title = t;
        console.log(`Aircraft: ${title || "(none loaded)"}`);
        if (title && !/fenix/i.test(title)) console.log("  (this doesn't look like the Fenix; results will mostly be zeros)");
      }
      return;
    }
    if (r.requestID !== REQ_READ) return;
    const now = Date.now();
    for (const t of tracks) {
      const v = r.data.readFloat64();
      if (t.first === null) t.first = v;
      if (t.value !== null && v !== t.value) {
        t.changes++;
        t.lastChange = now;
        if (started) pending.push(`  ${t.name.padEnd(28)} ${fmt(t.value)} -> ${fmt(v)}`);
      }
      t.value = v;
      t.min = Math.min(t.min, v);
      t.max = Math.max(t.max, v);
    }
    started = true;
  });
  handle.on("exception", (ex) => console.warn(`SimConnect exception ${ex.exceptionName} (index ${ex.index})`));
  handle.on("quit", () => finish("MSFS closed"));
  handle.on("close", () => finish("connection closed"));

  const printer = setInterval(() => {
    if (pending.length) console.log(pending.splice(0).join("\n"));
  }, PRINT_EVERY_MS);

  let done = false;
  function finish(reason: string) {
    if (done) return;
    done = true;
    clearInterval(printer);
    if (pending.length) console.log(pending.splice(0).join("\n"));
    console.log(`\nStopped (${reason}).\n`);

    const live = tracks.filter((t) => t.changes > 0);
    const nonzero = tracks.filter((t) => t.changes === 0 && t.value !== null && t.value !== 0);
    const silent = tracks.filter((t) => t.changes === 0 && (t.value === null || t.value === 0));

    const row = (t: Track) =>
      `  ${t.name.padEnd(28)} now ${fmt(t.value).padStart(9)}   range ${fmt(t.min === Infinity ? null : t.min)}..${fmt(
        t.max === -Infinity ? null : t.max,
      )}   changes ${t.changes}`;
    console.log(`CONFIRMED (changed while watching): ${live.length}`);
    for (const t of live) console.log(row(t));
    console.log(`\nPROBABLY REAL (non-zero but didn't change): ${nonzero.length}`);
    for (const t of nonzero) console.log(row(t));
    console.log(`\nUNKNOWN (always 0; may not exist, or wasn't touched): ${silent.length}`);
    console.log("  " + silent.map((t) => t.name).join(", "));

    const report = {
      generatedAt: new Date().toISOString(),
      sim: simName,
      aircraftTitle: title,
      testWrite: writeResult,
      variables: tracks.map((t) => ({
        name: t.name,
        group: t.group,
        verdict: t.changes > 0 ? "confirmed" : t.value ? "probably-real" : "unknown",
        first: t.first,
        last: t.value,
        min: t.min === Infinity ? null : t.min,
        max: t.max === -Infinity ? null : t.max,
        changes: t.changes,
      })),
    };
    const file = join(process.env.INIT_CWD ?? process.cwd(), `fenix-report-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
    try {
      writeFileSync(file, JSON.stringify(report, null, 2));
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

  if (args.testWrite) {
    const name = args.testWrite;
    const target = tracks.find((t) => t.name === name)!;
    handle.addToDataDefinition(DEF_WRITE, `L:${name}`, "number", SimConnectDataType.FLOAT64);
    const write = (v: number) => {
      const b = new RawBuffer(8);
      b.writeFloat64(v);
      handle.setDataOnSimObject(DEF_WRITE, SimConnectConstants.OBJECT_ID_USER, { buffer: b, arrayCount: 0, tagged: false });
    };
    await sleep(2000);
    const before = target.value ?? 0;
    const snapshot = new Map(tracks.map((t) => [t.name, t.changes]));
    console.log(`\nTEST WRITE: L:${name} ${fmt(before)} -> ${fmt(before + args.delta)} (watch the cockpit)`);
    write(before + args.delta);
    await sleep(2000);
    const moved = tracks.filter((t) => t.name !== name && t.changes > (snapshot.get(t.name) ?? 0)).map((t) => t.name);
    console.log(`TEST WRITE: restoring L:${name} to ${fmt(before)}`);
    write(before);
    await sleep(1000);
    writeResult = { variable: name, delta: args.delta, valueBefore: before, otherVariablesThatMoved: moved };
    console.log(
      moved.length
        ? `TEST WRITE: other variables reacted: ${moved.join(", ")}. Direct SimConnect writes work for this control.`
        : "TEST WRITE: nothing else reacted. Check whether the knob moved in the cockpit; if not, this control needs a different variable or the MobiFlight module.",
    );
    console.log("Keep operating controls, or press Ctrl+C to finish.\n");
  } else {
    console.log("\nOperate the FCU and EFIS in the cockpit: turn each knob a few clicks, push and pull each one,");
    console.log("press AP1/AP2/A-THR/LOC/APPR/EXPED. Changes print below. Press Ctrl+C when done.\n");
  }
}

main().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
