/**
 * Shows what VBuddy finds in the PMDG SDK headers installed on this PC, and which of its controls it could match.
 * Writes pmdg-sdk-report-<date>.json (names and numbers only, none of PMDG's text) that can be sent back to improve the matching.
 *
 *   pnpm pmdg:dump                     find the headers automatically
 *   pnpm pmdg:dump -- --dir "C:\path"  also look in this folder
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findSdkHeader } from "../pmdg/find-sdk.js";
import { PROFILES } from "../pmdg/profiles.js";
import { parseHeader } from "../pmdg/sdk.js";

const args = process.argv.slice(2);
const dirIdx = args.indexOf("--dir");
const dirs = [join(process.cwd(), "sdk"), fileURLToPath(new URL("../../../../sdk", import.meta.url)), ...(dirIdx >= 0 && args[dirIdx + 1] ? [args[dirIdx + 1]!] : [])];

const INTERESTING = /^EVT_(MCP|OH_.*(LIGHT|LTS|LAND|TAXI|STROBE|POS|LOGO|WING|BEACON|ANT|TURN)|.*(LIGHT|LTS))/;
const FIELD_INTERESTING = /^(MCP_|LTS_|.*(Light|Lt)Sw)/i;

const report: Record<string, unknown> = { generatedAt: new Date().toISOString() };
for (const p of PROFILES) {
  const found = findSdkHeader(p.headerFile, dirs.slice(0, 2).concat(dirs.slice(2)));
  if (!found) {
    console.log(`${p.label}: ${p.headerFile} NOT FOUND`);
    report[p.kind] = { found: false };
    continue;
  }
  const sdk = parseHeader(found.text, p.struct);
  console.log(`${p.label}: ${found.path}`);
  console.log(`  events: ${sdk.events.size}, mouse flags: ${sdk.mouse.size}, data: ${sdk.layout ? sdk.layout.size + " bytes, " + sdk.layout.fields.size + " fields" : "layout failed: " + sdk.layoutError}`);
  console.log(`  data area "${sdk.dataName ?? "(not in header)"}", control area "${sdk.controlName ?? "(not in header)"}"`);
  const events = [...sdk.events].filter(([n]) => INTERESTING.test(n)).sort((a, b) => a[1] - b[1]);
  const fields = sdk.layout ? [...sdk.layout.fields.values()].filter((f) => FIELD_INTERESTING.test(f.name)) : [];
  console.log(`  interesting events: ${events.length}, fields: ${fields.length}`);
  report[p.kind] = {
    found: true,
    path: found.path,
    eventCount: sdk.events.size,
    mouseFlags: Object.fromEntries(sdk.mouse),
    dataName: sdk.dataName,
    controlName: sdk.controlName,
    layoutSize: sdk.layout?.size ?? null,
    layoutError: sdk.layoutError,
    events: Object.fromEntries(events),
    fields: fields.map((f) => ({ name: f.name, offset: f.offset, size: f.size, float: f.float, signed: f.signed, dims: f.dims })),
  };
}
const file = `pmdg-sdk-report-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.json`;
writeFileSync(file, JSON.stringify(report, null, 1));
console.log(`\nWrote ${file}`);
