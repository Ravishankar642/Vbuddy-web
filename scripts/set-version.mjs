#!/usr/bin/env node
/** Sets the release version everywhere it lives: pnpm version:set 1.1.0 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? "")) {
  console.error("Usage: pnpm version:set 1.1.0");
  process.exit(2);
}
for (const f of ["package.json", "packages/bridge/package.json", "packages/web/package.json", "packages/protocol/package.json", "packages/relay/package.json"]) {
  const p = join(root, f);
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    j.version = v;
    writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
  } catch {
    /* package not present */
  }
}
writeFileSync(join(root, "packages/bridge/src/version.ts"), `export const VERSION = "${v}";\n`);
console.log(`Version set to ${v}. Add a "## ${v}" section at the top of CHANGELOG.md, then: pnpm package:both && pnpm release:publish`);
