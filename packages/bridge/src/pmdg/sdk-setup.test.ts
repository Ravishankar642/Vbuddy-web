import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKUP_SUFFIX, enableBroadcast, ensureIniKeys, installHeaders, setupPmdgSdk } from "./sdk-setup.js";

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "vbuddy-pmdg-"));
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}
function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("an [SDK] section is added with the broadcast lines, keeping the file's CRLF endings", () => {
  const { text, added } = ensureIniKeys("[ADIRU]\r\nLastPosValid=0\r\n", "SDK", ["EnableDataBroadcast", "EnableCDUBroadcast.0"]);
  assert.equal(text, "[ADIRU]\r\nLastPosValid=0\r\n\r\n[SDK]\r\nEnableDataBroadcast=1\r\nEnableCDUBroadcast.0=1\r\n");
  assert.deepEqual(added, ["EnableDataBroadcast", "EnableCDUBroadcast.0"]);
});

test("an existing [SDK] section gets only what's missing, and a 0 is switched to 1", () => {
  const before = "[sdk]\nEnableDataBroadcast = 0\n\n[OTHER]\nX=2\n";
  const { text, added } = ensureIniKeys(before, "SDK", ["EnableDataBroadcast", "EnableCDUBroadcast.0"]);
  assert.equal(text, "[sdk]\nEnableDataBroadcast=1\nEnableCDUBroadcast.0=1\n\n[OTHER]\nX=2\n");
  assert.deepEqual(added, ["EnableDataBroadcast", "EnableCDUBroadcast.0"]);
  assert.deepEqual(ensureIniKeys(text, "SDK", ["EnableDataBroadcast", "EnableCDUBroadcast.0"]).added, []);
});

test("an empty file becomes just the [SDK] section", () => {
  assert.equal(ensureIniKeys("", "SDK", ["EnableDataBroadcast"]).text, "[SDK]\r\nEnableDataBroadcast=1\r\n");
});

test("each PMDG options .ini gets its lines (777 has three CDUs), with a backup, and a second run changes nothing", () => {
  const { d, done } = tmp();
  try {
    const root = join(d, "WASM", "MSFS2024");
    put(join(root, "pmdg-aircraft-77w", "work", "777_Options.ini"), "[ADIRU]\r\nLastPosValid=0\r\n");
    put(join(root, "pmdg-aircraft-738", "work", "737_Options.ini"), "[SDK]\r\nEnableDataBroadcast=1\r\n");
    mkdirSync(join(root, "pmdg-aircraft-736", "work"), { recursive: true }); // flown, but no options file yet
    mkdirSync(join(root, "pmdg-aircraft-739"), { recursive: true }); // never flown: left alone
    put(join(root, "inibuilds-aircraft-a350", "work", "x.ini"), "");

    const r = enableBroadcast([root]);
    assert.deepEqual(r.errors, []);
    const by = (pkg: string) => r.inis.find((i) => i.path.includes(pkg));
    assert.equal(by("77w")?.action, "enabled");
    assert.deepEqual(by("77w")?.added, ["EnableDataBroadcast", "EnableCDUBroadcast.0", "EnableCDUBroadcast.1", "EnableCDUBroadcast.2"]);
    assert.equal(by("738")?.action, "enabled");
    assert.deepEqual(by("738")?.added, ["EnableCDUBroadcast.0", "EnableCDUBroadcast.1"]);
    assert.equal(by("736")?.action, "created");
    assert.equal(by("739"), undefined);
    assert.equal(r.inis.length, 3);

    const ini777 = join(root, "pmdg-aircraft-77w", "work", "777_Options.ini");
    assert.match(readFileSync(ini777, "latin1"), /\[SDK\]\r\nEnableDataBroadcast=1\r\nEnableCDUBroadcast\.0=1\r\nEnableCDUBroadcast\.1=1\r\nEnableCDUBroadcast\.2=1\r\n$/);
    assert.equal(readFileSync(ini777 + BACKUP_SUFFIX, "latin1"), "[ADIRU]\r\nLastPosValid=0\r\n");
    assert.equal(existsSync(join(root, "pmdg-aircraft-736", "work", "737_Options.ini" + BACKUP_SUFFIX)), false);

    // PMDG recreates the file without the lines: they go back in, and the first backup is kept
    writeFileSync(ini777, "[ADIRU]\r\nLastPosValid=1\r\n");
    assert.equal(enableBroadcast([root]).inis.find((i) => i.path === ini777)?.action, "enabled");
    assert.equal(readFileSync(ini777 + BACKUP_SUFFIX, "latin1"), "[ADIRU]\r\nLastPosValid=0\r\n");

    assert.ok(enableBroadcast([root]).inis.every((i) => i.action === "current"));
  } finally {
    done();
  }
});

test("the headers are copied from the aircraft packages (also through a linked Community folder), and refreshed when the aircraft's copy changes", () => {
  const { d, done } = tmp();
  try {
    const realCommunity = join(d, "D-drive", "Community");
    put(join(realCommunity, "pmdg-aircraft-77w", "Documentation", "SDK", "PMDG_777X_SDK.h"), "// 777 v1");
    put(join(realCommunity, "pmdg-aircraft-738", "Documentation", "SDK", "PMDG_NG3_SDK.h"), "// 737");
    const packages = join(d, "Packages");
    mkdirSync(packages, { recursive: true });
    symlinkSync(realCommunity, join(packages, "Community"), "junction");
    put(join(packages, "Official2024", "OneStore", "asobo-aircraft-a320", "x.txt"), "");
    const data = join(d, "VBuddy");

    let r = installHeaders(data, [packages]);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.headers.map((h) => [h.file, h.action]).sort(), [["PMDG_777X_SDK.h", "installed"], ["PMDG_NG3_SDK.h", "installed"]]);
    assert.equal(readFileSync(join(data, "sdk", "PMDG_777X_SDK.h"), "utf8"), "// 777 v1");

    r = installHeaders(data, [packages]);
    assert.ok(r.headers.every((h) => h.action === "current"));

    // an aircraft update ships a new header: the copy follows, the old one is kept as .old
    const h777 = join(realCommunity, "pmdg-aircraft-77w", "Documentation", "SDK", "PMDG_777X_SDK.h");
    writeFileSync(h777, "// 777 v2");
    const later = new Date(Date.now() + 60_000);
    utimesSync(h777, later, later);
    r = installHeaders(data, [packages]);
    assert.equal(r.headers.find((h) => h.kind === "777x")?.action, "updated");
    assert.equal(readFileSync(join(data, "sdk", "PMDG_777X_SDK.h"), "utf8"), "// 777 v2");
    assert.equal(readFileSync(join(data, "sdk", "PMDG_777X_SDK.h.old"), "utf8"), "// 777 v1");
  } finally {
    done();
  }
});

test("no PMDG aircraft installed: nothing is copied or written, and nothing fails", () => {
  const { d, done } = tmp();
  try {
    const r = setupPmdgSdk({ dataDir: join(d, "VBuddy"), packageRoots: [join(d, "nope")], workRoots: [join(d, "nope")] });
    assert.deepEqual(r, { headers: [], inis: [], errors: [] });
    assert.equal(existsSync(join(d, "VBuddy")), false);
  } finally {
    done();
  }
});
